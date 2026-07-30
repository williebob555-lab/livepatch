#include "host.h"

#include <algorithm>
#include <cstring>
#include <mutex>

#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/utility/stringconvert.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/vsttypes.h"

using namespace Steinberg;

namespace lp {

// Opt-in teardown tracing (LPVST_UI_TRACE=1) — plugin shutdown is the most
// crash-prone moment when hosting third-party code.
static bool tdTrace() {
  static const bool on = GetEnvironmentVariableA("LPVST_UI_TRACE", nullptr, 0) > 0;
  return on;
}
#define TD_TRACE(...) do { if (tdTrace()) { fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); fflush(stderr); } } while (0)

/**
 * A standard SpeakerArrangement for a plain channel count.
 *
 * VST3 identifies a bus layout by a speaker *bitmask*, not a count, so a host
 * asking for "12 channels" has to name a concrete arrangement. These are the
 * conventional ones for each width; anything unrecognised falls back to stereo,
 * which is the safe floor (every plugin supports it) rather than a guess a
 * plugin would reject outright.
 */
static Vst::SpeakerArrangement arrangementFor(int32 chans) {
  using namespace Vst::SpeakerArr;
  switch (chans) {
    case 1: return kMono;
    case 2: return kStereo;
    case 3: return k30Cine;      // L R C
    case 4: return k40Music;     // quad: L R Ls Rs (k40Cine is L R C Cs)
    case 5: return k50;          // L R C Ls Rs
    case 6: return k51;          // 5.1
    case 7: return k61Cine;
    case 8: return k71Cine;      // 7.1
    case 10: return k71_2;       // 7.1.2
    case 12: return k71_4;       // 7.1.4
    case 14: return k91_4;       // 9.1.4
    case 16: return kAmbi3rdOrderACN;  // 3rd-order ambisonics (or 9.1.6-ish)
    default: return kStereo;
  }
}

// ---------------------------------------------------------------- host context

static Vst::HostApplication* hostApp() {
  static Vst::HostApplication app;
  static bool registered = false;
  if (!registered) {
    Vst::PluginContextFactory::instance().setPluginContext(&app);
    registered = true;
  }
  return &app;
}

// ------------------------------------------------------------ ComponentHandler

IMPLEMENT_FUNKNOWN_METHODS(ComponentHandler, Vst::IComponentHandler,
                           Vst::IComponentHandler::iid)

// ---------------------------------------------------------------- module cache

// Modules stay loaded for the engine's lifetime — reloading a .vst3 DLL is
// slow and some plugins do not survive repeated load/unload cycles.
// Guarded: async creation loads modules from uv worker threads.
static std::mutex& moduleMutex() {
  static std::mutex m;
  return m;
}
static std::unordered_map<std::string, VST3::Hosting::Module::Ptr>& moduleCache() {
  static std::unordered_map<std::string, VST3::Hosting::Module::Ptr> cache;
  return cache;
}

static VST3::Hosting::Module::Ptr loadModule(const std::string& path,
                                             std::string& err) {
  std::lock_guard<std::mutex> lock(moduleMutex());
  auto& cache = moduleCache();
  auto it = cache.find(path);
  if (it != cache.end()) return it->second;
  hostApp();  // ensure plugin context exists before any module code runs
  auto mod = VST3::Hosting::Module::create(path, err);
  if (mod) cache[path] = mod;
  return mod;
}

bool moduleClasses(const std::string& path, std::vector<ClassDesc>& out,
                   std::string& err) {
  auto mod = loadModule(path, err);
  if (!mod) return false;
  for (auto& ci : mod->getFactory().classInfos()) {
    if (ci.category() != kVstAudioEffectClass) continue;
    ClassDesc d;
    d.cid = ci.ID().toString();
    d.name = ci.name();
    d.vendor = ci.vendor().empty() ? mod->getFactory().info().vendor() : ci.vendor();
    d.version = ci.version();
    d.subCategories = ci.subCategoriesString();
    out.push_back(std::move(d));
  }
  return true;
}

// ----------------------------------------------------------------- VstInstance

// Teardown is marshalled to the UI thread by instanceDestroy before the
// object dies; this is the belt-and-braces path for instances that never
// reached the registry.
VstInstance::~VstInstance() { teardown(); }

bool VstInstance::create(const std::string& path, const std::string& cid,
                         std::string& err) {
  module_ = loadModule(path, err);
  if (!module_) return false;

  const auto infos = module_->getFactory().classInfos();
  const VST3::Hosting::ClassInfo* found = nullptr;
  if (cid.empty()) {
    // No class pinned — take the module's first audio effect (the common
    // single-plugin .vst3 case).
    for (auto& ci : infos)
      if (ci.category() == kVstAudioEffectClass) { found = &ci; break; }
    if (!found) {
      err = "module has no audio classes";
      return false;
    }
  } else {
    auto uid = VST3::UID::fromString(cid);
    if (!uid) {
      err = "bad class id: " + cid;
      return false;
    }
    for (auto& ci : infos)
      if (ci.ID() == *uid) { found = &ci; break; }
    if (!found) {
      err = "class not found in module: " + cid;
      return false;
    }
  }

  provider_ = owned(new Vst::PlugProvider(module_->getFactory(), *found, true));
  if (!provider_->initialize()) {
    err = "plugin failed to initialize: " + found->name();
    provider_ = nullptr;
    return false;
  }
  name_ = found->name();
  component_ = provider_->getComponentPtr().get();
  controller_ = provider_->getControllerPtr().get();
  if (!component_) {
    err = "plugin has no component";
    return false;
  }
  processor_ = FUnknownPtr<Vst::IAudioProcessor>(component_);
  if (!processor_) {
    err = "plugin has no IAudioProcessor";
    return false;
  }
  if (controller_) {
    handler_ = owned(new ComponentHandler(&editsFromUi_));
    controller_->setComponentHandler(handler_);
    midiMapping_ = FUnknownPtr<Vst::IMidiMapping>(controller_);
  }
  return true;
}

bool VstInstance::setup(double sampleRate, int32_t maxBlock, std::string& err) {
  if (!processor_) { err = "no processor"; return false; }
  sampleRate_ = sampleRate;
  maxBlock_ = maxBlock;

  if (processor_->canProcessSampleSize(Vst::kSample32) != kResultTrue) {
    err = "plugin cannot process 32-bit float";
    return false;
  }

  Vst::ProcessSetup setup{Vst::kRealtime, Vst::kSample32, maxBlock, sampleRate};
  if (processor_->setupProcessing(setup) != kResultTrue) {
    err = "setupProcessing failed";
    return false;
  }

  if (!negotiateBuses(err)) return false;
  hasEventIn_ = component_->getBusCount(Vst::kEvent, Vst::kInput) > 0;
  if (hasEventIn_) component_->activateBus(Vst::kEvent, Vst::kInput, 0, true);

  if (!data_.prepare(*component_, maxBlock, Vst::kSample32)) {
    err = "process buffer prepare failed";
    return false;
  }

  // Filler buffers for plugin bus channels the host isn't driving. Allocated
  // here (setup), never in process. `silence_` must stay all-zero: a plugin
  // reading it should hear nothing, and nothing ever writes to it.
  silence_.assign(static_cast<size_t>(maxBlock), 0.f);
  scratch_.assign(static_cast<size_t>(maxBlock), 0.f);

  inChanges_.setMaxParameters(64);
  outChanges_.setMaxParameters(64);
  inEvents_.setMaxSize(256);
  outEvents_.setMaxSize(256);
  editIds_.reserve(512);
  editValues_.reserve(512);

  ctx_ = {};
  ctx_.state = Vst::ProcessContext::kPlaying | Vst::ProcessContext::kTempoValid |
               Vst::ProcessContext::kTimeSigValid |
               Vst::ProcessContext::kContTimeValid |
               Vst::ProcessContext::kProjectTimeMusicValid;
  ctx_.sampleRate = sampleRate;
  ctx_.tempo = 120.0;
  ctx_.timeSigNumerator = 4;
  ctx_.timeSigDenominator = 4;

  if (component_->setActive(true) != kResultTrue) {
    err = "setActive failed";
    return false;
  }
  latency_ = processor_->getLatencySamples();
  processor_->setProcessing(true);
  active_ = true;
  samplePos_ = 0;
  return true;
}

/**
 * Negotiate main-bus widths and locate the main buses. Runs while the component
 * is INACTIVE (both callers guarantee that) — VST3 only permits arrangement
 * changes there.
 *
 * `wantChans_` (0/2 = stereo) is a REQUEST, not a setting: `setBusArrangements`
 * is a negotiation and a plugin may refuse and keep its own layout. So we ask,
 * then read back `BusInfo.channelCount` and store *that*. Trusting the request
 * would feed channels into a bus that doesn't exist — silently, which is the
 * failure mode the whole width contract exists to prevent (docs/02, docs/13).
 */
bool VstInstance::negotiateBuses(std::string& err) {
  const int32 nIn = component_->getBusCount(Vst::kAudio, Vst::kInput);
  const int32 nOut = component_->getBusCount(Vst::kAudio, Vst::kOutput);
  const Vst::SpeakerArrangement want = arrangementFor(wantChans_);
  std::vector<Vst::SpeakerArrangement> inArr(nIn, want);
  std::vector<Vst::SpeakerArrangement> outArr(nOut, want);
  processor_->setBusArrangements(inArr.empty() ? nullptr : inArr.data(), nIn,
                                 outArr.empty() ? nullptr : outArr.data(), nOut);

  mainInBus_ = mainOutBus_ = -1;
  for (int32 i = 0; i < nIn; i++) {
    Vst::BusInfo bi{};
    component_->getBusInfo(Vst::kAudio, Vst::kInput, i, bi);
    const bool isMain = bi.busType == Vst::kMain && mainInBus_ < 0;
    if (isMain) mainInBus_ = i;
    component_->activateBus(Vst::kAudio, Vst::kInput, i, isMain);
  }
  for (int32 i = 0; i < nOut; i++) {
    Vst::BusInfo bi{};
    component_->getBusInfo(Vst::kAudio, Vst::kOutput, i, bi);
    const bool isMain = bi.busType == Vst::kMain && mainOutBus_ < 0;
    if (isMain) mainOutBus_ = i;
    component_->activateBus(Vst::kAudio, Vst::kOutput, i, isMain);
  }
  if (mainOutBus_ < 0) {
    err = "plugin has no main audio output";
    return false;
  }
  inChans_ = 0;
  outChans_ = 0;
  if (mainInBus_ >= 0) {
    Vst::BusInfo bi{};
    if (component_->getBusInfo(Vst::kAudio, Vst::kInput, mainInBus_, bi) == kResultTrue)
      inChans_ = bi.channelCount;
  }
  {
    Vst::BusInfo bi{};
    if (component_->getBusInfo(Vst::kAudio, Vst::kOutput, mainOutBus_, bi) == kResultTrue)
      outChans_ = bi.channelCount;
  }
  return true;
}

bool VstInstance::resetup(double sampleRate, int32_t maxBlock, std::string& err) {
  if (!processor_ || !component_) { err = "no processor"; return false; }
  if (active_) {
    processor_->setProcessing(false);
    component_->setActive(false);
    active_ = false;
  }
  Vst::ProcessSetup setup{Vst::kRealtime, Vst::kSample32, maxBlock, sampleRate};
  if (processor_->setupProcessing(setup) != kResultTrue) {
    err = "setupProcessing failed";
    return false;
  }
  // Re-negotiate widths here too: the component is inactive right now (the only
  // legal moment), and a device change may come with a different requested
  // width. Skipping this left `requestChannels` silently ineffective on the
  // reconfigure path while `setup` honoured it — the two paths must agree.
  if (!negotiateBuses(err)) return false;
  data_.unprepare();
  if (!data_.prepare(*component_, maxBlock, Vst::kSample32)) {
    err = "process buffer prepare failed";
    return false;
  }
  // Resize the filler buffers with the block size. `processMulti` hands these
  // to the plugin for unconnected channels, so a grown maxBlock with stale
  // buffers is a straight overrun — not a subtle one.
  silence_.assign(static_cast<size_t>(maxBlock), 0.f);
  scratch_.assign(static_cast<size_t>(maxBlock), 0.f);
  sampleRate_ = sampleRate;
  maxBlock_ = maxBlock;
  ctx_.sampleRate = sampleRate;
  if (component_->setActive(true) != kResultTrue) {
    err = "setActive failed";
    return false;
  }
  latency_ = processor_->getLatencySamples();
  processor_->setProcessing(true);
  active_ = true;
  return true;
}

// ---- plugin GUI ----

bool VstInstance::openUi(bool popup) {
  if (!controller_) return false;
  uiWanted_.store(true);
  if (shmName_.empty()) {
    static std::atomic<uint32_t> counter{0};
    shmName_ = "Local\\lpvst_" + std::to_string(GetCurrentProcessId()) + "_" +
               std::to_string(counter.fetch_add(1));
  }
  editorEverOpened_ = true;
  return UiThread::instance().open(this, controller_, !popup, shmName_);
}

void VstInstance::closeUi(bool wait) {
  uiWanted_.store(false);
  if (!uiHostAlive_.load() && !uiOpen_.load()) return;
  UiThread::instance().close(this);
  if (wait) {
    // Block until the UI thread released the view — the instance is about to
    // die and the editor holds pointers into it. UI thread is responsive
    // (15 ms pump); cap the wait so a wedged GUI can't hang teardown forever.
    for (int i = 0; i < 200 && uiHostAlive_.load(); i++) Sleep(5);
  }
}

VstInstance::UiState VstInstance::uiState() const {
  return {uiOpen_.load(), uiPopup_.load(), uiW_.load(), uiH_.load(), shmName_,
          uiFrames_.load(), uiCapErr_.load()};
}

void VstInstance::postUiInput(const UiInput& ev) {
  if (uiOpen_.load()) UiThread::instance().input(this, ev);
}

void VstInstance::embedUi(uintptr_t parentHwnd, int x, int y, int w, int h,
                          int clipX, int clipY, int clipW, int clipH,
                          bool visible) {
  if (uiOpen_.load())
    UiThread::instance().embed(this, reinterpret_cast<HWND>(parentHwnd), x, y,
                               w, h, clipX, clipY, clipW, clipH, visible);
}

// SEH guard. __try/__except cannot live in a frame that constructs C++ objects
// needing unwinding, so it only wraps a call to the real body.
static bool guardedTeardown(VstInstance* self, void (VstInstance::*body)()) {
  __try {
    (self->*body)();
    return true;
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    return false;
  }
}

void VstInstance::teardown() {
  if (tornDown_) return;
  tornDown_ = true;
  // A plugin whose editor was ever opened is LEAKED, not released: shutting a
  // GUI-bearing plugin down runs its whole toolkit down and some (Raum's Qt)
  // fault on their own threads doing it — uncatchable from here. Audio-only
  // instances release normally, so the common case reclaims memory.
  if (editorEverOpened_) {
    TD_TRACE("[vst-td] GUI was opened — leaking plugin instead of releasing");
    provider_.take();
    processor_.take();
    handler_.take();
    midiMapping_.take();
    component_ = nullptr;
    controller_ = nullptr;
    module_ = nullptr;
    active_ = false;
    return;
  }
  // Third-party shutdown code is the most crash-prone moment in hosting. If a
  // plugin faults here we leak it and keep the engine (and the user's audio)
  // alive — a leaked instance is strictly better than a dead engine.
  if (!guardedTeardown(this, &VstInstance::teardownUnsafe)) {
    TD_TRACE("[vst-td] plugin FAULTED during teardown — leaked, engine survives");
    // Drop our references without touching the plugin again.
    provider_.take();
    processor_.take();
    handler_.take();
    midiMapping_.take();
    component_ = nullptr;
    controller_ = nullptr;
    module_ = nullptr;
    active_ = false;
  }
}

void VstInstance::teardownUnsafe() {
  if (processor_ && active_) {
    processor_->setProcessing(false);
    component_->setActive(false);
  }
  active_ = false;
  TD_TRACE("[vst-td] deactivated");
  data_.unprepare();
  TD_TRACE("[vst-td] buffers unprepared");
  midiMapping_ = nullptr;
  processor_ = nullptr;
  TD_TRACE("[vst-td] processor released");
  if (controller_ && handler_) controller_->setComponentHandler(nullptr);
  handler_ = nullptr;
  TD_TRACE("[vst-td] handler cleared");
  component_ = nullptr;
  controller_ = nullptr;
  TD_TRACE("[vst-td] refs cleared");
  provider_ = nullptr;  // terminates + releases component/controller
  TD_TRACE("[vst-td] provider released");
  module_ = nullptr;    // cache still holds the module loaded
  TD_TRACE("[vst-td] teardown done");
}

std::vector<ParamDesc> VstInstance::params() const {
  std::vector<ParamDesc> out;
  if (!controller_) return out;
  const int32 n = controller_->getParameterCount();
  out.reserve(n);
  for (int32 i = 0; i < n; i++) {
    Vst::ParameterInfo pi{};
    if (controller_->getParameterInfo(i, pi) != kResultTrue) continue;
    ParamDesc d;
    d.id = pi.id;
    d.title = VST3::StringConvert::convert(pi.title);
    d.units = VST3::StringConvert::convert(pi.units);
    d.stepCount = pi.stepCount;
    d.defaultNormalized = pi.defaultNormalizedValue;
    d.canAutomate = (pi.flags & Vst::ParameterInfo::kCanAutomate) != 0;
    d.isReadOnly = (pi.flags & Vst::ParameterInfo::kIsReadOnly) != 0;
    d.isBypass = (pi.flags & Vst::ParameterInfo::kIsBypass) != 0;
    d.isHidden = (pi.flags & Vst::ParameterInfo::kIsHidden) != 0;
    out.push_back(std::move(d));
  }
  return out;
}

double VstInstance::getParamNormalized(uint32_t pid) const {
  return controller_ ? controller_->getParamNormalized(pid) : 0.0;
}

std::string VstInstance::paramDisplay(uint32_t pid, double normalized) const {
  if (!controller_) return {};
  Vst::String128 s{};
  if (controller_->getParamStringByValue(pid, normalized, s) != kResultTrue)
    return {};
  return VST3::StringConvert::convert(s);
}

bool VstInstance::paramsDirty() {
  if (!handler_) return false;
  const int32 mask = Vst::kParamValuesChanged | Vst::kParamTitlesChanged |
                     Vst::kReloadComponent;
  const int32 prev = handler_->restartFlags.fetch_and(~mask, std::memory_order_relaxed);
  return (prev & mask) != 0;
}

void VstInstance::queueParam(uint32_t pid, double value) {
  int32 idx = 0;
  if (auto* q = inChanges_.addParameterData(pid, idx)) {
    int32 pointIdx = 0;
    q->addPoint(0, value, pointIdx);
  }
}

void VstInstance::syncToController(uint32_t pid, double value) {
  if (!controller_) return;
  // With an editor open the controller belongs to the UI thread — hand the
  // value over via the lock-free ring (drained on its capture timer). Without
  // one, a direct call is safe and keeps state exact for getState/params.
  if (uiOpen_.load(std::memory_order_relaxed)) paramsToUi_.push(pid, value);
  else controller_->setParamNormalized(pid, value);
}

void VstInstance::setParamNormalized(uint32_t pid, double value) {
  queueParam(pid, value);
  // Keep the controller (and any open GUI) in sync with host automation.
  syncToController(pid, value);
}

void VstInstance::midi(uint8_t status, uint8_t d1, uint8_t d2) {
  const uint8_t type = status & 0xF0;
  const uint8_t ch = status & 0x0F;
  if (type == 0x90 && d2 > 0) {
    Vst::Event ev{};
    ev.busIndex = 0;
    ev.type = Vst::Event::kNoteOnEvent;
    ev.noteOn.channel = ch;
    ev.noteOn.pitch = d1;
    ev.noteOn.velocity = static_cast<float>(d2) / 127.f;
    ev.noteOn.noteId = -1;
    inEvents_.addEvent(ev);
  } else if (type == 0x80 || (type == 0x90 && d2 == 0)) {
    Vst::Event ev{};
    ev.busIndex = 0;
    ev.type = Vst::Event::kNoteOffEvent;
    ev.noteOff.channel = ch;
    ev.noteOff.pitch = d1;
    ev.noteOff.velocity = static_cast<float>(d2) / 127.f;
    ev.noteOff.noteId = -1;
    inEvents_.addEvent(ev);
  } else if (type == 0xB0 && midiMapping_) {
    Vst::ParamID pid = 0;
    if (midiMapping_->getMidiControllerAssignment(0, ch, d1, pid) == kResultOk) {
      const double v = static_cast<double>(d2) / 127.0;
      queueParam(pid, v);
      syncToController(pid, v);
    }
  } else if (type == 0xE0 && midiMapping_) {
    Vst::ParamID pid = 0;
    if (midiMapping_->getMidiControllerAssignment(0, ch, Vst::kPitchBend, pid) ==
        kResultOk) {
      const double v = static_cast<double>((d2 << 7) | d1) / 16383.0;
      queueParam(pid, v);
      syncToController(pid, v);
    }
  }
}

// Shared pre/post plumbing for both process paths. Extracted rather than
// copied: the stereo and multichannel entries differ ONLY in how they bind
// channel buffers, and two hand-maintained copies of the edit-forwarding,
// context and queue-clearing sequence is precisely how one path quietly stops
// reporting GUI edits (docs/13 threading rules depend on this draining).
void VstInstance::beginProcess(int32_t n) {
  // Forward plugin-GUI edits (lock-free ring; UI thread producer) to the
  // processor and to the JS edit report.
  ParamRing::Entry e;
  int budget = 512;
  while (budget-- > 0 && editsFromUi_.pop(e)) {
    queueParam(e.pid, e.value);
    if (editIds_.size() < 512) {
      editIds_.push_back(static_cast<float>(e.pid));
      editValues_.push_back(static_cast<float>(e.value));
    }
  }

  data_.numSamples = n;
  data_.inputParameterChanges = &inChanges_;
  data_.outputParameterChanges = &outChanges_;
  data_.inputEvents = &inEvents_;
  data_.outputEvents = &outEvents_;
  data_.processContext = &ctx_;

  ctx_.projectTimeSamples = samplePos_;
  ctx_.continousTimeSamples = samplePos_;
  ctx_.projectTimeMusic =
      static_cast<double>(samplePos_) / sampleRate_ * (ctx_.tempo / 60.0);
}

void VstInstance::endProcess(int32_t n) {
  samplePos_ += n;

  // Some plugins report automation only via output parameter changes.
  const int32 nOutQ = outChanges_.getParameterCount();
  for (int32 i = 0; i < nOutQ; i++) {
    auto* q = outChanges_.getParameterData(i);
    if (!q || q->getPointCount() < 1) continue;
    int32 off = 0;
    Vst::ParamValue v = 0;
    if (q->getPoint(q->getPointCount() - 1, off, v) == kResultTrue &&
        editIds_.size() < 512) {
      editIds_.push_back(static_cast<float>(q->getParameterId()));
      editValues_.push_back(static_cast<float>(v));
    }
  }

  inChanges_.clearQueue();
  outChanges_.clearQueue();
  inEvents_.clear();
  outEvents_.clear();
}

void VstInstance::process(const float* inL, const float* inR, float* outL,
                          float* outR, int32_t n) {
  if (!active_ || n > maxBlock_) {
    if (outL != inL && inL) std::memcpy(outL, inL, n * sizeof(float));
    if (outR != inR && inR) std::memcpy(outR, inR, n * sizeof(float));
    return;
  }
  beginProcess(n);

  if (mainInBus_ >= 0) {
    data_.setChannelBuffer(Vst::kInput, mainInBus_, 0, const_cast<float*>(inL));
    if (data_.inputs[mainInBus_].numChannels > 1)
      data_.setChannelBuffer(Vst::kInput, mainInBus_, 1, const_cast<float*>(inR));
  }
  data_.setChannelBuffer(Vst::kOutput, mainOutBus_, 0, outL);
  const bool stereoOut = data_.outputs[mainOutBus_].numChannels > 1;
  if (stereoOut) data_.setChannelBuffer(Vst::kOutput, mainOutBus_, 1, outR);

  processor_->process(data_);
  // Mono-out plugin driving a stereo host path: duplicate so both sides sound.
  if (!stereoOut) std::memcpy(outR, outL, n * sizeof(float));
  endProcess(n);
}

void VstInstance::processMulti(const float* const* ins, int32_t nIn,
                               float* const* outs, int32_t nOut, int32_t n) {
  if (!active_ || n > maxBlock_) {
    // Bypass: pass through channel-wise as far as both sides go, and silence
    // any output channel with no matching input (leaving it would repeat the
    // previous quantum forever — the frozen-buffer bug).
    for (int32_t c = 0; c < nOut; c++) {
      if (!outs[c]) continue;
      if (c < nIn && ins[c]) {
        if (outs[c] != ins[c]) std::memcpy(outs[c], ins[c], n * sizeof(float));
      } else {
        std::memset(outs[c], 0, n * sizeof(float));
      }
    }
    return;
  }
  beginProcess(n);

  // Bind as many channels as BOTH sides have. Extra host channels are dropped
  // on input and zeroed on output; extra plugin channels are simply unused.
  // Truncation, never an implicit fold (docs/02).
  if (mainInBus_ >= 0) {
    const int32 pc = data_.inputs[mainInBus_].numChannels;
    for (int32 c = 0; c < pc; c++)
      data_.setChannelBuffer(Vst::kInput, mainInBus_, c,
                             (c < nIn && ins[c]) ? const_cast<float*>(ins[c]) : silence_.data());
  }
  const int32 pcOut = data_.outputs[mainOutBus_].numChannels;
  for (int32 c = 0; c < pcOut; c++)
    data_.setChannelBuffer(Vst::kOutput, mainOutBus_, c,
                           (c < nOut && outs[c]) ? outs[c] : scratch_.data());

  processor_->process(data_);

  // Host channels the plugin didn't write must not keep last quantum's audio.
  for (int32_t c = pcOut; c < nOut; c++)
    if (outs[c]) std::memset(outs[c], 0, n * sizeof(float));
  endProcess(n);
}

size_t VstInstance::takeGuiEdits(const float** ids, const float** values) {
  *ids = editIds_.data();
  *values = editValues_.data();
  const size_t n = editIds_.size();
  // Caller consumes synchronously; clear() keeps capacity.
  editIds_.clear();
  editValues_.clear();
  return n;  // note: data stays valid until the next push (same thread)
}

std::vector<uint8_t> VstInstance::getState(bool& ok) const {
  ok = false;
  std::vector<uint8_t> out;
  if (!component_) return out;
  MemoryStream comp, ctrl;
  if (component_->getState(&comp) != kResultTrue) return out;
  if (controller_) controller_->getState(&ctrl);

  const uint32_t compLen = static_cast<uint32_t>(comp.getSize());
  const uint32_t ctrlLen = static_cast<uint32_t>(ctrl.getSize());
  out.resize(8 + 4 + 4 + compLen + ctrlLen);
  uint8_t* p = out.data();
  std::memcpy(p, "LPVSTST1", 8); p += 8;
  std::memcpy(p, &compLen, 4); p += 4;
  std::memcpy(p, &ctrlLen, 4); p += 4;
  std::memcpy(p, comp.getData(), compLen); p += compLen;
  std::memcpy(p, ctrl.getData(), ctrlLen);
  ok = true;
  return out;
}

bool VstInstance::setState(const uint8_t* buf, size_t len) {
  if (!component_ || len < 16 || std::memcmp(buf, "LPVSTST1", 8) != 0)
    return false;
  uint32_t compLen = 0, ctrlLen = 0;
  std::memcpy(&compLen, buf + 8, 4);
  std::memcpy(&ctrlLen, buf + 12, 4);
  if (16 + static_cast<size_t>(compLen) + ctrlLen > len) return false;
  const uint8_t* compData = buf + 16;
  const uint8_t* ctrlData = compData + compLen;

  {
    MemoryStream s(const_cast<uint8_t*>(compData), compLen);
    if (component_->setState(&s) != kResultTrue) return false;
  }
  if (controller_) {
    MemoryStream s(const_cast<uint8_t*>(compData), compLen);
    controller_->setComponentState(&s);
    if (ctrlLen) {
      MemoryStream cs(const_cast<uint8_t*>(ctrlData), ctrlLen);
      controller_->setState(&cs);
    }
  }
  return true;
}

// ----------------------------------------------------------- instance registry

static std::unordered_map<int32_t, std::unique_ptr<VstInstance>>& registry() {
  static std::unordered_map<int32_t, std::unique_ptr<VstInstance>> map;
  return map;
}

static int32_t nextInstanceId = 1;

int32_t instanceCreate(const std::string& path, const std::string& cid,
                       std::string& err) {
  auto inst = std::make_unique<VstInstance>();
  // Construct on the UI thread so the plugin's GUI toolkit binds to a thread
  // with a message loop (see UiThread::createInstance).
  UiThread::CreateJob job;
  job.inst = inst.get();
  job.path = path;
  job.cid = cid;
  UiThread::instance().createInstance(job);
  if (!job.ok) {
    err = job.err;
    return -1;
  }
  const int32_t id = nextInstanceId++;
  registry()[id] = std::move(inst);
  return id;
}

int32_t instanceAdopt(std::unique_ptr<VstInstance> inst) {
  const int32_t id = nextInstanceId++;
  registry()[id] = std::move(inst);
  return id;
}

VstInstance* instanceGet(int32_t handle) {
  auto it = registry().find(handle);
  return it == registry().end() ? nullptr : it->second.get();
}

void instanceDestroy(int32_t handle) {
  auto it = registry().find(handle);
  if (it == registry().end()) return;
  // Close the editor and release the plugin on the thread that created it,
  // then drop the object here.
  UiThread::instance().destroyInstance(it->second.get());
  registry().erase(it);
}

}  // namespace lp
