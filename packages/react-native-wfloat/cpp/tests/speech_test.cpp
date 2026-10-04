// Contract tests use explicit fake engines. These do NOT verify ONNX inference.
#include "../SpeechRuntime.cpp"
#include <iostream>
#include <cstring>
using namespace wfloat_next;
namespace {
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
template<class F> void rejects(F fn) { bool threw = false; try { fn(); } catch (const std::exception&) { threw = true; } require(threw, "Expected failure"); }
int aliveTts=0, aliveOffline=0, aliveOnline=0, aliveStream=0, decodes=0;
bool badTiming=false, vadThrows=false, whisperTimestamps=false;
std::vector<float> vadInput;
std::string preparedText, synthesizedText, ttsModel, ttsTokens, ttsData;
std::string capturedHotwords;
int synthesizedVoice=-1;
float synthesizedSpeed=0;
}
struct SherpaOnnxOfflineTts {};
struct SherpaOnnxOfflineRecognizer {};
struct SherpaOnnxOnlineRecognizer {};
struct SherpaOnnxOfflineStream {};
struct SherpaOnnxOnlineStream { mutable int pending=0, accepted=0; mutable bool finished=false; };
extern "C" {
const SherpaOnnxOfflineTts* SherpaOnnxCreateOfflineTts(const SherpaOnnxOfflineTtsConfig* c) {
  ttsModel=c->model.wfloat.model; ttsTokens=c->model.wfloat.tokens; ttsData=c->model.wfloat.data_dir;
  ++aliveTts; return new SherpaOnnxOfflineTts;
}
void SherpaOnnxDestroyOfflineTts(const SherpaOnnxOfflineTts* p) { if(p) --aliveTts; delete p; }
int32_t SherpaOnnxOfflineTtsSampleRate(const SherpaOnnxOfflineTts*) { return 22050; }
const char* SherpaOnnxOfflineTtsWfloatPrepareText(const SherpaOnnxOfflineTts*, const char* text, const char*, float) {
  preparedText = text;
  return strdup(Json{{"text",Json::array({" Hi🌍 ", "! "})},{"text_clean",Json::array({"clean", "!"})}}.dump().c_str());
}
void SherpaOnnxOfflineTtsWfloatFreePreparedText(const char* s) { free(const_cast<char*>(s)); }
const SherpaOnnxGeneratedAudio* SherpaOnnxOfflineTtsGenerateWithConfig(const SherpaOnnxOfflineTts*, const char* text,
  const SherpaOnnxGenerationConfig* c, SherpaOnnxGeneratedAudioProgressCallbackWithArg callback, void* arg) {
  synthesizedText=text; synthesizedVoice=c->sid; synthesizedSpeed=c->speed;
  static float pcm[] = {.1f,.2f}; callback(pcm,2,1,arg);
  auto result = new SherpaOnnxGeneratedAudio{}; result->samples=pcm; result->n=2; result->sample_rate=22050; return result;
}
void SherpaOnnxDestroyOfflineTtsGeneratedAudio(const SherpaOnnxGeneratedAudio* a) { delete a; }
const SherpaOnnxOfflineRecognizer* SherpaOnnxCreateOfflineRecognizer(const SherpaOnnxOfflineRecognizerConfig* c) {
  whisperTimestamps=c->model_config.whisper.enable_segment_timestamps; ++aliveOffline; return new SherpaOnnxOfflineRecognizer;
}
void SherpaOnnxDestroyOfflineRecognizer(const SherpaOnnxOfflineRecognizer* p) { if(p) --aliveOffline; delete p; }
const SherpaOnnxOnlineRecognizer* SherpaOnnxCreateOnlineRecognizer(const SherpaOnnxOnlineRecognizerConfig* c) {
  capturedHotwords = c->hotwords_buf;
  if (!capturedHotwords.empty()) {
    require(std::string(c->decoding_method)=="modified_beam_search", "Hotwords did not enable beam search");
    std::ifstream file(c->model_config.bpe_vocab); require(file.good(),"Vocabulary disappeared before creation");
  }
  ++aliveOnline; return new SherpaOnnxOnlineRecognizer;
}
void SherpaOnnxDestroyOnlineRecognizer(const SherpaOnnxOnlineRecognizer* p) { if(p) --aliveOnline; delete p; }
const SherpaOnnxOnlineStream* SherpaOnnxCreateOnlineStream(const SherpaOnnxOnlineRecognizer*) { ++aliveStream; return new SherpaOnnxOnlineStream; }
void SherpaOnnxDestroyOnlineStream(const SherpaOnnxOnlineStream* s) { if(s) --aliveStream; delete s; }
void SherpaOnnxOnlineStreamAcceptWaveform(const SherpaOnnxOnlineStream* s, int32_t rate, const float*, int32_t count) {
  require(rate==16000,"Online rate mismatch"); s->accepted+=count; ++s->pending;
}
void SherpaOnnxOnlineStreamInputFinished(const SherpaOnnxOnlineStream* s) { s->finished=true; }
int32_t SherpaOnnxIsOnlineStreamReady(const SherpaOnnxOnlineRecognizer*, const SherpaOnnxOnlineStream* s) { return s->pending>0; }
void SherpaOnnxDecodeOnlineStream(const SherpaOnnxOnlineRecognizer*, const SherpaOnnxOnlineStream* s) { --s->pending; ++decodes; }
void SherpaOnnxOnlineStreamReset(const SherpaOnnxOnlineRecognizer*, const SherpaOnnxOnlineStream* s) { s->pending=0; }
int32_t SherpaOnnxOnlineStreamIsEndpoint(const SherpaOnnxOnlineRecognizer*, const SherpaOnnxOnlineStream* s) { return s->finished; }
const SherpaOnnxOnlineRecognizerResult* SherpaOnnxGetOnlineStreamResult(const SherpaOnnxOnlineRecognizer*, const SherpaOnnxOnlineStream*) {
  auto result=new SherpaOnnxOnlineRecognizerResult{}; result->text="online"; return result;
}
void SherpaOnnxDestroyOnlineRecognizerResult(const SherpaOnnxOnlineRecognizerResult* r) { delete r; }
const SherpaOnnxOfflineStream* SherpaOnnxCreateOfflineStream(const SherpaOnnxOfflineRecognizer*) { return new SherpaOnnxOfflineStream; }
void SherpaOnnxDestroyOfflineStream(const SherpaOnnxOfflineStream* s) { delete s; }
void SherpaOnnxAcceptWaveformOffline(const SherpaOnnxOfflineStream*, int32_t rate, const float*, int32_t) { require(rate==16000,"Offline rate mismatch"); }
void SherpaOnnxDecodeOfflineStream(const SherpaOnnxOfflineRecognizer*, const SherpaOnnxOfflineStream*) { ++decodes; }
const SherpaOnnxOfflineRecognizerResult* SherpaOnnxGetOfflineStreamResult(const SherpaOnnxOfflineStream*) {
  auto r=new SherpaOnnxOfflineRecognizerResult{}; r->text="hello";
  static const char* texts[]={"hello"}; static float starts[]={0}; static float durations[]={0};
  durations[0]=badTiming?0:.01f;
  r->segment_count=1; r->segment_texts_arr=texts; r->segment_timestamps=starts; r->segment_durations=durations;
  return r;
}
void SherpaOnnxDestroyOfflineRecognizerResult(const SherpaOnnxOfflineRecognizerResult* r) { delete r; }
}
namespace sherpa_onnx {
bool VadModelConfig::Validate() const { return true; }
struct FakeVad final : VadModel {
  void Reset() override { vadInput.clear(); }
  bool IsSpeech(const float*,int32_t) override { throw std::runtime_error("Detector must not replace score API"); }
  float Compute(const float* pcm,int32_t n) override { if(vadThrows) throw std::runtime_error("VAD failed"); vadInput.assign(pcm,pcm+n); return .25f; }
  int32_t WindowSize() const override { return 576; }
  int32_t WindowShift() const override { return 512; }
  int32_t MinSilenceDurationSamples() const override { return 0; }
  int32_t MinSpeechDurationSamples() const override { return 0; }
  void SetMinSilenceDuration(float) override {}
  void SetThreshold(float) override {}
};
std::unique_ptr<VadModel> VadModel::Create(const VadModelConfig&) { return std::make_unique<FakeVad>(); }
}
int main() {
 try {
  require(utf16Length("a🌍你") == 4,"UTF-16 offsets counted bytes/codepoints");
  rejects([]{utf16Length(std::string("\xed\xa0\x80"));});
  require(hotwords(Json{{"hotwords",Json::array({"  hello\tworld  ","HELLO WORLD","don't"})}})=="HELLO WORLD\nDON'T", "Hotword normalization mismatch");
  rejects([]{hotwords(Json{{"hotwords",Json::array({"hello:9"})}});});
  {
    char tokenPath[] = "wfloat-next-test-tokens-XXXXXX";
    int fd = mkstemp(tokenPath); require(fd >= 0, "Cannot stage test tokens"); close(fd);
    struct Cleanup { const char* path; ~Cleanup() { unlink(path); } } cleanup{tokenPath};
    { std::ofstream file(tokenPath); size_t i=0; for(const auto& piece:zipformerPieces()) file<<piece<<" "<<i++<<"\n"; }
    std::string temporary;
    { TemporaryVocabulary vocabulary(tokenPath); temporary=vocabulary.path; require(access(temporary.c_str(), F_OK)==0,"Vocabulary not written"); }
    require(access(temporary.c_str(), F_OK)!=0,"Temporary vocabulary leaked");
    { std::ofstream file(tokenPath); file<<"wrong 0\n"; }
    rejects([&]{TemporaryVocabulary vocabulary(tokenPath);});
  }
  {
    Tts t(Json{{"family","wfloat"},{"paths",{{"model_onnx","/model"},{"model_tokens","/tokens"},{"espeak_data","/espeak-ng-data"}}}});
    require(ttsModel=="/model" && ttsTokens=="/tokens" && ttsData=="/espeak-ng-data","Registry key mapping");
    auto units=t.request(Json{{"op","prepare"},{"text"," Hi🌍 ! "}}, {}, {});
    require(units[0]["textEnd"]==6 && units[1]["textStart"]==6 && units[1]["textEnd"]==8,"Preparation alignment");
    auto result=t.request(Json{{"op","synthesize"},{"text","clean"},{"voiceId","wise_elder_woman"},{"speed",1.5}}, {}, {});
    require(synthesizedText=="clean" && synthesizedVoice==13 && synthesizedSpeed==1.5f && result["samples"].size()==2,"Synthesis input forwarding");
    rejects([&]{t.request(Json{{"op","prepare"},{"text","mismatch"}}, {}, {});});
  }
  {
    Vad v(Json{{"family","silero-vad"},{"paths",{{"model","/model"}}}});
    Json frame={{"op","scoreVad"},{"samples",std::vector<float>(512,.5f)}};
    require(v.request(frame,{},{}).get<float>()==.25f,"Probability substituted with binary detector");
    require(vadInput.size()==576 && vadInput[0]==0 && vadInput[64]==.5f,"Initial VAD context");
    frame["samples"]=std::vector<float>(512,.75f); v.request(frame,{},{});
    require(vadInput[0]==.5f && vadInput[64]==.75f,"VAD recurrent context lost");
    vadThrows=true; rejects([&]{v.request(frame,{},{});}); vadThrows=false;
    rejects([&]{v.request(frame,{},{});});
    v.request(Json{{"op","resetVad"}}, {}, {}); v.request(frame,{},{});
    require(vadInput[0]==0,"Reset did not clear left context");
  }
  Json base={{"family","whisper"},{"paths",{{"tokens","/tokens"},{"encoder","/encoder"},{"decoder","/decoder"},{"joiner","/joiner"}}}};
  {
    Stt s(base); auto pcm=std::vector<float>(1600,.1f);
    s.request(Json{{"op","configure"},{"options",{{"timestamps","segment"}}}}, {}, {});
    require(whisperTimestamps,"Whisper timestamp configuration lost");
    auto output=s.request(Json{{"op","transcribe"},{"samples",pcm}}, {}, {});
    require(output["segments"][0]["timing"]["endMs"].get<double>()>9.9,"Transcript timing conversion");
    badTiming=true; rejects([&]{s.request(Json{{"op","transcribe"},{"samples",pcm}}, {}, {});}); badTiming=false;
    int before=decodes; pcm.assign(1600,0);
    require(s.request(Json{{"op","transcribe"},{"samples",pcm}}, {}, {})["text"]=="" && before==decodes,"Digital silence behavior");
    rejects([&]{s.request(Json{{"op","transcribe"},{"samples",Json::array()}}, {}, {});});
  }
  {
    base["family"]="zipformer-transducer"; Stt s(base);
    s.request(Json{{"op","openStream"}}, {}, {});
    rejects([&]{s.configure(Json::object());});
    auto out=s.request(Json{{"op","pushStream"},{"samples",Json::array({.1f})},{"finish",true}}, {}, {});
    require(s.stream->accepted==16001 && out["isEndpoint"]==true,"Finish omitted right-context padding");
    rejects([&]{s.request(Json{{"op","resetStream"}}, {}, {});});
    s.request(Json{{"op","closeStream"}}, {}, {}); s.request(Json{{"op","openStream"}}, {}, {});
    int checks=0;
    rejects([&]{s.request(Json{{"op","pushStream"},{"samples",Json::array({.1f})}}, {}, [&]{return ++checks>1;});});
    rejects([&]{s.request(Json{{"op","pushStream"},{"samples",Json::array({.1f})}}, {}, {});});
  }
  require(aliveTts==0 && aliveOffline==0 && aliveOnline==0 && aliveStream==0,"Speech handle leak");
  std::cout<<"PASS speech adapter ownership, registry paths, UTF-16 alignment, voice/speed, recurrent VAD scoring/reset, STT options/timing/padding/cancellation (fake engines)\n";
 } catch(const std::exception& e) { std::cerr<<e.what()<<'\n'; return 1; }
}
