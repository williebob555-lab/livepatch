// Standalone plugin-editor windows for the VST3 host.
//
// A plugin's IPlugView is a native child HWND. We host it in a plain top-level
// titled window on a dedicated pumped UI thread — the standard, reliable way
// to show a VST3 editor (mirrors the SDK's editorhost sample). Deliberately
// NOT embedded into the canvas / captured to pixels: plugins render with their
// own GPU context into a real visible window; anything else renders black.
//
// The engine's JS thread (== the audio pump) must never do window work, so all
// window ops are marshalled here via a command queue. Host automation (CV /
// MIDI) reaches the plugin GUI through a lock-free ring drained on this thread;
// GUI edits flow back through another ring drained in the audio process().
#include "uithread.h"

#include "host.h"
#include "public.sdk/source/vst/utility/stringconvert.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"

using namespace Steinberg;

namespace lp {

static const wchar_t* kWndClass = L"LivePatchVstEditorHost";
static const UINT kTimerSync = 1;
static const UINT kSyncMs = 30; // drain host→GUI param syncs ~33 Hz

static bool uiTrace() {
  static const bool on = GetEnvironmentVariableA("LPVST_UI_TRACE", nullptr, 0) > 0;
  return on;
}
#define UI_TRACE(...) do { if (uiTrace()) { fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); fflush(stderr); } } while (0)
// UI_ERR always prints — editor-open failures are user actions (not the audio
// path), and the engine forwards stderr to the app status bar, so a plugin
// whose editor won't open (e.g. Ozone) reports WHY instead of silently failing.
#define UI_ERR(...) do { fprintf(stderr, "[vst-ui] " __VA_ARGS__); fputc('\n', stderr); fflush(stderr); } while (0)

// ---------------------------------------------------------------- plug frame

// IPlugFrame: the plugin calls resizeView when its GUI wants a new size.
class PlugFrame : public IPlugFrame {
 public:
  explicit PlugFrame(HWND hwnd) : hwnd_(hwnd) { FUNKNOWN_CTOR }
  virtual ~PlugFrame() { FUNKNOWN_DTOR }
  DECLARE_FUNKNOWN_METHODS

  tresult PLUGIN_API resizeView(IPlugView* view, ViewRect* r) override {
    if (!view || !r) return kInvalidArgument;
    RECT wr{0, 0, r->getWidth(), r->getHeight()};
    const DWORD style = static_cast<DWORD>(GetWindowLongPtrW(hwnd_, GWL_STYLE));
    const DWORD ex = static_cast<DWORD>(GetWindowLongPtrW(hwnd_, GWL_EXSTYLE));
    AdjustWindowRectEx(&wr, style, FALSE, ex);
    SetWindowPos(hwnd_, nullptr, 0, 0, wr.right - wr.left, wr.bottom - wr.top,
                 SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOCOPYBITS);
    view->onSize(r);
    return kResultTrue;
  }

 private:
  HWND hwnd_;
};
IMPLEMENT_FUNKNOWN_METHODS(PlugFrame, IPlugFrame, IPlugFrame::iid)

// ---------------------------------------------------------------- EditorHost

class EditorHost;
// SEH guard (declared before use; defined after EditorHost). __try/__except
// cannot share a frame with C++ objects needing unwinding, so it only wraps a
// call into the real body.
static bool guardedRelease(EditorHost* host);

class EditorHost {
 public:
  VstInstance* inst = nullptr;
  Vst::IEditController* controller = nullptr;
  IPlugView* view = nullptr;
  PlugFrame* frame = nullptr;
  HWND hwnd = nullptr;
  int width = 0, height = 0;
  bool visible = false;

  ~EditorHost() { destroy(); }

  float dpiScale() const {
    // GetDpiForWindow is Win10+; the target is Win11.
    const UINT dpi = GetDpiForWindow(hwnd);
    return dpi ? float(dpi) / 96.f : 1.f;
  }

  bool create(int cascade) {
    const char* pname = inst ? inst->name().c_str() : "?";
    if (!controller) { UI_ERR("'%s': no edit controller — editor unavailable", pname); return false; }
    view = controller->createView(Vst::ViewType::kEditor);
    UI_TRACE("[vst-ui] createView -> %p", (void*)view);
    if (!view) { UI_ERR("'%s': plugin returned no editor view (createView null)", pname); return false; }
    if (view->isPlatformTypeSupported(kPlatformTypeHWND) != kResultTrue) {
      UI_ERR("'%s': editor does not support an HWND window", pname);
      view->release();
      view = nullptr;
      return false;
    }

    ViewRect rect{};
    view->getSize(&rect);
    width = rect.getWidth() > 0 ? rect.getWidth() : 720;
    height = rect.getHeight() > 0 ? rect.getHeight() : 450;

    const DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX |
                        WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
    const DWORD ex = WS_EX_APPWINDOW;
    RECT wr{0, 0, width, height};
    AdjustWindowRectEx(&wr, style, FALSE, ex);

    const int x = 140 + (cascade % 6) * 36;
    const int y = 100 + (cascade % 6) * 36;
    // u16string → wstring (same code units on Windows, distinct types).
    const auto u16 = VST3::StringConvert::convert(inst->name());
    std::wstring title(u16.begin(), u16.end());
    if (title.empty()) title = L"Plugin";
    // OWNED by the LivePatch window (cross-process): an owned top-level window
    // always z-orders above its owner, so clicking/raising LivePatch can never
    // bury the editor. Owner (not SetParent) attaches no input queue. 0 = a
    // plain floating window (owner not yet provided).
    const HWND owner = UiThread::instance().owner();
    hwnd = CreateWindowExW(ex, kWndClass, title.c_str(), style, x, y,
                           wr.right - wr.left, wr.bottom - wr.top, owner,
                           nullptr, GetModuleHandleW(nullptr), this);
    if (!hwnd) { UI_ERR("'%s': CreateWindowEx failed (err %lu)", pname, GetLastError()); return false; }

    // Content scale BEFORE attach (some GUIs render at the wrong size / black
    // otherwise on HiDPI). Best effort.
    if (auto* css = FUnknownPtr<IPlugViewContentScaleSupport>(view).getInterface())
      css->setContentScaleFactor(dpiScale());

    frame = new PlugFrame(hwnd);
    view->setFrame(frame);
    const tresult att = view->attached(hwnd, kPlatformTypeHWND);
    if (att != kResultTrue) {
      UI_ERR("'%s': editor attach() failed (0x%x)", pname, att);
      destroy();
      return false;
    }

    // Honor the size the plugin actually wants after attach.
    if (view->getSize(&rect) == kResultTrue && rect.getWidth() > 0) {
      width = rect.getWidth();
      height = rect.getHeight();
      RECT wr2{0, 0, width, height};
      AdjustWindowRectEx(&wr2, style, FALSE, ex);
      SetWindowPos(hwnd, nullptr, 0, 0, wr2.right - wr2.left, wr2.bottom - wr2.top,
                   SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    }
    // Tell the view its size — the host's documented job, and what makes
    // toolkit-backed views (Qt, JUCE) lay out and paint. Without it the child
    // window exists at the right size but renders blank.
    syncViewSize();

    ShowWindow(hwnd, SW_SHOW);
    SetForegroundWindow(hwnd);
    SetTimer(hwnd, kTimerSync, kSyncMs, nullptr);
    visible = true;
    inst->setUiState(width, height, true);
    inst->setUiPopup(true);
    UI_TRACE("[vst-ui] editor shown hwnd=%p %dx%d", (void*)hwnd, width, height);
    return true;
  }

  /** Push the window's client size into the view (WM_SIZE + after attach). */
  void syncViewSize() {
    if (!view || !hwnd) return;
    RECT rc{};
    GetClientRect(hwnd, &rc);
    if (rc.right <= 0 || rc.bottom <= 0) return;
    ViewRect vr{0, 0, rc.right, rc.bottom};
    view->onSize(&vr);
  }

  void show() {
    if (!hwnd) return;
    ShowWindow(hwnd, SW_SHOW);
    SetForegroundWindow(hwnd);
    visible = true;
    inst->setUiState(width, height, true);
  }

  /**
   * Hide, never tear down. Closing a plugin editor runs its whole GUI toolkit
   * down and some plugins (Raum's Qt) fault on their own threads doing it —
   * unfixable from here and uncatchable by SEH. Since an editor costs nothing
   * while hidden, close == hide and the view stays attached: re-opening is
   * instant and can never crash.
   */
  void hide() {
    if (!hwnd) return;
    ShowWindow(hwnd, SW_HIDE);
    visible = false;
    inst->setUiState(width, height, false);
  }

  // User clicked the window's close box.
  void onUserClose() {
    hide();
    inst->requestUiClose(); // kernel clears its "wants UI" flag to match
  }

  void drainParamSyncs() {
    if (!controller) return;
    ParamRing::Entry e;
    int budget = 256;
    auto* ring = inst->uiParamRing();
    while (budget-- > 0 && ring->pop(e)) controller->setParamNormalized(e.pid, e.value);
  }

  // The view half of teardown — the crash-prone part (a plugin's editor
  // shutdown runs its whole GUI toolkit down). Only called via the SEH guard.
  void releaseViewUnsafe() {
    // SDK teardown order: unset frame, removed(), then release.
    if (view) {
      view->setFrame(nullptr);
      view->removed();
      view->release();
      view = nullptr;
    }
    if (frame) {
      frame->release();
      frame = nullptr;
    }
  }

  void destroy() {
    if (hwnd) KillTimer(hwnd, kTimerSync);
    if (!guardedRelease(this)) {
      UI_TRACE("[vst-ui] plugin FAULTED closing its editor — leaked, host survives");
      view = nullptr; // abandon without touching the plugin again
      frame = nullptr;
    }
    // Let the plugin's toolkit finish its own shutdown before the window goes
    // away: Qt (and friends) post deferred-delete events during removed() and
    // fault if the HWND vanishes before they run.
    pumpBriefly(120);
    if (hwnd) {
      DestroyWindow(hwnd);
      hwnd = nullptr;
    }
    pumpBriefly(60); // and let WM_DESTROY fallout settle
  }

  static void pumpBriefly(DWORD ms) {
    const DWORD until = GetTickCount() + ms;
    MSG m;
    for (;;) {
      while (PeekMessageW(&m, nullptr, 0, 0, PM_REMOVE)) {
        TranslateMessage(&m);
        DispatchMessageW(&m);
      }
      if (GetTickCount() >= until) break;
      MsgWaitForMultipleObjectsEx(0, nullptr, 10, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
    }
  }
};

static bool guardedRelease(EditorHost* host) {
  __try {
    host->releaseViewUnsafe();
    return true;
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    return false;
  }
}

static std::unordered_map<VstInstance*, EditorHost*>& editors() {
  static std::unordered_map<VstInstance*, EditorHost*> map;
  return map;
}

static LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  auto* host = reinterpret_cast<EditorHost*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
  switch (msg) {
    case WM_NCCREATE: {
      auto* cs = reinterpret_cast<CREATESTRUCTW*>(lp);
      SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
      return TRUE;
    }
    case WM_ERASEBKGND:
      return 1; // the plugin paints its whole client area
    case WM_PAINT: {
      PAINTSTRUCT ps{};
      BeginPaint(hwnd, &ps);
      EndPaint(hwnd, &ps);
      return 0;
    }
    case WM_SIZE:
      if (host) host->syncViewSize();
      return 0;
    case WM_TIMER:
      if (host && wp == kTimerSync) host->drainParamSyncs();
      return 0;
    case WM_CLOSE:
      if (host) host->onUserClose();
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

// ------------------------------------------------------------------ UiThread

UiThread& UiThread::instance() {
  static UiThread t;
  return t;
}

void UiThread::ensureStarted() {
  if (running_.exchange(true)) return;
  thread_ = CreateThread(nullptr, 0, threadProc, this, 0, &threadId_);
}

DWORD WINAPI UiThread::threadProc(LPVOID self) {
  OleInitialize(nullptr); // plugin GUIs expect an OLE STA (drag-drop, etc.)
  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.style = CS_DBLCLKS;
  wc.lpfnWndProc = wndProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = kWndClass;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = nullptr; // no host erase — the plugin owns its pixels
  RegisterClassExW(&wc);
  static_cast<UiThread*>(self)->pump();
  return 0;
}

void UiThread::pump() {
  UI_TRACE("[vst-ui] pump started tid=%lu", GetCurrentThreadId());
  MSG msg;
  for (;;) {
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
    drainCmds();
    MsgWaitForMultipleObjectsEx(0, nullptr, 20, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
  }
}

void UiThread::post(Cmd&& c) {
  ensureStarted();
  {
    std::lock_guard<std::mutex> lock(cmdMutex_);
    cmds_.push_back(std::move(c));
  }
  if (threadId_) PostThreadMessageW(threadId_, WM_NULL, 0, 0);
}

void UiThread::drainCmds() {
  static int cascade = 0;
  for (;;) {
    Cmd c;
    {
      std::lock_guard<std::mutex> lock(cmdMutex_);
      if (cmds_.empty()) return;
      c = std::move(cmds_.front());
      cmds_.pop_front();
    }
    auto& map = editors();
    switch (c.what) {
      case Cmd::Open: {
        if (!c.inst->uiWantedNow()) { // a Close raced ahead of this Open
          c.inst->setUiState(0, 0, false);
          break;
        }
        auto it = map.find(c.inst);
        if (it != map.end()) {
          it->second->show(); // already created — just re-show
          break;
        }
        auto* host = new EditorHost();
        host->inst = c.inst;
        host->controller = c.controller;
        if (host->create(cascade++)) {
          map[c.inst] = host;
        } else {
          delete host;
          c.inst->setUiState(0, 0, false);
        }
        break;
      }
      case Cmd::Close: {
        // Hide only — see EditorHost::hide for why we never tear an editor down.
        auto it = map.find(c.inst);
        if (it != map.end()) it->second->hide();
        else c.inst->setUiState(0, 0, false);
        break;
      }
      case Cmd::CreateInst: {
        // Plugin construction on this thread so its GUI toolkit binds here.
        if (c.job) c.job->ok = c.job->inst->create(c.job->path, c.job->cid, c.job->err);
        if (c.doneEvent) SetEvent(c.doneEvent);
        break;
      }
      case Cmd::DestroyInst: {
        // Hide and ABANDON the editor (never delete → never release the view).
        // VstInstance::teardown() then leaks the plugin too if its GUI was
        // ever opened. Deliberate: a leaked instance beats a dead engine.
        auto it = map.find(c.inst);
        if (it != map.end()) {
          it->second->hide();
          map.erase(it); // intentionally not deleted
        }
        if (c.inst) c.inst->teardown();
        if (c.doneEvent) SetEvent(c.doneEvent);
        break;
      }
      case Cmd::Input:
      case Cmd::Fps:
      case Cmd::Embed:
        // Not used by the standalone-window path (kept for ABI stability).
        break;
    }
  }
}

void UiThread::createInstance(CreateJob& job) {
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  Cmd c{};
  c.what = Cmd::CreateInst;
  c.job = &job;
  c.doneEvent = done;
  post(std::move(c));
  // The caller is a uv worker thread; blocking here is fine and keeps the
  // audio/JS thread untouched.
  WaitForSingleObject(done, INFINITE);
  CloseHandle(done);
}

void UiThread::destroyInstance(VstInstance* inst) {
  if (!running_.load()) return; // never started — nothing was created here
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  Cmd c{};
  c.what = Cmd::DestroyInst;
  c.inst = inst;
  c.doneEvent = done;
  post(std::move(c));
  // Bounded: a wedged plugin GUI must not hang the engine forever.
  WaitForSingleObject(done, 5000);
  CloseHandle(done);
}

bool UiThread::open(VstInstance* inst, Vst::IEditController* controller,
                    bool /*capture*/, const std::string& /*shmName*/) {
  if (!controller) return false;
  Cmd c{};
  c.what = Cmd::Open;
  c.inst = inst;
  c.controller = controller;
  post(std::move(c));
  return true;
}

void UiThread::close(VstInstance* inst) {
  Cmd c{};
  c.what = Cmd::Close;
  c.inst = inst;
  post(std::move(c));
}

void UiThread::input(VstInstance*, const UiInput&) {}
void UiThread::setCaptureFps(VstInstance*, int) {}
void UiThread::embed(VstInstance*, HWND, int, int, int, int, int, int, int, int, bool) {}

}  // namespace lp
