// Standalone plugin-editor windows for the VST3 host — Linux (X11).
//
// The Linux twin of uithread_win.cc; read that file first, the model is the
// same: one dedicated UI thread constructs plugins, owns their controllers and
// hosts every editor as a plain top-level window. What differs:
//
// * VST3 on Linux has no system event loop, so the HOST provides one: plugins
//   register file descriptors and timers through Linux::IRunLoop, which they
//   find on the IPlugFrame (editors) or the host context (everything else).
//   This thread's poll() loop is that run loop. Toolkit-backed GUIs (JUCE,
//   VSTGUI, Qt) paint ONLY from those callbacks — a host without a run loop
//   gets a correctly sized, permanently blank editor.
// * Editors are X11 clients (kPlatformTypeX11EmbedWindowID — there is no
//   Wayland editor type). On KDE Plasma's Wayland session they run through
//   XWayland, which Fedora KDE ships enabled. No X display at all (headless,
//   XWayland disabled) costs editors only; construction, parameters and state
//   all still work, because none of that touches X.
// * Completion events are ref-counted (mutex + condvar): a waiter that times
//   out drops its reference and the UI thread signals the survivor later.
// * No SEH. A plugin that faults in removed()/release() takes the engine down;
//   the engine is a child process and Electron restarts it (throttled). The
//   hide-never-destroy rule below keeps that path rare, exactly as on Windows.
#include "uithread.h"

#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <poll.h>
#include <sys/eventfd.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <unordered_map>
#include <vector>

#include "host.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"

using namespace Steinberg;

namespace lp {

static const uint32_t kSyncMs = 30; // drain host→GUI param syncs ~33 Hz
static const int kIdleMs = 20;      // longest poll() sleep with nothing due

static bool uiTrace() {
  static const bool on = std::getenv("LPVST_UI_TRACE") != nullptr;
  return on;
}
#define UI_TRACE(...) do { if (uiTrace()) { fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); fflush(stderr); } } while (0)
// UI_ERR always prints — see uithread_win.cc (editor-open failures are user
// actions, and the engine forwards stderr to the app status bar).
#define UI_ERR(...) do { fprintf(stderr, "[vst-ui] " __VA_ARGS__); fputc('\n', stderr); fflush(stderr); } while (0)

using Clock = std::chrono::steady_clock;

// ------------------------------------------------------------ completion event

struct Event {
  std::mutex m;
  std::condition_variable cv;
  bool set = false;
};
using EventRef = std::shared_ptr<Event>;

static HANDLE newEvent() { return new EventRef(std::make_shared<Event>()); }
/** A second reference to the same event (one for the waiter, one for the Cmd). */
static HANDLE dupEvent(HANDLE h) { return new EventRef(*static_cast<EventRef*>(h)); }
static void signalAndRelease(HANDLE h) {
  auto* r = static_cast<EventRef*>(h);
  {
    std::lock_guard<std::mutex> lock((*r)->m);
    (*r)->set = true;
  }
  (*r)->cv.notify_all();
  delete r;
}
/** Wait (ms = UINT32_MAX → forever), then drop the caller's reference. */
static bool waitAndRelease(HANDLE h, uint32_t ms) {
  auto* r = static_cast<EventRef*>(h);
  bool ok;
  {
    std::unique_lock<std::mutex> lock((*r)->m);
    if (ms == UINT32_MAX) {
      (*r)->cv.wait(lock, [&] { return (*r)->set; });
      ok = true;
    } else {
      ok = (*r)->cv.wait_for(lock, std::chrono::milliseconds(ms), [&] { return (*r)->set; });
    }
  }
  delete r;
  return ok;
}

// -------------------------------------------------------------------- run loop

/**
 * Linux::IRunLoop backed by the UI thread's poll(). Registration may come from
 * any thread (plugins are created on this thread, but nothing forbids a plugin
 * worker registering a timer), so the tables are guarded and a change wakes
 * the loop. Callbacks always run on the UI thread, outside the lock, against a
 * snapshot — a handler may unregister itself (or another) from inside.
 */
class RunLoop : public Linux::IRunLoop {
 public:
  tresult PLUGIN_API registerEventHandler(Linux::IEventHandler* h, Linux::FileDescriptor fd) override {
    if (!h || fd < 0) return kInvalidArgument;
    {
      std::lock_guard<std::mutex> lock(m_);
      h->addRef();
      fds_.push_back({h, fd});
    }
    wake();
    return kResultTrue;
  }
  tresult PLUGIN_API unregisterEventHandler(Linux::IEventHandler* h) override {
    if (!h) return kInvalidArgument;
    std::vector<Linux::IEventHandler*> drop;
    {
      std::lock_guard<std::mutex> lock(m_);
      for (auto it = fds_.begin(); it != fds_.end();) {
        if (it->h == h) {
          drop.push_back(it->h);
          it = fds_.erase(it);
        } else {
          ++it;
        }
      }
    }
    for (auto* d : drop) d->release();
    return kResultTrue;
  }
  tresult PLUGIN_API registerTimer(Linux::ITimerHandler* h, Linux::TimerInterval ms) override {
    if (!h) return kInvalidArgument;
    {
      std::lock_guard<std::mutex> lock(m_);
      h->addRef();
      const auto every = std::chrono::milliseconds(std::max<uint64>(1, ms));
      timers_.push_back({h, every, Clock::now() + every, ++timerGen_});
    }
    wake();
    return kResultTrue;
  }
  tresult PLUGIN_API unregisterTimer(Linux::ITimerHandler* h) override {
    if (!h) return kInvalidArgument;
    std::vector<Linux::ITimerHandler*> drop;
    {
      std::lock_guard<std::mutex> lock(m_);
      for (auto it = timers_.begin(); it != timers_.end();) {
        if (it->h == h) {
          drop.push_back(it->h);
          it = timers_.erase(it);
        } else {
          ++it;
        }
      }
    }
    for (auto* d : drop) d->release();
    return kResultTrue;
  }

  // A process-lifetime singleton: refcounting is a formality.
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
    if (FUnknownPrivate::iidEqual(iid, Linux::IRunLoop::iid) || FUnknownPrivate::iidEqual(iid, FUnknown::iid)) {
      *obj = this;
      return kResultOk;
    }
    *obj = nullptr;
    return kNoInterface;
  }
  uint32 PLUGIN_API addRef() override { return 1000; }
  uint32 PLUGIN_API release() override { return 1000; }

  // ---- used by the UI thread only ----

  void setWakeFd(int fd) { wakeFd_ = fd; }

  /** Append the plugin fds to a poll set. Returns the matching handlers. */
  std::vector<Linux::IEventHandler*> fillPoll(std::vector<pollfd>& pfds) {
    std::lock_guard<std::mutex> lock(m_);
    std::vector<Linux::IEventHandler*> hs;
    for (auto& f : fds_) {
      pfds.push_back({f.fd, POLLIN, 0});
      f.h->addRef(); // held across the dispatch, in case it unregisters itself
      hs.push_back(f.h);
    }
    return hs;
  }

  /** Milliseconds until the next timer is due, capped at `cap`. */
  int msUntilNextTimer(int cap) {
    std::lock_guard<std::mutex> lock(m_);
    const auto now = Clock::now();
    int best = cap;
    for (auto& t : timers_) {
      const auto d = std::chrono::duration_cast<std::chrono::milliseconds>(t.next - now).count();
      best = std::min<int>(best, d < 0 ? 0 : static_cast<int>(d));
    }
    return best;
  }

  /** Fire every due timer once (outside the lock). */
  void runTimers() {
    std::vector<std::pair<Linux::ITimerHandler*, uint64_t>> due;
    {
      std::lock_guard<std::mutex> lock(m_);
      const auto now = Clock::now();
      for (auto& t : timers_) {
        if (t.next > now) continue;
        // Re-arm from now, not from the missed deadline: a GUI that fell behind
        // must not get a burst of catch-up repaints.
        t.next = now + t.every;
        t.h->addRef();
        due.push_back({t.h, t.gen});
      }
    }
    for (auto& [h, gen] : due) {
      if (stillRegistered(h, gen)) h->onTimer();
      h->release();
    }
  }

 private:
  struct Fd { Linux::IEventHandler* h; int fd; };
  struct Timer { Linux::ITimerHandler* h; std::chrono::milliseconds every; Clock::time_point next; uint64_t gen; };

  bool stillRegistered(Linux::ITimerHandler* h, uint64_t gen) {
    std::lock_guard<std::mutex> lock(m_);
    for (auto& t : timers_)
      if (t.h == h && t.gen == gen) return true;
    return false;
  }
  void wake() {
    if (wakeFd_ >= 0) {
      const uint64_t one = 1;
      ssize_t n = write(wakeFd_, &one, sizeof(one));
      (void)n;
    }
  }

  std::mutex m_;
  std::vector<Fd> fds_;
  std::vector<Timer> timers_;
  uint64_t timerGen_ = 0;
  int wakeFd_ = -1;
};

static RunLoop& runLoopImpl() {
  static RunLoop loop;
  return loop;
}

Linux::IRunLoop* UiThread::runLoop() { return &runLoopImpl(); }

// ------------------------------------------------------------------ X display

/** The UI thread's own X connection (null = no X: editors unavailable). */
static Display* gDpy = nullptr;
static Atom gWmDelete = 0;
static Atom gNetWmName = 0;
static Atom gUtf8 = 0;

/**
 * Xlib's DEFAULT error handler prints and calls exit() — so one bad request
 * from any plugin GUI (a stale window id after a hide, a format it guessed
 * wrong) would end the engine and the user's audio with it. Log and carry on.
 * Toolkits that install their own handler (JUCE does) replace this one, which
 * is fine: theirs don't exit either.
 */
static int onXError(Display* d, XErrorEvent* e) {
  char text[128] = {0};
  XGetErrorText(d, e->error_code, text, sizeof(text) - 1);
  UI_TRACE("[vst-ui] X error ignored: %s (request %d, resource 0x%lx)", text, e->request_code,
           (unsigned long)e->resourceid);
  return 0;
}

static void openDisplay() {
  // Must precede every other Xlib call in the process; plugin GUIs make their
  // own Xlib calls from this thread and their own (JUCE spawns a few).
  XInitThreads();
  XSetErrorHandler(onXError);
  gDpy = XOpenDisplay(nullptr);
  if (!gDpy) {
    UI_ERR("no X display (DISPLAY=%s) — plugin editors are unavailable; audio is unaffected. "
           "On a Wayland session this means XWayland is not running.",
           std::getenv("DISPLAY") ? std::getenv("DISPLAY") : "unset");
    return;
  }
  gWmDelete = XInternAtom(gDpy, "WM_DELETE_WINDOW", False);
  gNetWmName = XInternAtom(gDpy, "_NET_WM_NAME", False);
  gUtf8 = XInternAtom(gDpy, "UTF8_STRING", False);
}

// ---------------------------------------------------------------- plug frame

// IPlugFrame (resizeView) + the IRunLoop the plugin asks it for.
class PlugFrame : public IPlugFrame {
 public:
  explicit PlugFrame(Window w) : win_(w) {}
  virtual ~PlugFrame() = default;

  tresult PLUGIN_API resizeView(IPlugView* view, ViewRect* r) override {
    if (!view || !r || !gDpy) return kInvalidArgument;
    const int w = std::max(1, r->getWidth()), h = std::max(1, r->getHeight());
    XResizeWindow(gDpy, win_, w, h);
    XFlush(gDpy);
    view->onSize(r);
    return kResultTrue;
  }

  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
    if (FUnknownPrivate::iidEqual(iid, IPlugFrame::iid) || FUnknownPrivate::iidEqual(iid, FUnknown::iid)) {
      addRef();
      *obj = static_cast<IPlugFrame*>(this);
      return kResultOk;
    }
    if (FUnknownPrivate::iidEqual(iid, Linux::IRunLoop::iid)) {
      *obj = UiThread::instance().runLoop();
      return kResultOk;
    }
    *obj = nullptr;
    return kNoInterface;
  }
  uint32 PLUGIN_API addRef() override { return ++refs_; }
  uint32 PLUGIN_API release() override {
    const uint32 r = --refs_;
    if (r == 0) delete this;
    return r;
  }

 private:
  Window win_;
  std::atomic<uint32> refs_{1};
};

// ---------------------------------------------------------------- EditorHost

class EditorHost {
 public:
  VstInstance* inst = nullptr;
  Vst::IEditController* controller = nullptr;
  IPlugView* view = nullptr;
  PlugFrame* frame = nullptr;
  Window win = 0;
  int width = 0, height = 0;
  bool visible = false;

  bool create(int cascade) {
    const char* pname = inst ? inst->name().c_str() : "?";
    if (!gDpy) { UI_ERR("'%s': no X display — editor unavailable", pname); return false; }
    if (!controller) { UI_ERR("'%s': no edit controller — editor unavailable", pname); return false; }
    view = controller->createView(Vst::ViewType::kEditor);
    UI_TRACE("[vst-ui] createView -> %p", (void*)view);
    if (!view) { UI_ERR("'%s': plugin returned no editor view (createView null)", pname); return false; }
    if (view->isPlatformTypeSupported(kPlatformTypeX11EmbedWindowID) != kResultTrue) {
      UI_ERR("'%s': editor does not support an X11 window", pname);
      view->release();
      view = nullptr;
      return false;
    }

    ViewRect rect{};
    view->getSize(&rect);
    width = rect.getWidth() > 0 ? rect.getWidth() : 720;
    height = rect.getHeight() > 0 ? rect.getHeight() : 450;

    const int scr = DefaultScreen(gDpy);
    const int x = 140 + (cascade % 6) * 36;
    const int y = 100 + (cascade % 6) * 36;
    win = XCreateSimpleWindow(gDpy, RootWindow(gDpy, scr), x, y, width, height, 0,
                              BlackPixel(gDpy, scr), BlackPixel(gDpy, scr));
    if (!win) { UI_ERR("'%s': XCreateWindow failed", pname); return false; }
    XSelectInput(gDpy, win, StructureNotifyMask);
    XSetWMProtocols(gDpy, win, &gWmDelete, 1);

    std::string title = inst->name();
    if (title.empty()) title = "Plugin";
    XStoreName(gDpy, win, title.c_str());
    XChangeProperty(gDpy, win, gNetWmName, gUtf8, 8, PropModeReplace,
                    reinterpret_cast<const unsigned char*>(title.data()), static_cast<int>(title.size()));
    XClassHint cls{const_cast<char*>("livepatch-vst"), const_cast<char*>("LivePatch")};
    XSetClassHint(gDpy, win, &cls);
    // Transient-for the LivePatch window when it is an X window (X11 session,
    // or Electron under XWayland): the window manager then keeps the editor
    // above the app — the Linux spelling of Windows' owned window. On native
    // Wayland Electron there is no X id (owner 0) and the editor floats free.
    const auto owner = reinterpret_cast<uintptr_t>(UiThread::instance().owner());
    if (owner) XSetTransientForHint(gDpy, win, static_cast<Window>(owner));

    frame = new PlugFrame(win);
    view->setFrame(frame);
    // Map before attach: several toolkits (JUCE among them) size and reparent
    // their child against a viewable parent.
    XMapRaised(gDpy, win);
    XSync(gDpy, False);
    const tresult att = view->attached(reinterpret_cast<void*>(win), kPlatformTypeX11EmbedWindowID);
    if (att != kResultTrue) {
      UI_ERR("'%s': editor attach() failed (0x%x)", pname, att);
      destroy();
      return false;
    }

    // Honor the size the plugin actually wants after attach.
    if (view->getSize(&rect) == kResultTrue && rect.getWidth() > 0) {
      width = rect.getWidth();
      height = rect.getHeight();
      XResizeWindow(gDpy, win, width, height);
    }
    syncViewSize(width, height);
    XFlush(gDpy);

    visible = true;
    inst->setUiState(width, height, true);
    inst->setUiPopup(true);
    UI_TRACE("[vst-ui] editor shown win=0x%lx %dx%d", (unsigned long)win, width, height);
    return true;
  }

  /** Push a window size into the view (ConfigureNotify + after attach). */
  void syncViewSize(int w, int h) {
    if (!view || w <= 0 || h <= 0) return;
    ViewRect vr{0, 0, w, h};
    view->onSize(&vr);
  }

  void onConfigure(int w, int h) {
    if (w == width && h == height) return;
    width = w;
    height = h;
    syncViewSize(w, h);
    inst->setUiState(width, height, visible);
  }

  void show() {
    if (!win || !gDpy) return;
    XMapRaised(gDpy, win);
    XFlush(gDpy);
    visible = true;
    inst->setUiState(width, height, true);
  }

  /** Hide, never tear down — same reasoning as uithread_win.cc EditorHost::hide. */
  void hide() {
    if (!win || !gDpy) return;
    XUnmapWindow(gDpy, win);
    XFlush(gDpy);
    visible = false;
    inst->setUiState(width, height, false);
  }

  void onUserClose() {
    hide();
    inst->requestUiClose();
  }

  void drainParamSyncs() {
    if (!controller) return;
    ParamRing::Entry e;
    int budget = 256;
    auto* ring = inst->uiParamRing();
    while (budget-- > 0 && ring->pop(e)) controller->setParamNormalized(e.pid, e.value);
  }

  void destroy() {
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
    if (win && gDpy) {
      XDestroyWindow(gDpy, win);
      XFlush(gDpy);
      win = 0;
    }
  }
};

static std::unordered_map<VstInstance*, EditorHost*>& editors() {
  static std::unordered_map<VstInstance*, EditorHost*> map;
  return map;
}

static EditorHost* editorFor(Window w) {
  for (auto& [inst, host] : editors())
    if (host->win == w) return host;
  return nullptr;
}

static void pumpX() {
  if (!gDpy) return;
  while (XPending(gDpy)) {
    XEvent ev;
    XNextEvent(gDpy, &ev);
    switch (ev.type) {
      case ClientMessage:
        if (static_cast<Atom>(ev.xclient.data.l[0]) == gWmDelete)
          if (auto* host = editorFor(ev.xclient.window)) host->onUserClose();
        break;
      case ConfigureNotify:
        if (auto* host = editorFor(ev.xconfigure.window))
          host->onConfigure(ev.xconfigure.width, ev.xconfigure.height);
        break;
      default:
        break;
    }
  }
}

// ------------------------------------------------------------------ UiThread

UiThread& UiThread::instance() {
  static UiThread t;
  return t;
}

void UiThread::ensureStarted() {
  if (running_.exchange(true)) return;
  wakeFd_ = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
  runLoopImpl().setWakeFd(wakeFd_);
  thread_ = std::thread([this] { pump(); });
  thread_.detach(); // lives as long as the process, like the Win32 thread
}

void UiThread::pump() {
  openDisplay();
  UI_TRACE("[vst-ui] pump started (X %s)", gDpy ? "ok" : "unavailable");
  auto nextSync = Clock::now();
  std::vector<pollfd> pfds;
  for (;;) {
    pumpX();
    drainCmds();

    const auto now = Clock::now();
    if (now >= nextSync) {
      nextSync = now + std::chrono::milliseconds(kSyncMs);
      for (auto& [inst, host] : editors()) host->drainParamSyncs();
    }
    runLoopImpl().runTimers();
    pumpX(); // timers paint; flush what they queued

    pfds.clear();
    pfds.push_back({wakeFd_, POLLIN, 0});
    if (gDpy) pfds.push_back({ConnectionNumber(gDpy), POLLIN, 0});
    const size_t pluginBase = pfds.size();
    auto handlers = runLoopImpl().fillPoll(pfds);

    const auto toSync = std::chrono::duration_cast<std::chrono::milliseconds>(nextSync - Clock::now()).count();
    int timeout = runLoopImpl().msUntilNextTimer(kIdleMs);
    timeout = std::max(0, std::min<int>(timeout, static_cast<int>(std::max<long long>(0, toSync))));
    // Xlib may already hold queued events read off the socket — don't sleep on them.
    if (gDpy && XPending(gDpy)) timeout = 0;

    const int n = poll(pfds.data(), pfds.size(), timeout);
    if (n > 0) {
      if (pfds[0].revents & POLLIN) {
        uint64_t v;
        ssize_t r = read(wakeFd_, &v, sizeof(v));
        (void)r;
      }
      for (size_t i = 0; i < handlers.size(); i++)
        if (pfds[pluginBase + i].revents & (POLLIN | POLLHUP | POLLERR)) handlers[i]->onFDIsSet(pfds[pluginBase + i].fd);
    }
    for (auto* h : handlers) h->release();
  }
}

void UiThread::post(Cmd&& c) {
  ensureStarted();
  {
    std::lock_guard<std::mutex> lock(cmdMutex_);
    cmds_.push_back(std::move(c));
  }
  const uint64_t one = 1;
  ssize_t n = write(wakeFd_, &one, sizeof(one));
  (void)n;
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
          it->second->show();
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
        auto it = map.find(c.inst);
        if (it != map.end()) it->second->hide();
        else c.inst->setUiState(0, 0, false);
        break;
      }
      case Cmd::CreateInst: {
        if (c.job) c.job->ok = c.job->inst->create(c.job->path, c.job->cid, c.job->err);
        if (c.doneEvent) signalAndRelease(c.doneEvent);
        break;
      }
      case Cmd::DestroyInst: {
        // Hide and ABANDON the editor — see uithread_win.cc.
        auto it = map.find(c.inst);
        if (it != map.end()) {
          it->second->hide();
          map.erase(it); // intentionally not deleted
        }
        if (c.inst) c.inst->teardown();
        if (c.doneEvent) signalAndRelease(c.doneEvent);
        c.owned.reset();
        break;
      }
      case Cmd::Call: {
        try {
          if (c.fn) c.fn();
        } catch (...) {
          /* a plugin that throws here loses the result, not the process */
        }
        if (c.doneEvent) signalAndRelease(c.doneEvent);
        break;
      }
      case Cmd::Input:
      case Cmd::Fps:
      case Cmd::Embed:
        break;
    }
  }
}

void UiThread::createInstance(CreateJob& job) {
  HANDLE done = newEvent();
  Cmd c{};
  c.what = Cmd::CreateInst;
  c.job = &job;
  c.doneEvent = dupEvent(done);
  post(std::move(c));
  waitAndRelease(done, UINT32_MAX); // caller is a uv worker, never the JS thread
}

void UiThread::destroyInstance(VstInstance* inst) {
  if (!running_.load()) return;
  HANDLE done = newEvent();
  Cmd c{};
  c.what = Cmd::DestroyInst;
  c.inst = inst;
  c.doneEvent = dupEvent(done);
  post(std::move(c));
  waitAndRelease(done, 5000); // bounded: a wedged plugin GUI must not hang the engine
}

void UiThread::destroyInstanceAsync(std::unique_ptr<VstInstance> inst) {
  if (!inst) return;
  if (!running_.load()) return;
  Cmd c{};
  c.what = Cmd::DestroyInst;
  c.inst = inst.get();
  c.owned = std::move(inst);
  post(std::move(c));
}

HANDLE UiThread::postCall(std::function<void()> fn) {
  HANDLE done = newEvent();
  Cmd c{};
  c.what = Cmd::Call;
  c.fn = std::move(fn);
  c.doneEvent = dupEvent(done);
  post(std::move(c));
  return done;
}

bool UiThread::waitCall(HANDLE done, uint32_t ms) {
  if (!done) return false;
  return waitAndRelease(done, ms);
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
