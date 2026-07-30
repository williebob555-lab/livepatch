// LivePatch VST3 host addon — N-API entry point.
// Loaded by the engine process (real node.exe). Everything here is called from
// the engine's JS thread; the process() path must stay allocation-free on the
// native side (see host.h for the performance contract).
#include <napi.h>
#include <objbase.h>

#include <unordered_map>

#include "host.h"

namespace {

// Loads + instantiates + sets up a plugin off the JS thread. Instance creation
// takes hundreds of ms for big plugins — running it synchronously would starve
// the audio pump (the engine's JS thread IS the pump). The instance is adopted
// into the registry on the JS thread in OnOK, so registry access stays
// single-threaded.
class CreateWorker : public Napi::AsyncWorker {
 public:
  CreateWorker(Napi::Function& cb, std::string path, std::string cid, double sr,
               int32_t maxBlock, int32_t chans)
      : Napi::AsyncWorker(cb),
        path_(std::move(path)),
        cid_(std::move(cid)),
        sr_(sr),
        maxBlock_(maxBlock),
        chans_(chans) {}

  void Execute() override {
    // Plugins (iZotope especially) use COM internally; init per pool thread.
    // Deliberately never uninitialized — the uv pool thread is reused.
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    inst_ = std::make_unique<lp::VstInstance>();
    // Construct on the addon's UI thread (not this worker): plugin GUI
    // toolkits bind to the creating thread and need its message loop, or the
    // editor never paints. See UiThread::createInstance.
    lp::UiThread::CreateJob job;
    job.inst = inst_.get();
    job.path = path_;
    job.cid = cid_;
    lp::UiThread::instance().createInstance(job);
    if (!job.ok) {
      SetError(job.err.empty() ? "plugin create failed" : job.err);
      return;
    }
    std::string err;
    // Width must be requested before setup — arrangements are only negotiable
    // while the component is inactive.
    inst_->requestChannels(chans_);
    if (!inst_->setup(sr_, maxBlock_, err)) {
      SetError(err.empty() ? "plugin setup failed" : err);
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Object o = Napi::Object::New(env);
    o.Set("latency", inst_->latencySamples());
    o.Set("hasAudioIn", inst_->hasAudioIn());
    o.Set("name", inst_->name());
    // Negotiated widths, so the kernel can size its ports to what the plugin
    // actually agreed to rather than what was asked for.
    o.Set("inChannels", inst_->mainInChannels());
    o.Set("outChannels", inst_->mainOutChannels());
    o.Set("handle", lp::instanceAdopt(std::move(inst_)));
    Callback().Call({env.Null(), o});
  }

 private:
  std::string path_;
  std::string cid_;
  double sr_;
  int32_t maxBlock_;
  int32_t chans_;
  std::unique_ptr<lp::VstInstance> inst_;
};

void ThrowJs(Napi::Env env, const std::string& msg) {
  Napi::Error::New(env, msg).ThrowAsJavaScriptException();
}

Napi::Value Version(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), "vsthost 0.1.0 vst-sdk-3.8.0");
}

// moduleClasses(path) -> [{cid, name, vendor, version, subCategories}]
Napi::Value ModuleClasses(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string path = info[0].As<Napi::String>();
  std::vector<lp::ClassDesc> classes;
  std::string err;
  if (!lp::moduleClasses(path, classes, err)) {
    ThrowJs(env, "module load failed: " + err);
    return env.Null();
  }
  Napi::Array arr = Napi::Array::New(env, classes.size());
  for (size_t i = 0; i < classes.size(); i++) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("cid", classes[i].cid);
    o.Set("name", classes[i].name);
    o.Set("vendor", classes[i].vendor);
    o.Set("version", classes[i].version);
    o.Set("subCategories", classes[i].subCategories);
    arr.Set(static_cast<uint32_t>(i), o);
  }
  return arr;
}

// create(path, cid) -> handle
Napi::Value Create(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string err;
  const int32_t h = lp::instanceCreate(info[0].As<Napi::String>(),
                                       info[1].As<Napi::String>(), err);
  if (h < 0) {
    ThrowJs(env, err);
    return env.Null();
  }
  return Napi::Number::New(env, h);
}

// createAsync(path, cid, sampleRate, maxBlock, cb(err, {handle, latency,
//             hasAudioIn, name, inChannels, outChannels}), [chans])
// `chans` (optional, 0/2 = stereo) is the REQUESTED main-bus width; the result's
// inChannels/outChannels report what the plugin actually accepted.
Napi::Value CreateAsync(const Napi::CallbackInfo& info) {
  Napi::Function cb = info[4].As<Napi::Function>();
  const int32_t chans =
      info.Length() > 5 && info[5].IsNumber() ? info[5].As<Napi::Number>().Int32Value() : 0;
  auto* w = new CreateWorker(cb, info[0].As<Napi::String>(),
                             info[1].As<Napi::String>(),
                             info[2].As<Napi::Number>().DoubleValue(),
                             info[3].As<Napi::Number>().Int32Value(), chans);
  w->Queue();
  return info.Env().Undefined();
}

lp::VstInstance* Inst(const Napi::CallbackInfo& info) {
  return lp::instanceGet(info[0].As<Napi::Number>().Int32Value());
}

// resetup(handle, sampleRate, maxBlock, [chans]) -> latency (device reconfigure)
Napi::Value Resetup(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* v = Inst(info);
  if (!v) { ThrowJs(env, "bad handle"); return env.Null(); }
  std::string err;
  if (info.Length() > 3 && info[3].IsNumber())
    v->requestChannels(info[3].As<Napi::Number>().Int32Value());
  if (!v->resetup(info[1].As<Napi::Number>().DoubleValue(),
                  info[2].As<Napi::Number>().Int32Value(), err)) {
    ThrowJs(env, err);
    return env.Null();
  }
  return Napi::Number::New(env, v->latencySamples());
}

// setup(handle, sampleRate, maxBlock) -> {latency, hasAudioIn, name}
Napi::Value Setup(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* v = Inst(info);
  if (!v) { ThrowJs(env, "bad handle"); return env.Null(); }
  std::string err;
  if (!v->setup(info[1].As<Napi::Number>().DoubleValue(),
                info[2].As<Napi::Number>().Int32Value(), err)) {
    ThrowJs(env, err);
    return env.Null();
  }
  Napi::Object o = Napi::Object::New(env);
  o.Set("latency", v->latencySamples());
  o.Set("hasAudioIn", v->hasAudioIn());
  o.Set("name", v->name());
  return o;
}

// params(handle) -> [{id, title, units, stepCount, def, canAutomate, readOnly, bypass, hidden}]
Napi::Value Params(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* v = Inst(info);
  if (!v) { ThrowJs(env, "bad handle"); return env.Null(); }
  const auto params = v->params();
  Napi::Array arr = Napi::Array::New(env, params.size());
  for (size_t i = 0; i < params.size(); i++) {
    const auto& p = params[i];
    Napi::Object o = Napi::Object::New(env);
    o.Set("id", p.id);
    o.Set("title", p.title);
    o.Set("units", p.units);
    o.Set("stepCount", p.stepCount);
    o.Set("def", p.defaultNormalized);
    o.Set("canAutomate", p.canAutomate);
    o.Set("readOnly", p.isReadOnly);
    o.Set("bypass", p.isBypass);
    o.Set("hidden", p.isHidden);
    arr.Set(static_cast<uint32_t>(i), o);
  }
  return arr;
}

Napi::Value SetParam(const Napi::CallbackInfo& info) {
  if (auto* v = Inst(info))
    v->setParamNormalized(info[1].As<Napi::Number>().Uint32Value(),
                          info[2].As<Napi::Number>().DoubleValue());
  return info.Env().Undefined();
}

Napi::Value GetParam(const Napi::CallbackInfo& info) {
  auto* v = Inst(info);
  return Napi::Number::New(
      info.Env(),
      v ? v->getParamNormalized(info[1].As<Napi::Number>().Uint32Value()) : 0);
}

Napi::Value ParamDisplay(const Napi::CallbackInfo& info) {
  auto* v = Inst(info);
  if (!v) return info.Env().Null();
  return Napi::String::New(
      info.Env(), v->paramDisplay(info[1].As<Napi::Number>().Uint32Value(),
                                  info[2].As<Napi::Number>().DoubleValue()));
}

Napi::Value ParamsDirty(const Napi::CallbackInfo& info) {
  auto* v = Inst(info);
  return Napi::Boolean::New(info.Env(), v ? v->paramsDirty() : false);
}

Napi::Value Midi(const Napi::CallbackInfo& info) {
  if (auto* v = Inst(info))
    v->midi(static_cast<uint8_t>(info[1].As<Napi::Number>().Uint32Value()),
            static_cast<uint8_t>(info[2].As<Napi::Number>().Uint32Value()),
            static_cast<uint8_t>(info[3].As<Napi::Number>().Uint32Value()));
  return info.Env().Undefined();
}

// process(handle, inL, inR, outL, outR, n) — hot path, keep lean.
Napi::Value Process(const Napi::CallbackInfo& info) {
  auto* v = Inst(info);
  if (!v) return info.Env().Undefined();
  auto inL = info[1].As<Napi::Float32Array>();
  auto inR = info[2].As<Napi::Float32Array>();
  auto outL = info[3].As<Napi::Float32Array>();
  auto outR = info[4].As<Napi::Float32Array>();
  const int32_t n = info[5].As<Napi::Number>().Int32Value();
  v->process(inL.Data(), inR.Data(), outL.Data(), outR.Data(), n);
  return info.Env().Undefined();
}

// processMulti(handle, [inCh...], [outCh...], n) — multichannel hot path.
//
// The channel pointer arrays are gathered into fixed stack buffers per call so
// nothing heap-allocates here; MAXCH mirrors the engine's own cap (dsp.ts).
Napi::Value ProcessMulti(const Napi::CallbackInfo& info) {
  auto* v = Inst(info);
  if (!v) return info.Env().Undefined();
  auto insArr = info[1].As<Napi::Array>();
  auto outsArr = info[2].As<Napi::Array>();
  const int32_t n = info[3].As<Napi::Number>().Int32Value();
  constexpr int32_t MAXCH = 32;
  const float* ins[MAXCH];
  float* outs[MAXCH];
  int32_t nIn = 0;
  int32_t nOut = 0;
  const uint32_t inLen = insArr.Length();
  for (uint32_t i = 0; i < inLen && nIn < MAXCH; i++) {
    Napi::Value e = insArr[i];
    ins[nIn++] = e.IsTypedArray() ? e.As<Napi::Float32Array>().Data() : nullptr;
  }
  const uint32_t outLen = outsArr.Length();
  for (uint32_t i = 0; i < outLen && nOut < MAXCH; i++) {
    Napi::Value e = outsArr[i];
    outs[nOut++] = e.IsTypedArray() ? e.As<Napi::Float32Array>().Data() : nullptr;
  }
  v->processMulti(ins, nIn, outs, nOut, n);
  return info.Env().Undefined();
}

// channels(handle) -> { in, out } — what the plugin ACCEPTED, post-negotiation.
Napi::Value Channels(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* v = Inst(info);
  if (!v) return env.Null();
  Napi::Object o = Napi::Object::New(env);
  o.Set("in", Napi::Number::New(env, v->mainInChannels()));
  o.Set("out", Napi::Number::New(env, v->mainOutChannels()));
  return o;
}

// takeEdits(handle) -> null | [id0, v0, id1, v1, ...]
Napi::Value TakeEdits(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* v = Inst(info);
  if (!v) return env.Null();
  const float* ids = nullptr;
  const float* vals = nullptr;
  const size_t n = v->takeGuiEdits(&ids, &vals);
  if (!n) return env.Null();
  Napi::Array arr = Napi::Array::New(env, n * 2);
  for (size_t i = 0; i < n; i++) {
    arr.Set(static_cast<uint32_t>(i * 2), ids[i]);
    arr.Set(static_cast<uint32_t>(i * 2 + 1), vals[i]);
  }
  return arr;
}

Napi::Value GetState(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* v = Inst(info);
  if (!v) return env.Null();
  bool ok = false;
  auto state = v->getState(ok);
  if (!ok) return env.Null();
  return Napi::Buffer<uint8_t>::Copy(env, state.data(), state.size());
}

Napi::Value SetState(const Napi::CallbackInfo& info) {
  auto* v = Inst(info);
  if (!v) return Napi::Boolean::New(info.Env(), false);
  auto buf = info[1].As<Napi::Buffer<uint8_t>>();
  return Napi::Boolean::New(info.Env(), v->setState(buf.Data(), buf.Length()));
}

Napi::Value Destroy(const Napi::CallbackInfo& info) {
  lp::instanceDestroy(info[0].As<Napi::Number>().Int32Value());
  return info.Env().Undefined();
}

// ---- plugin GUI ----

// uiOpen(handle, popup) -> bool. Async: poll uiState for readiness.
Napi::Value UiOpen(const Napi::CallbackInfo& info) {
  auto* v = Inst(info);
  return Napi::Boolean::New(info.Env(),
                            v ? v->openUi(info[1].ToBoolean()) : false);
}

Napi::Value UiClose(const Napi::CallbackInfo& info) {
  if (auto* v = Inst(info)) v->closeUi(false);
  return info.Env().Undefined();
}

// setHostWindow(hwndNumber): the LivePatch app window; editor windows are
// created owned by it so they always float above the app. 0 clears it.
Napi::Value SetHostWindow(const Napi::CallbackInfo& info) {
  const uintptr_t h = info.Length() > 0 ? static_cast<uintptr_t>(info[0].ToNumber().Int64Value()) : 0;
  lp::UiThread::instance().setOwner(reinterpret_cast<HWND>(h));
  return info.Env().Undefined();
}

// uiPollClosed(handle) -> bool: true once when the user closed the window.
Napi::Value UiPollClosed(const Napi::CallbackInfo& info) {
  auto* v = Inst(info);
  return Napi::Boolean::New(info.Env(), v ? v->takeUiUserClosed() : false);
}

// uiState(handle) -> {open, popup, w, h, shm}
Napi::Value UiState(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* v = Inst(info);
  if (!v) return env.Null();
  const auto s = v->uiState();
  Napi::Object o = Napi::Object::New(env);
  o.Set("open", s.open);
  o.Set("popup", s.popup);
  o.Set("w", s.width);
  o.Set("h", s.height);
  o.Set("shm", s.shm);
  o.Set("frames", s.frames);
  o.Set("capErr", s.capErr);
  return o;
}

// uiEmbed(handle, parentHwnd, x, y, w, h, clipX, clipY, clipW, clipH, visible)
// — ride above the app window at a client rect, clipped to the canvas area.
// parentHwnd as a JS number (HWNDs fit in 53 bits).
Napi::Value UiEmbed(const Napi::CallbackInfo& info) {
  if (auto* v = Inst(info)) {
    v->embedUi(static_cast<uintptr_t>(info[1].As<Napi::Number>().Int64Value()),
               info[2].As<Napi::Number>().Int32Value(),
               info[3].As<Napi::Number>().Int32Value(),
               info[4].As<Napi::Number>().Int32Value(),
               info[5].As<Napi::Number>().Int32Value(),
               info[6].As<Napi::Number>().Int32Value(),
               info[7].As<Napi::Number>().Int32Value(),
               info[8].As<Napi::Number>().Int32Value(),
               info[9].As<Napi::Number>().Int32Value(),
               info[10].ToBoolean());
  }
  return info.Env().Undefined();
}

// uiInput(handle, type, x, y, button, wheel) — type: 0 move,1 down,2 up,3 wheel,4 dblclick
Napi::Value UiInput(const Napi::CallbackInfo& info) {
  auto* v = Inst(info);
  if (!v) return info.Env().Undefined();
  lp::UiInput ev{};
  ev.type = static_cast<lp::UiInput::Type>(info[1].As<Napi::Number>().Uint32Value());
  ev.x = info[2].As<Napi::Number>().Int32Value();
  ev.y = info[3].As<Napi::Number>().Int32Value();
  ev.button = info.Length() > 4 ? info[4].As<Napi::Number>().Int32Value() : 0;
  ev.wheel = info.Length() > 5 ? info[5].As<Napi::Number>().Int32Value() : 0;
  v->postUiInput(ev);
  return info.Env().Undefined();
}

// ---- shared-memory frame reader (used by the Electron MAIN process, which
// loads this same addon just for these two functions) ----

struct FrameView {
  HANDLE file;
  const uint8_t* mem;
};
std::unordered_map<std::string, FrameView>& frameViews() {
  static std::unordered_map<std::string, FrameView> m;
  return m;
}

// frameRead(shmName, lastSeq) -> null (no new frame) | {w, h, seq, data: RGBA Buffer}
Napi::Value FrameRead(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string name = info[0].As<Napi::String>();
  const uint32_t lastSeq = info[1].As<Napi::Number>().Uint32Value();
  auto& views = frameViews();
  auto it = views.find(name);
  if (it == views.end()) {
    HANDLE f = OpenFileMappingA(FILE_MAP_READ, FALSE, name.c_str());
    if (!f) return env.Null();
    const auto* mem = static_cast<const uint8_t*>(MapViewOfFile(f, FILE_MAP_READ, 0, 0, 0));
    if (!mem) {
      CloseHandle(f);
      return env.Null();
    }
    it = views.emplace(name, FrameView{f, mem}).first;
  }
  const auto* hdr = reinterpret_cast<const lp::FrameHeader*>(it->second.mem);
  if (hdr->magic != lp::FRAME_MAGIC || hdr->seq == lastSeq) return env.Null();
  const uint32_t w = hdr->width, h = hdr->height;
  if (!w || !h || w > lp::MAX_UI_W || h > lp::MAX_UI_H) return env.Null();
  const uint8_t* src = it->second.mem + sizeof(lp::FrameHeader);
  auto out = Napi::Buffer<uint8_t>::New(env, size_t(w) * h * 4);
  uint8_t* dst = out.Data();
  // BGRA (GDI) → RGBA (canvas), forced opaque (GDI alpha is garbage).
  for (size_t i = 0, n = size_t(w) * h * 4; i < n; i += 4) {
    dst[i] = src[i + 2];
    dst[i + 1] = src[i + 1];
    dst[i + 2] = src[i];
    dst[i + 3] = 255;
  }
  Napi::Object o = Napi::Object::New(env);
  o.Set("w", w);
  o.Set("h", h);
  o.Set("seq", hdr->seq);
  o.Set("data", out);
  return o;
}

Napi::Value FrameClose(const Napi::CallbackInfo& info) {
  const std::string name = info[0].As<Napi::String>();
  auto& views = frameViews();
  auto it = views.find(name);
  if (it != views.end()) {
    UnmapViewOfFile(const_cast<uint8_t*>(it->second.mem));
    CloseHandle(it->second.file);
    views.erase(it);
  }
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("version", Napi::Function::New(env, Version));
  exports.Set("moduleClasses", Napi::Function::New(env, ModuleClasses));
  exports.Set("create", Napi::Function::New(env, Create));
  exports.Set("createAsync", Napi::Function::New(env, CreateAsync));
  exports.Set("setup", Napi::Function::New(env, Setup));
  exports.Set("resetup", Napi::Function::New(env, Resetup));
  exports.Set("params", Napi::Function::New(env, Params));
  exports.Set("setParam", Napi::Function::New(env, SetParam));
  exports.Set("getParam", Napi::Function::New(env, GetParam));
  exports.Set("paramDisplay", Napi::Function::New(env, ParamDisplay));
  exports.Set("paramsDirty", Napi::Function::New(env, ParamsDirty));
  exports.Set("midi", Napi::Function::New(env, Midi));
  exports.Set("process", Napi::Function::New(env, Process));
  exports.Set("processMulti", Napi::Function::New(env, ProcessMulti));
  exports.Set("channels", Napi::Function::New(env, Channels));
  exports.Set("takeEdits", Napi::Function::New(env, TakeEdits));
  exports.Set("getState", Napi::Function::New(env, GetState));
  exports.Set("setState", Napi::Function::New(env, SetState));
  exports.Set("destroy", Napi::Function::New(env, Destroy));
  exports.Set("uiOpen", Napi::Function::New(env, UiOpen));
  exports.Set("uiEmbed", Napi::Function::New(env, UiEmbed));
  exports.Set("uiClose", Napi::Function::New(env, UiClose));
  exports.Set("setHostWindow", Napi::Function::New(env, SetHostWindow));
  exports.Set("uiPollClosed", Napi::Function::New(env, UiPollClosed));
  exports.Set("uiState", Napi::Function::New(env, UiState));
  exports.Set("uiInput", Napi::Function::New(env, UiInput));
  exports.Set("frameRead", Napi::Function::New(env, FrameRead));
  exports.Set("frameClose", Napi::Function::New(env, FrameClose));
  return exports;
}

}  // namespace

NODE_API_MODULE(vsthost, Init)
