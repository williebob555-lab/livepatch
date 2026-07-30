// LivePatch VST3 hosting core. One VstInstance per vst block. All methods are
// called from the engine's JS thread (which is also the audio pump), so there
// is no cross-thread synchronization here yet — the future GUI thread must
// communicate only through lock-free queues added at that point.
//
// Performance contract (mirrors engine/src/dsp.ts): after setup(), process()
// performs no heap allocation on our side. SDK queue objects retain capacity
// across calls; buffers are preallocated in setup().
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstmidicontrollers.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"

#include "uithread.h"

namespace lp {

struct ClassDesc {
  std::string cid;  // canonical hex UID string
  std::string name;
  std::string vendor;
  std::string version;
  std::string subCategories;
};

struct ParamDesc {
  uint32_t id;
  std::string title;
  std::string units;
  int32_t stepCount;
  double defaultNormalized;
  bool canAutomate;
  bool isReadOnly;
  bool isBypass;
  bool isHidden;
};

// IComponentHandler: receives edits initiated by the plugin (its own GUI or
// internal automation). performEdit may arrive on the UI thread once an editor
// is open, so edits land in a lock-free SPSC ring (UI producer → audio-thread
// consumer in process()); the audio path never takes a lock.
class ComponentHandler : public Steinberg::Vst::IComponentHandler {
 public:
  explicit ComponentHandler(ParamRing* ring) : ring_(ring) { FUNKNOWN_CTOR }
  virtual ~ComponentHandler() { FUNKNOWN_DTOR }
  DECLARE_FUNKNOWN_METHODS

  Steinberg::tresult PLUGIN_API beginEdit(Steinberg::Vst::ParamID) override {
    return Steinberg::kResultOk;
  }
  Steinberg::tresult PLUGIN_API performEdit(
      Steinberg::Vst::ParamID id, Steinberg::Vst::ParamValue value) override {
    ring_->push(id, value); // full ring drops — bounded by design
    return Steinberg::kResultOk;
  }
  Steinberg::tresult PLUGIN_API endEdit(Steinberg::Vst::ParamID) override {
    return Steinberg::kResultOk;
  }
  Steinberg::tresult PLUGIN_API restartComponent(Steinberg::int32 flags) override {
    restartFlags.fetch_or(flags, std::memory_order_relaxed);
    return Steinberg::kResultOk;
  }

  std::atomic<Steinberg::int32> restartFlags{0};

 private:
  ParamRing* ring_;
};

class VstInstance {
 public:
  ~VstInstance();

  // ---- lifecycle (setup path; may allocate) ----
  bool create(const std::string& path, const std::string& cid, std::string& err);
  /** Ask for `chans` channels on the main buses at the next (re)setup. 0 or 2 =
   *  the stereo default. Must be called BEFORE setup/resetup — bus
   *  arrangements can only be negotiated while the component is inactive. */
  void requestChannels(int32_t chans) { wantChans_ = chans; }
  bool setup(double sampleRate, int32_t maxBlock, std::string& err);
  // Re-run processing setup at a new rate/quantum (device reconfigure).
  bool resetup(double sampleRate, int32_t maxBlock, std::string& err);
  /** Release everything. MUST run on the UI thread (the creating thread) —
   *  Qt-backed plugins crash when released from another thread. Callers go
   *  through UiThread::destroyInstance; never call this directly.
   *  SEH-guarded: a plugin that faults while shutting down is leaked, not
   *  allowed to take the engine process down with it. */
  void teardown();

  // ---- info ----
  std::vector<ParamDesc> params() const;
  double getParamNormalized(uint32_t pid) const;
  std::string paramDisplay(uint32_t pid, double normalized) const;
  uint32_t latencySamples() const { return latency_; }
  bool hasAudioIn() const { return mainInBus_ >= 0; }
  /** Channels the plugin actually accepted on its main buses after
   *  `setBusArrangements` negotiation — NOT what we asked for. A plugin may
   *  refuse a wide arrangement and stay stereo, and the kernel has to know
   *  that to avoid feeding channels nowhere (docs/13). */
  int32_t mainInChannels() const { return inChans_; }
  int32_t mainOutChannels() const { return outChans_; }
  const std::string& name() const { return name_; }
  bool paramsDirty();   // true once after the plugin asked for a param re-scan

  // ---- live path (no allocation after warmup) ----
  void setParamNormalized(uint32_t pid, double value);  // host automation/CV
  void midi(uint8_t status, uint8_t d1, uint8_t d2);
  void process(const float* inL, const float* inR, float* outL, float* outR,
               int32_t n);
  /**
   * Multichannel process: `ins`/`outs` are arrays of `nIn`/`nOut` channel
   * pointers, mapped 1:1 onto the plugin's main buses.
   *
   * Channels the plugin does not have are dropped on the way in and left
   * untouched on the way out — the same truncation rule the rest of the app
   * uses (docs/02), never an implicit fold. Unlike the stereo `process`, this
   * does NOT duplicate channel 0 into the rest on a mono plugin; a caller that
   * wants a fold asks for it explicitly.
   */
  void processMulti(const float* const* ins, int32_t nIn, float* const* outs,
                    int32_t nOut, int32_t n);
  // Drains plugin-initiated edits (its GUI, internal automation) as
  // [pid, value, pid, value, ...]; returns count of pairs.
  size_t takeGuiEdits(const float** ids, const float** values);

  // ---- state ----
  std::vector<uint8_t> getState(bool& ok) const;
  bool setState(const uint8_t* data, size_t len);

  // ---- plugin GUI (marshalled to the shared UI thread) ----
  struct UiState {
    bool open;
    bool popup;
    int width;
    int height;
    std::string shm;
    uint32_t frames;  // capture counter (diagnostics)
    int capErr;       // last capture failure stage, 0 = ok
  };
  /** Open (or re-mode) the editor. popup=false → cloaked capture window whose
   *  frames land in shared memory; popup=true → visible interactive window. */
  bool openUi(bool popup);
  void closeUi(bool wait);
  UiState uiState() const;
  void postUiInput(const UiInput& ev);
  /** Attach/reposition the editor over a foreign window (see UiThread::embed). */
  void embedUi(uintptr_t parentHwnd, int x, int y, int w, int h, int clipX,
               int clipY, int clipW, int clipH, bool visible);

  // UI-thread callbacks / accessors (see uithread.cc).
  void setUiState(int w, int h, bool open) {
    uiW_.store(w);
    uiH_.store(h);
    uiOpen_.store(open);
    uiHostAlive_.store(open);
  }
  void setUiPopup(bool popup) { uiPopup_.store(popup); }
  ParamRing* uiParamRing() { return &paramsToUi_; }
  /** Close-vs-open race guard: an Open command queued before a Close must not
   *  create an orphan editor (observed as a leaked invisible window). */
  bool uiWantedNow() const { return uiWanted_.load(); }
  /** UI thread: user clicked the window's close box. Kernel reads this to
   *  flip the block's showUi param off so the two stay in sync. */
  void requestUiClose() { uiUserClosed_.store(true); }
  bool takeUiUserClosed() { return uiUserClosed_.exchange(false); }
  void noteUiFrame() { uiFrames_.fetch_add(1, std::memory_order_relaxed); }
  void noteUiCapErr(int stage) { uiCapErr_.store(stage, std::memory_order_relaxed); }

 private:
  /** The real teardown body; only ever called through the SEH guard. */
  void teardownUnsafe();
  void queueParam(uint32_t pid, double value);
  /** Reflect host automation into the plugin GUI (ring when UI open). */
  void syncToController(uint32_t pid, double value);

  VST3::Hosting::Module::Ptr module_;
  Steinberg::IPtr<Steinberg::Vst::PlugProvider> provider_;
  Steinberg::Vst::IComponent* component_ = nullptr;       // owned by provider
  Steinberg::Vst::IEditController* controller_ = nullptr; // owned by provider
  Steinberg::IPtr<Steinberg::Vst::IAudioProcessor> processor_;
  Steinberg::IPtr<Steinberg::Vst::IMidiMapping> midiMapping_;
  Steinberg::IPtr<ComponentHandler> handler_;

  Steinberg::Vst::HostProcessData data_;
  Steinberg::Vst::ParameterChanges inChanges_;
  Steinberg::Vst::ParameterChanges outChanges_;
  Steinberg::Vst::EventList inEvents_;
  Steinberg::Vst::EventList outEvents_;
  Steinberg::Vst::ProcessContext ctx_ = {};

  std::string name_;
  double sampleRate_ = 48000.0;
  int32_t maxBlock_ = 0;
  /** Shared pre/post around `processor_->process` — see host.cc. Both the
   *  stereo and multichannel entries go through these so the edit-forwarding
   *  and queue bookkeeping cannot drift between them. */
  void beginProcess(int32_t n);
  void endProcess(int32_t n);
  /** Negotiate main-bus widths + locate main buses. Component must be inactive.
   *  Shared by setup() and resetup() so the two cannot disagree about width. */
  bool negotiateBuses(std::string& err);

  int32_t mainInBus_ = -1;
  int32_t mainOutBus_ = -1;
  int32_t inChans_ = 0;   // negotiated channel count on the main input bus
  int32_t outChans_ = 0;  // ...and the main output bus
  /** Buffers for plugin bus channels the host isn't driving: `silence_` feeds
   *  unconnected plugin inputs (a plugin may read a channel we don't have),
   *  `scratch_` catches plugin outputs we have nowhere to put. Sized at
   *  maxBlock in setup so `processMulti` allocates nothing. */
  std::vector<float> silence_;
  std::vector<float> scratch_;
  /** Channels the host would like on the main buses (0 = stereo default).
   *  Set before setup/resetup; the plugin may refuse and keep its own. */
  int32_t wantChans_ = 0;
  bool hasEventIn_ = false;
  uint32_t latency_ = 0;
  bool active_ = false;
  int64_t samplePos_ = 0;

  // Reusable drain buffers for takeGuiEdits (preallocated in setup).
  std::vector<float> editIds_;
  std::vector<float> editValues_;

  // ---- GUI plumbing ----
  ParamRing editsFromUi_;  // plugin GUI → audio thread (drained in process)
  ParamRing paramsToUi_;   // host automation → plugin GUI (drained on UI thread)
  std::atomic<bool> uiOpen_{false};
  std::atomic<bool> uiPopup_{false};
  std::atomic<bool> uiHostAlive_{false};
  std::atomic<bool> uiWanted_{false};
  std::atomic<bool> uiUserClosed_{false};
  bool tornDown_ = false;
  /** Once a plugin's editor has existed, we never release the plugin. */
  bool editorEverOpened_ = false;
  std::atomic<int> uiW_{0};
  std::atomic<int> uiH_{0};
  std::atomic<uint32_t> uiFrames_{0};
  std::atomic<int> uiCapErr_{0};
  std::string shmName_;
};

// Loads (and caches) a module, returns its audio-effect classes.
bool moduleClasses(const std::string& path, std::vector<ClassDesc>& out,
                   std::string& err);

// Instance registry used by the N-API layer. Adoption/lookup/destroy happen on
// the JS main thread only; creation itself may run on a worker thread.
int32_t instanceCreate(const std::string& path, const std::string& cid,
                       std::string& err);
int32_t instanceAdopt(std::unique_ptr<VstInstance> inst);
VstInstance* instanceGet(int32_t handle);
void instanceDestroy(int32_t handle);

}  // namespace lp
