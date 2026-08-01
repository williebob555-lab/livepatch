// Dedicated Win32 UI thread for VST3 plugin editors.
//
// Why: plugin GUIs need a pumped message loop and node's event loop doesn't
// pump Win32 messages — and the engine's JS thread is also the audio pump, so
// GUI work must never run there. One shared thread hosts every editor window.
//
// Capture model ("the block face IS the plugin"): the editor attaches to a
// DWM-cloaked top-level window — composed by the OS but invisible — and a UI
// -thread timer blits it with PrintWindow(PW_RENDERFULLCONTENT) into a shared
// -memory frame (double-buffer + sequence counter). Electron reads the mapping
// by name and paints it onto the block face. Pixel-identical to the real GUI
// because it IS the real GUI. Popup mode uncloaks the same window for direct
// interaction.
//
// Thread contract:
// - JS/audio thread → UI thread: commands (open/close/input) go through a
//   short critical section (never called from the render path); param syncs
//   (CV/MIDI automation → plugin GUI) go through a lock-free SPSC ring.
// - UI thread → JS/audio thread: performEdit lands in another SPSC ring,
//   drained in process(). The audio path never takes a lock.
#pragma once

#include <windows.h>

#include <atomic>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>

#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"

namespace lp {

class VstInstance;

// Fixed-size single-producer/single-consumer ring of {pid, value} pairs.
struct ParamRing {
  static constexpr uint32_t N = 2048; // power of two
  struct Entry { uint32_t pid; double value; };
  Entry buf[N];
  std::atomic<uint32_t> head{0}; // write index (producer)
  std::atomic<uint32_t> tail{0}; // read index (consumer)

  bool push(uint32_t pid, double v) {
    const uint32_t h = head.load(std::memory_order_relaxed);
    const uint32_t t = tail.load(std::memory_order_acquire);
    if (h - t >= N) return false; // full — drop (bounded by design)
    buf[h & (N - 1)] = {pid, v};
    head.store(h + 1, std::memory_order_release);
    return true;
  }
  bool pop(Entry& out) {
    const uint32_t t = tail.load(std::memory_order_relaxed);
    if (t == head.load(std::memory_order_acquire)) return false;
    out = buf[t & (N - 1)];
    tail.store(t + 1, std::memory_order_release);
    return true;
  }
};

// Shared-memory frame layout: header + BGRA pixels (top-down).
struct FrameHeader {
  uint32_t magic;   // 'LPVF'
  uint32_t seq;     // incremented after each full frame write
  uint32_t width;
  uint32_t height;
  uint32_t stride;  // bytes per row
};
constexpr uint32_t FRAME_MAGIC = 0x4C505646; // 'LPVF'
constexpr int32_t MAX_UI_W = 2560;
constexpr int32_t MAX_UI_H = 1600;

struct UiInput {
  enum Type : uint32_t { MouseMove, MouseDown, MouseUp, Wheel, DoubleClick };
  Type type;
  int32_t x, y;
  int32_t button; // 0 left, 1 right, 2 middle
  int32_t wheel;  // signed detents * 120
};

// Per-instance editor state, owned by the UI thread after open.
class EditorHost;

class UiThread {
 public:
  static UiThread& instance();

  // All of these are called from the JS thread; they marshal to the UI thread.
  // mode: true = hidden capture window, false = visible popup.
  bool open(VstInstance* inst, Steinberg::Vst::IEditController* controller,
            bool capture, const std::string& shmName);
  void close(VstInstance* inst);
  void input(VstInstance* inst, const UiInput& ev);
  void setCaptureFps(VstInstance* inst, int fps);

  /**
   * Load + instantiate a plugin ON THE UI THREAD and block until done.
   *
   * Toolkit-backed plugin GUIs (Raum's is Qt 5.15) bind their objects to
   * whichever thread first initialized the toolkit and only paint if that
   * thread runs a message loop. Creating the plugin on a worker while its
   * window lived here left the child window correctly sized but permanently
   * blank. So construction happens on this pumped thread — exactly what a
   * DAW's main GUI thread does. Called from a uv worker, never the audio
   * thread (module load takes 100s of ms).
   */
  struct CreateJob {
    VstInstance* inst = nullptr;
    std::string path;
    std::string cid;
    bool ok = false;
    std::string err;
  };
  void createInstance(CreateJob& job);

  /** Tear a plugin down ON THE UI THREAD and block until done. Same toolkit
   *  rule as createInstance: Qt-backed plugins crash if their objects are
   *  released from a different thread than the one that made them.
   *
   *  **Never call this from the JS thread** — it is the audio pump, and the
   *  wait is up to 5 s. Use `destroyInstanceAsync`. */
  void destroyInstance(VstInstance* inst);

  /**
   * Hand an instance to the UI thread to tear down and delete, and return
   * immediately.
   *
   * `destroyInstance` blocked the caller for as long as the plugin took to
   * release (bounded at 5 s). That call sat on the JS thread — the audio pump —
   * so deleting a plugin block, or merely re-picking a plugin in the Properties
   * panel (which destroys the old instance), froze audio for as long as the
   * plugin's shutdown took. Ownership moves with the command, so nothing on the
   * JS side can reach the instance afterwards.
   */
  void destroyInstanceAsync(std::unique_ptr<VstInstance> inst);

  /**
   * Run `fn` on the UI thread; returns an event that is signalled when it has.
   *
   * **The post itself is cheap and non-blocking** (a mutex + deque push), so it
   * is safe to issue from the JS thread; the *wait* must happen on a uv worker.
   * That split is the whole point: the plugin's controller belongs to this
   * thread (threading rule 1, docs/13), and the calls that need it — parameter
   * enumeration, `getState`, `setState` — are exactly the slow ones. Running
   * them inline on the JS thread is what froze audio whenever a parameter
   * changed.
   *
   * Posting from the JS thread also keeps UI-thread work in JS call order, so a
   * destroy issued after a read can never overtake it.
   *
   * The caller owns the returned handle: pass it to `waitCall`.
   */
  HANDLE postCall(std::function<void()> fn);
  /** Wait for (and close) a `postCall` event. Call from a uv worker only. */
  static bool waitCall(HANDLE done, uint32_t ms);

  /**
   * The LivePatch app window (from Electron main, cross-process). New editor
   * windows are created OWNED by it, so they always z-order above LivePatch and
   * never fall behind when the app is clicked/raised. Owner (not SetParent) —
   * an owned top-level window shares no input queue and can't wedge Chromium.
   * Set once via the engine's config; 0 = no owner (a plain floating window).
   */
  void setOwner(HWND owner) { owner_.store(reinterpret_cast<uintptr_t>(owner)); }
  HWND owner() const { return reinterpret_cast<HWND>(owner_.load()); }
  /** Attach the editor as an OWNED top-level window riding above the app
   *  window at a client-area rect (clipped to `clip`, also client px).
   *  Deliberately NOT SetParent: re-parenting a foreign HWND into Chromium's
   *  hierarchy attaches input queues and wedges its compositor (observed:
   *  black app window, then process death). An owned window stays above the
   *  app with none of that. The plugin renders because it is genuinely
   *  visible — plugins pause GPU work when hidden, which is why hidden-window
   *  capture cannot animate (measured: exactly one black frame). */
  void embed(VstInstance* inst, HWND parent, int x, int y, int w, int h,
             int clipX, int clipY, int clipW, int clipH, bool visible);

 private:
  UiThread() = default;
  void ensureStarted();
  static DWORD WINAPI threadProc(LPVOID self);
  void pump();

  HANDLE thread_ = nullptr;
  DWORD threadId_ = 0;
  std::atomic<bool> running_{false};
  /** LivePatch window HWND (owner of editor windows). uintptr_t so it's a
   *  trivially-atomic pointer written from JS thread, read on the UI thread. */
  std::atomic<uintptr_t> owner_{0};

  struct Cmd {
    enum What { Open, Close, Input, Fps, Embed, CreateInst, DestroyInst, Call } what;
    CreateJob* job = nullptr;
    HANDLE doneEvent = nullptr;
    /** `Call`: the work to run here. `DestroyInst`: set when the command owns
     *  the instance (the async path) — destroying it is the last thing done. */
    std::function<void()> fn;
    std::unique_ptr<VstInstance> owned;
    VstInstance* inst;
    Steinberg::Vst::IEditController* controller;
    bool capture;
    std::string shmName;
    UiInput ev;
    int fps;
    HWND parent;
    int x, y, w, h;
    int clipX, clipY, clipW, clipH;
    bool visible;
  };
  std::mutex cmdMutex_;
  std::deque<Cmd> cmds_;
  void post(Cmd&& c);
  void drainCmds();

  friend class EditorHost;
};

}  // namespace lp
