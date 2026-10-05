// Optional real-GGUF integration test. Speech factory is deliberately unavailable.
#include "NextRuntime.h"
#include "Backend.h"
#include <atomic>
#include <future>
#include <iostream>
#include <vector>
namespace wfloat_next {
std::unique_ptr<Backend> makeSpeech(const Json&, const Cancel&) { throw std::runtime_error("Speech is outside the real-GGUF smoke test."); }
}
using namespace wfloat_next;
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
int main(int argc, char** argv) {
  if (argc != 2) { std::cerr << "Usage: next-llm-smoke /absolute/model.gguf\n"; return 2; }
  try {
    Runtime runtime;
    for (const char* id : {"a", "b"}) {
      auto info = Json::parse(runtime.request(Json{{"op","load"},{"instanceId",id},{"task","llm"},
        {"paths",{{"model",argv[1]}}},{"options",{{"contextSize",256},{"numThreads",2}}}}.dump()));
      require(info["contextSize"].get<int>() >= 256, "Context size mismatch");
    }
    auto request = Json::parse(R"({"messages":[{"role":"user","content":"Say hello in one short sentence."}],"maxTokensPerRound":24,"temperature":0,"seed":7})");
    auto counted = Json::parse(runtime.request(Json{{"op","count"},{"instanceId","a"},{"request",request}}.dump()));
    require(counted.get<int>()>0, "Input count was empty");
    auto generate = [&](const char* id, bool stop) {
      Json events = Json::array(); bool cancelled = false;
      runtime.request(Json{{"op","generateRound"},{"instanceId",id},{"request",request}}.dump(),
        [&](const std::string& event) { auto parsed=Json::parse(event); events.push_back(parsed); if(stop && parsed["type"]=="usage") cancelled=true; },
        [&]{return cancelled;});
      require(!events.empty() && events.back()["type"]=="done", "Missing terminal event");
      require(events.back()["inputTokens"]==counted,"Count/generation formatting mismatch");
      if(stop) require(events.back()["stopReason"]=="cancelled","Cancellation not acknowledged");
      else {
        std::string text;
        for(const auto& event:events) if(event["type"]=="text") text+=event["text"].get<std::string>();
        require(!text.empty(),"No generated text");
        std::cout<<id<<": "<<text<<"\n";
      }
      return events.back();
    };
    auto a=std::async(std::launch::async,[&]{return generate("a",false);});
    auto b=std::async(std::launch::async,[&]{return generate("b",false);});
    auto first=a.get(); auto second=b.get();
    require(first["cachedInputTokens"]==0 && second["cachedInputTokens"]==0,"Independent model cache leaked");
    auto again=generate("a",false);
    require(again["cachedInputTokens"].get<int>()>0,"Repeated prompt did not reuse cache");
    generate("b",true);
    auto schema=Json::parse(runtime.request(Json{{"op","schema"},{"instanceId","a"},{"schema",{{"type","integer"}}},{"value","x"},{"validate",true}}.dump()));
    require(schema["valid"]==false && !schema["issues"].empty(),"Native value validation bypassed");
    for(const char* id:{"a","b"}) runtime.request(Json{{"op","unload"},{"instanceId",id}}.dump());
    std::cout<<"PASS real GGUF: independent concurrent models, chat generation, count, prefix cache, cancellation, schema, unload\n";
  } catch(const std::exception& e) { std::cerr<<e.what()<<'\n'; return 1; }
}
