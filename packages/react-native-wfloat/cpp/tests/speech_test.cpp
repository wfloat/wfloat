// Contract tests use explicit fake engines. These do NOT verify ONNX inference.
#include "../SpeechRuntime.cpp"
#include <iostream>
#include <cstring>
using namespace wfloat_next;
namespace {
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
template<class F> void rejects(F fn) { bool threw = false; try { fn(); } catch (const std::exception&) { threw = true; } require(threw, "Expected failure"); }
int offlineCreations=0, offlineReconfigurations=0;
std::string offlineType; int offlineFeatures=0;
Json capturedWhisper, capturedMoonshine, capturedOnline; int onlineCreations=0;
std::string safe(const char* p) { return p ? p : ""; }
int aliveTts=0, aliveOffline=0, aliveOnline=0, aliveStream=0, decodes=0;
bool badTiming=false, vadThrows=false, whisperTimestamps=false;
float segmentStart=0, segmentDuration=.01f;
const char* segmentText="hello";
std::vector<float> vadInput;
std::string preparedText, synthesizedText, ttsModel, ttsTokens, ttsData;
std::string capturedHotwords;
int synthesizedVoice=-1;
float synthesizedSpeed=0, synthesizedSilence=0;
Json standardTts; int ttsCreations=0, fakeSpeakers=1; bool failTts=false, staleKokoro=false;
Json pocketExtra; int pocketSteps=0, pocketReference=0;
}
struct SherpaOnnxOfflineTts { int rate=22050, speakers=1; };
struct SherpaOnnxOfflineRecognizer {};
struct SherpaOnnxOnlineRecognizer {};
struct SherpaOnnxOfflineStream {};
struct SherpaOnnxOnlineStream { mutable int pending=0, accepted=0; mutable bool finished=false; };
extern "C" {
const SherpaOnnxWave* SherpaOnnxReadWave(const char*) {
  static float samples[] = {.1f,.2f};
  auto wave = new SherpaOnnxWave{}; wave->samples=samples; wave->num_samples=2; wave->sample_rate=24000; return wave;
}
void SherpaOnnxFreeWave(const SherpaOnnxWave* wave) { delete wave; }

const SherpaOnnxOfflineTts* SherpaOnnxCreateOfflineTts(const SherpaOnnxOfflineTtsConfig* c) {
  require(std::isfinite(c->silence_scale) && c->silence_scale >= .01f && c->silence_scale <= 10.f,"TTS silence_scale must use a valid explicit runtime default");
  require(c->max_num_sentences > 0,"TTS sentence limit must be positive");
  ++ttsCreations;
  if (c->model.kitten.model) {
    standardTts={{"model",safe(c->model.kitten.model)},{"tokens",safe(c->model.kitten.tokens)},
      {"voices",safe(c->model.kitten.voices)},{"data",safe(c->model.kitten.data_dir)},
      {"length",c->model.kitten.length_scale},{"silence",c->silence_scale},
      {"rules",safe(c->rule_fsts)},{"fars",safe(c->rule_fars)}};
    ++aliveTts; return new SherpaOnnxOfflineTts{24000,8};
  }
  if (c->model.kokoro.model || c->model.vits.model) {
    require(aliveTts==0,"Overlapping standard TTS sessions");
    const bool k = c->model.kokoro.model;
    if (k) require(c->silence_scale==1.f,"Kokoro model must preserve generated pauses");
    standardTts={{"family",k?"kokoro":"piper"},{"model",safe(k?c->model.kokoro.model:c->model.vits.model)},
      {"tokens",safe(k?c->model.kokoro.tokens:c->model.vits.tokens)}, {"data",safe(k?c->model.kokoro.data_dir:c->model.vits.data_dir)},
      {"voices",safe(c->model.kokoro.voices)},{"lexicon",safe(c->model.kokoro.lexicon)},{"lang",safe(c->model.kokoro.lang)},
      {"rules",safe(c->rule_fsts)},{"noise",c->model.vits.noise_scale},{"noiseW",c->model.vits.noise_scale_w},
      {"length",k?c->model.kokoro.length_scale:c->model.vits.length_scale},{"sentences",c->max_num_sentences}};
    if (failTts) return nullptr;
    ++aliveTts; return new SherpaOnnxOfflineTts{k?24000:22050,k?(staleKokoro?53:54):fakeSpeakers};
  }
  if (c->model.pocket.lm_main) { require(std::string(c->model.pocket.lm_main)=="/lm_main", "Pocket asset mapping"); ++aliveTts; return new SherpaOnnxOfflineTts; }
  ttsModel=c->model.wfloat.model; ttsTokens=c->model.wfloat.tokens; ttsData=c->model.wfloat.data_dir;
  ++aliveTts; return new SherpaOnnxOfflineTts;
}
void SherpaOnnxDestroyOfflineTts(const SherpaOnnxOfflineTts* p) { if(p) --aliveTts; delete p; }
int32_t SherpaOnnxOfflineTtsSampleRate(const SherpaOnnxOfflineTts* p) { return p->rate; }
int32_t SherpaOnnxOfflineTtsNumSpeakers(const SherpaOnnxOfflineTts* p) { return p->speakers; }
const char* SherpaOnnxOfflineTtsWfloatPrepareText(const SherpaOnnxOfflineTts*, const char* text, const char*, float) {
  preparedText = text;
  return strdup(Json{{"text",Json::array({" Hi🌍 ", "! "})},{"text_clean",Json::array({"clean", "!"})}}.dump().c_str());
}
void SherpaOnnxOfflineTtsWfloatFreePreparedText(const char* s) { free(const_cast<char*>(s)); }
const SherpaOnnxGeneratedAudio* SherpaOnnxOfflineTtsGenerateWithConfig(const SherpaOnnxOfflineTts* engine, const char* text,
  const SherpaOnnxGenerationConfig* c, SherpaOnnxGeneratedAudioProgressCallbackWithArg callback, void* arg) {
  if(c->extra) { pocketExtra=Json::parse(c->extra); pocketSteps=c->num_steps; pocketReference=c->reference_audio_len; if (!pocketExtra.contains("lang")) require(c->reference_sample_rate==24000,"Pocket reference rate"); }
  synthesizedText=text; synthesizedVoice=c->sid; synthesizedSpeed=c->speed; synthesizedSilence=c->silence_scale;
  static float pcm[] = {.1f,.2f}; callback(pcm,2,1,arg);
  auto result = new SherpaOnnxGeneratedAudio{}; result->samples=pcm; result->n=2; result->sample_rate=engine->rate; return result;
}
void SherpaOnnxDestroyOfflineTtsGeneratedAudio(const SherpaOnnxGeneratedAudio* a) { delete a; }
const SherpaOnnxOfflineRecognizer* SherpaOnnxCreateOfflineRecognizer(const SherpaOnnxOfflineRecognizerConfig* c) {
  capturedWhisper={{"language",safe(c->model_config.whisper.language)},{"task",safe(c->model_config.whisper.task)}};
  const auto& moon = c->model_config.moonshine;
  capturedMoonshine={{"preprocessor",safe(moon.preprocessor)},{"encoder",safe(moon.encoder)},
    {"uncached_decoder",safe(moon.uncached_decoder)},{"cached_decoder",safe(moon.cached_decoder)},
    {"merged_decoder",safe(moon.merged_decoder)},{"tokens",safe(c->model_config.tokens)}};
  ++offlineCreations; offlineType=c->model_config.model_type ? c->model_config.model_type : ""; offlineFeatures=c->feat_config.feature_dim;
  if (offlineType=="nemo_transducer") require(std::string(c->model_config.transducer.joiner)=="/joiner", "Parakeet joiner mapping");
  whisperTimestamps=c->model_config.whisper.enable_segment_timestamps; ++aliveOffline; return new SherpaOnnxOfflineRecognizer;
}
void SherpaOnnxOfflineRecognizerSetConfig(const SherpaOnnxOfflineRecognizer* p, const SherpaOnnxOfflineRecognizerConfig* c) {
  require(p!=nullptr && safe(c->model_config.model_type)=="whisper", "SetConfig must target existing Whisper only");
  ++offlineReconfigurations;
  capturedWhisper={{"language",safe(c->model_config.whisper.language)},{"task",safe(c->model_config.whisper.task)}};
  whisperTimestamps=c->model_config.whisper.enable_segment_timestamps;
}
void SherpaOnnxDestroyOfflineRecognizer(const SherpaOnnxOfflineRecognizer* p) { if(p) --aliveOffline; delete p; }
const SherpaOnnxOnlineRecognizer* SherpaOnnxCreateOnlineRecognizer(const SherpaOnnxOnlineRecognizerConfig* c) {
  ++onlineCreations;
  capturedOnline={{"type",safe(c->model_config.model_type)},{"method",safe(c->decoding_method)},
    {"unit",safe(c->model_config.modeling_unit)},{"bpe",safe(c->model_config.bpe_vocab)},
    {"score",c->hotwords_score},{"featureDim",c->feat_config.feature_dim},{"endpoint",c->enable_endpoint}};
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
  texts[0]=segmentText; starts[0]=segmentStart; durations[0]=badTiming?0:segmentDuration;
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
    Json paths;
    for (const char* name : {"lm_main","lm_flow","encoder","decoder","text_conditioner","vocab_json","token_scores_json","reference_audio"}) paths[name]=std::string("/")+name;
    Tts t(Json{{"family","pocket"},{"paths",paths}});
    auto units=t.request(Json{{"op","prepare"},{"text",std::string(199,'a')+"🌍 hello!"}}, {}, {});
    require(units.size()==2 && units[0]["textEnd"]==201 && units[1]["textStart"]==201,"Pocket unicode bounds");
    Json input={{"op","synthesize"},{"text","hello"}};
    t.request(input,{},{});
    require(pocketSteps==5 && pocketReference==2 && !pocketExtra.contains("seed"),"Pocket defaults");
    input["seed"]=2147483647; input["temperature"]=0; input["inferenceSteps"]=2;
    input["referenceAudio"]={{"samples",std::vector<float>(3,.2f)},{"sampleRate",24000}};
    t.request(input,{},{});
    require(pocketSteps==2 && pocketReference==3 && pocketExtra["seed"]==2147483647 && pocketExtra["temperature"]==0,"Pocket forwarding");
    input["voiceId"]="alba"; rejects([&]{t.request(input,{},{});}); input.erase("voiceId");
    for(auto value : {-1.0,2147483648.0,0.5}) { input["seed"]=value; rejects([&]{t.request(input,{},{});}); }
    input.erase("seed"); for (double value : {1e-50, 1e-40}) { input["temperature"]=value; rejects([&]{t.request(input,{},{});}); }
    input["temperature"]=std::numeric_limits<float>::min(); t.request(input,{},{}); input["temperature"]=0; input["inferenceSteps"]=0; rejects([&]{t.request(input,{},{});});
    input["inferenceSteps"]=5; input["referenceAudio"]["samples"]=std::vector<float>(240001,0); rejects([&]{t.request(input,{},{});});
  }
  {
    char configPath[] = "/tmp/wfloat-piper-config-XXXXXX";
    int fd=mkstemp(configPath); require(fd>=0,"Piper fixture"); close(fd);
    struct Cleanup { const char* path; ~Cleanup(){unlink(path);} } cleanup{configPath};
    for (const auto& entry : std::vector<std::pair<std::string,std::string>>{
        {"en_US-lessac-medium","en-us"},{"en_US-amy-medium","en-us"},{"en_GB-alba-medium","en-gb-x-rp"},
        {"de_DE-thorsten-medium","de"},{"fr_FR-siwis-medium","fr"},{"en_US-libritts-high","en-us"},{"en_US-ryan-medium","en-us"}}) {
      fakeSpeakers=entry.first=="en_US-libritts-high"?904:1;
      Json metadata={{"audio",{{"sample_rate",22050}}},{"num_speakers",fakeSpeakers},{"espeak",{{"voice",entry.second}}},
        {"phoneme_type","espeak"},{"speaker_id_map",{{"last",fakeSpeakers-1}}},{"inference",{{"noise_scale",.667},{"noise_w",.8},{"length_scale",1}}}};
      {std::ofstream out(configPath);out<<metadata;}
      Json load={{"family","piper"},{"modelId","rhasspy/piper-"+entry.first},{"paths",{{"model_onnx","/piper"},{"model_tokens","/tokens"},{"model_config",configPath},{"espeak_data","/data"}}}};
      {
        Tts t(load); require(t.info()["metadata"]==metadata && t.info()["numSpeakers"]==fakeSpeakers,"Piper metadata response");
        require(standardTts["model"]=="/piper" && standardTts["tokens"]=="/tokens" && standardTts["data"]=="/data" && standardTts["sentences"]==1,"Piper VITS paths");
        require(std::abs(standardTts["noise"].get<float>()-.667f)<1e-6f && standardTts["length"]==1,"Piper scales");
        Json input={{"op","synthesize"},{"text","Grüß dich!"},{"voiceId",fakeSpeakers-1},{"speed",1.25}};
        t.request(input,{},{}); require(synthesizedVoice==fakeSpeakers-1 && synthesizedSpeed==1.25f,"Piper voice/speed forwarding");
        for(double id:{-1.,.5,static_cast<double>(fakeSpeakers)}){input["voiceId"]=id;rejects([&]{t.request(input,{},{});});}
        input["voiceId"]=0;input["referenceAudio"]=Json::object();rejects([&]{t.request(input,{},{});});
      }
      metadata.erase("phoneme_type"); {std::ofstream out(configPath);out<<metadata;}
      if (entry.first=="en_US-libritts-high") { Tts t(load); require(t.info()["numSpeakers"]==904,"Pinned LibriTTS absent phoneme_type"); }
      else rejects([&]{Tts t(load);});
      metadata["phoneme_type"]="text"; {std::ofstream out(configPath);out<<metadata;} rejects([&]{Tts t(load);});
      metadata["phoneme_type"]="espeak";
      metadata["espeak"]["voice"]="wrong";{std::ofstream out(configPath);out<<metadata;}
      int before=ttsCreations;rejects([&]{Tts t(load);});require(before==ttsCreations,"Invalid Piper config reached engine");
    }
  }
  {
    Json paths; for(const auto key:{"model_onnx","model_tokens","model_voices","lexicon_zh","rule_date_zh","rule_number_zh","rule_phone_zh","espeak_data"}) paths[key]=std::string("/")+key;
    Json load={{"family","kokoro"},{"modelId","hexgrad/Kokoro-82M"},{"paths",paths}};
    staleKokoro=true;rejects([&]{Tts t(load);});staleKokoro=false;require(aliveTts==0,"Stale Kokoro leaked");
    Tts t(load); require(standardTts["rules"]=="" && standardTts["lexicon"]=="/lexicon_zh","Kokoro initial routing");
    const auto generate=[&](int id){
      auto result=t.request(Json{{"op","synthesize"},{"text","123 hello"},{"voiceId",id}}, {}, {});
      require(synthesizedSilence==1.f,"Kokoro generation must preserve generated pauses");
      return result;
    };
    generate(21);require(pocketExtra["lang"]=="en","British route");
    generate(45);require(pocketExtra["lang"]=="en-us" && standardTts["rules"]=="/rule_date_zh,/rule_number_zh,/rule_phone_zh","Chinese route");
    int before=ttsCreations; generate(46);require(before==ttsCreations,"Chinese unnecessarily reloaded");
    generate(30);require(pocketExtra["lang"]=="fr" && standardTts["rules"]=="","Chinese rules leaked");
    for(int id=37;id<42;++id) rejects([&]{generate(id);});
    for (int id=42;id<45;++id) { generate(id); require(pocketExtra["lang"]=="pt","Brazilian Portuguese eSpeak route"); }
    generate(53);require(pocketExtra["lang"]=="es","Voice 53 mapping");
    failTts=true;rejects([&]{generate(45);});require(aliveTts==0,"Failed replacement retained old engine");
    failTts=false;generate(45);require(aliveTts==1,"Replacement did not recover");
  }
  rejects([]{Tts t(Json{{"family","kitten"}});});
  for (const auto* id : {"KittenML/kitten-tts-nano-0.8", "KittenML/kitten-tts-mini-0.8"}) {
    Json load={{"family","kitten"},{"modelId",id},{"paths",{{"model_onnx","/kitten"},{"model_tokens","/tokens"},{"model_voices","/voices"},{"espeak_data","/data"}}}};
    Tts t(load);
    require(standardTts==Json{{"model","/kitten"},{"tokens","/tokens"},{"voices","/voices"},{"data","/data"},{"length",1},{"silence",1},{"rules",""},{"fars",""}},"Kitten model contract");
    require(t.info()==Json{{"sampleRate",24000},{"numSpeakers",8}},"Kitten metadata");
    const std::string raw=" Dr. Smith paid $12.50; don't split https://example.com. 🌍 ";
    auto units=t.request(Json{{"op","prepare"},{"text",raw}}, {}, {});
    require(units==Json::array({{{"text",raw},{"textStart",0},{"textEnd",utf16Length(raw)}}}),"Kitten raw range");
    for(int sid=0;sid<8;++sid) {
      auto out=t.request(Json{{"op","synthesize"},{"text",raw},{"voiceId",sid},{"speed",1.25}}, {}, {});
      require(synthesizedText==raw && synthesizedVoice==sid && synthesizedSpeed==1.25f && synthesizedSilence==1.f,"Kitten generation must preserve raw text/speed and set silence=1");
      require(out.at("samples").size()==2,"Kitten SDK trimmed engine output");
    }
    rejects([&]{t.request(Json{{"op","synthesize"},{"text",raw},{"voiceId",8}}, {}, {});});
    rejects([&]{t.request(Json{{"op","synthesize"},{"text",raw},{"referenceAudio",Json::object()}}, {}, {});});
    std::string large;for(int i=0;i<65536;++i)large+="🌍";
    t.request(Json{{"op","synthesize"},{"text",large}}, {}, {});
    require(synthesizedText==large,"Kitten silently truncated multibyte raw input");
    rejects([&]{t.request(Json{{"op","synthesize"},{"text",large+"x"}}, {}, {});});
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
    Stt s(base);
    s.configure(Json{{"timestamps","segment"}});
    const Json request={{"op","transcribe"},{"samples",std::vector<float>(8*16000,.1f)}};
    auto timing=[&](float start,float duration) {
      segmentStart=start;segmentDuration=duration;
      return s.request(request,{},{});
    };
    auto out=timing(7.6f,1.f);
    require(out["text"]=="hello" && out["segments"][0]["text"]=="hello","Clamp changed transcript");
    require(out["segments"][0]["timing"]["startMs"]==static_cast<double>(7.6f)*1000 &&
            out["segments"][0]["timing"]["endMs"]==8000,"8s segment overshoot not clamped locally");
    require(timing(7.f,1.02f)["segments"][0]["timing"]["endMs"]==8000,"20ms roundoff escaped clamp");
    require(timing(1.f,2.f)["segments"][0]["timing"]["endMs"]==3000,"In-range timing changed");
    require(timing(1.f,100.f)["segments"][0]["timing"]["endMs"]==8000,"Unexpected overshoot threshold");
    rejects([&]{timing(8.f,.5f);});
    rejects([&]{timing(8.1f,.5f);});
    rejects([&]{timing(1.f,0.f);});
    rejects([&]{timing(2.f,-1.f);});
    rejects([&]{timing(-1.f,2.f);});
    for(float invalid:{std::numeric_limits<float>::quiet_NaN(),std::numeric_limits<float>::infinity()}) {
      rejects([&]{timing(invalid,1.f);});
      rejects([&]{timing(1.f,invalid);});
    }
    segmentText=" ";
    require(timing(8.f,0.f)["segments"][0]["timing"]["endMs"]==8000,"Empty endpoint rejected");
    rejects([&]{timing(8.1f,0.f);});
    segmentText="hello";
    s.configure(Json::object());
    out=timing(2.f,-1.f);
    require(out["text"]=="hello" && !out.contains("segments"),"Text-only decode inspected timing");
    segmentStart=0;segmentDuration=.01f;
  }
  {
    base["family"]="parakeet-tdt"; Stt s(base);
    require(offlineType=="nemo_transducer" && offlineFeatures==128, "Parakeet config");
    int before=offlineCreations;
    s.configure(Json::object()); s.configure(Json{{"task","transcribe"}});
    require(offlineCreations==before, "Unchanged Parakeet config reloaded model");
    rejects([&]{s.configure(Json{{"language","en"}});});
    rejects([&]{s.configure(Json{{"task","translate"}});});
    rejects([&]{s.configure(Json{{"hotwords",Json::array()}});});
    auto output=s.request(Json{{"op","transcribe"},{"samples",std::vector<float>(1600,.1f)}}, {}, {});
    require(output.contains("text"), "Parakeet decode result");
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
  for (const auto* id : {"openai/whisper-tiny", "openai/whisper-base", "openai/whisper-small"}) {
    base["family"]="whisper"; base["modelId"]=id; Stt s(base);
    require(capturedWhisper["language"]=="" && capturedWhisper["task"]=="transcribe", "Whisper autodetection default");
    int before=offlineCreations, updates=offlineReconfigurations; const auto* handle=s.offline.get(); s.configure(Json{{"task","transcribe"}});
    require(offlineCreations==before, "Whisper default reload");
    s.configure(Json{{"language","FR-fr"},{"task","translate"},{"timestamps","segment"}});
    require(capturedWhisper["language"]=="fr" && capturedWhisper["task"]=="translate" && whisperTimestamps, "Whisper translation/language forwarding");
    before=offlineCreations; s.configure(Json{{"language","fr"},{"task","translate"},{"timestamps","segment"}});
    require(offlineCreations==before, "Normalized Whisper options reloaded");
    s.configure(Json{{"language","fr"},{"task","transcribe"},{"timestamps","segment"}});
    require(offlineCreations==before && capturedWhisper["task"]=="transcribe", "Whisper task change replaced recognizer");
    s.configure(Json{{"language","zh-CN"}}); require(capturedWhisper["language"]=="zh", "Chinese hint forwarding");
    require(!whisperTimestamps,"Whisper omitted timestamps must disable them");
    s.configure(Json{{"language","en"}});
    s.configure(Json::object());
    require(capturedWhisper["language"]=="" && capturedWhisper["task"]=="transcribe" && !whisperTimestamps,"Whisper en-to-auto reset lost defaults");
    require(offlineCreations==before && s.offline.get()==handle && offlineReconfigurations==updates+5,"Whisper options must reuse the loaded recognizer");
    rejects([&]{s.configure(Json{{"language","zz"}});});
    rejects([&]{s.configure(Json{{"language","auto"}});});
    rejects([&]{s.configure(Json{{"task","summarize"}});});
    rejects([&]{s.configure(Json{{"hotwords",Json::array()}});});
    rejects([&]{s.configure(Json{{"timestamps","word"}});});
  }
  {
    base["modelId"]="openai/whisper-tiny-en"; Stt s(base);
    require(capturedWhisper["language"]=="en", "English Whisper default changed");
    rejects([&]{s.configure(Json{{"task","translate"}});});
    rejects([&]{s.configure(Json{{"language","fr"}});});
  }
  {
    Json moon={{"family","moonshine"},{"modelId","moonshine-ai/moonshine-base"},
      {"paths",{{"encoder","/encoder.ort"},{"merged_decoder","/decoder.ort"},{"tokens","/v2-tokens"},
        {"preprocessor","/must-not-use"},{"uncached_decoder","/must-not-use"},{"cached_decoder","/must-not-use"}}}};
    Stt s(moon);
    require(capturedMoonshine==Json{{"encoder","/encoder.ort"},{"merged_decoder","/decoder.ort"},{"tokens","/v2-tokens"},
      {"preprocessor",""},{"uncached_decoder",""},{"cached_decoder",""}}, "Moonshine v2 paths/frontend config");
    for (const auto* role : {"encoder", "merged_decoder", "tokens"}) {
      auto missing=moon; missing["paths"].erase(role); rejects([&]{Stt rejected(missing);});
    }
    rejects([&]{s.configure(Json{{"language","fr"}});});
    rejects([&]{s.configure(Json{{"hotwords",Json::array()}});});
    moon["modelId"]="UsefulSensors/moonshine-tiny";
    moon["paths"]["preprocessor"]="/pre"; moon["paths"]["uncached_decoder"]="/uncached"; moon["paths"]["cached_decoder"]="/cached";
    Stt tiny(moon); require(capturedMoonshine["preprocessor"]=="/pre" && capturedMoonshine["merged_decoder"]=="", "Moonshine v1 regression");
  }
  {
    char directory[]="/tmp/wfloat-moonshine-cache-XXXXXX";
    require(mkdtemp(directory)!=nullptr,"Moonshine cache fixture");
    const std::string encoder=std::string(directory)+"/encoder-hash", decoder=std::string(directory)+"/decoder-hash";
    for(const auto& path:{encoder,decoder}) { std::ofstream out(path); out<<"0000ORTM"; }
    Json moon={{"family","moonshine"},{"modelId","moonshine-ai/moonshine-base"},
      {"paths",{{"encoder",encoder},{"merged_decoder",decoder},{"tokens","/tokens"}}}};
    std::string aliasEncoder,aliasDecoder;
    {
      Stt s(moon);aliasEncoder=capturedMoonshine["encoder"];aliasDecoder=capturedMoonshine["merged_decoder"];
      require(aliasEncoder!=encoder && aliasEncoder.substr(aliasEncoder.size()-4)==".ort","Opaque Moonshine encoder suffix");
      require(aliasDecoder!=decoder && aliasDecoder.substr(aliasDecoder.size()-4)==".ort","Opaque Moonshine decoder suffix");
      require(access(aliasEncoder.c_str(),R_OK)==0 && access(aliasDecoder.c_str(),R_OK)==0,"Moonshine aliases unavailable");
      s.configure(Json{{"language","en"}});
      require(capturedMoonshine["encoder"]==aliasEncoder && capturedMoonshine["merged_decoder"]==aliasDecoder,"Configure replaced live aliases");
    }
    require(access(aliasEncoder.c_str(),F_OK)!=0 && access(aliasDecoder.c_str(),F_OK)!=0,"Moonshine unload leaked aliases");
    require(access(encoder.c_str(),R_OK)==0 && access(decoder.c_str(),R_OK)==0,"Moonshine unload removed cached models");
    { Stt reloaded(moon); require(capturedMoonshine["encoder"]!=aliasEncoder,"Reload reused stale alias"); }
    unlink(encoder.c_str());unlink(decoder.c_str());require(rmdir(directory)==0,"Moonshine aliases leaked directories");
  }
  for (const auto* id : {"shaojieli/streaming-zipformer-fr", "k2-fsa/streaming-zipformer-zh-en"}) {
    base["modelId"]=id; base["family"]="zipformer-transducer"; Stt s(base);
    require(capturedOnline==Json{{"type","zipformer"},{"method","greedy_search"},{"unit",""},{"bpe",""},{"score",0},{"featureDim",80},{"endpoint",1}}, "Zipformer baseline config");
    int before=onlineCreations;
    s.configure(Json{{"language",std::string(id).find("-fr")!=std::string::npos ? "fr-FR" : "zh-CN"}});
    require(onlineCreations==before, "Compatibility hint unnecessarily reloaded Zipformer");
    rejects([&]{s.configure(Json{{"language","de"}});});
    rejects([&]{s.configure(Json{{"task","translate"}});});
    rejects([&]{s.configure(Json{{"hotwords",Json::array({"hello"})}});});
    rejects([&]{s.configure(Json{{"hotwords",Json::array()}});});
    s.request(Json{{"op","openStream"}}, {}, {});
    auto out=s.request(Json{{"op","pushStream"},{"samples",Json::array({.1f})},{"finish",true}}, {}, {});
    require(out["isEndpoint"]==true && s.stream->accepted==16001, "New Zipformer endpoint/final padding");
  }
  require(aliveTts==0 && aliveOffline==0 && aliveOnline==0 && aliveStream==0,"Speech handle leak");
  std::cout<<"PASS speech adapter ownership, registry paths, UTF-16 alignment, voice/speed, recurrent VAD scoring/reset, STT options/timing/padding/cancellation (fake engines)\n";
 } catch(const std::exception& e) { std::cerr<<e.what()<<'\n'; return 1; }
}
