// Native port of the web parser integration suite, using the RN implementation.
// Integration tests against the real vendored PEG parser and native event emitter.
#include "../LlmRuntime.cpp"
using namespace wfloat_next::llm_detail;
#include <iostream>
#include <fstream>
#include <sstream>
void require(bool condition, const char * message) { if (!condition) throw std::runtime_error(message); }
int main() {
    try {
        common_log_set_verbosity_thold(LOG_LEVEL_WARN);
        LOG_WRN("Wfloat native parser test: warning logger available\n");
        common_log_flush(common_log_main());
        std::ifstream schema_file(WFLOAT_SCHEMA_CASES);
        require(schema_file.good(), "Schema cases missing");
        Json schema_cases; schema_file >> schema_cases;
        for (const auto& test : schema_cases) {
            Json request = {{"schema", test.at("schema")}, {"validate", test.contains("value")}};
            if (test.contains("value")) request["value"] = test.at("value");
            std::unique_ptr<char, decltype(&std::free)> raw(wfloat_native_schema(request.dump().c_str()), &std::free);
            require(bool(raw), "Native schema bridge rejected a valid request envelope");
            auto actual = Json::parse(raw.get());
            if (actual.at("valid") != test.at("valid")) throw std::runtime_error("Schema mismatch: " + test.at("name").get<std::string>());
            for (const char* key : {"code", "instancePath", "schemaPath"}) {
                if (test.contains(key)) require(!actual.at("issues").empty() && actual.at("issues")[0].at(key) == test.at(key), "Schema issue detail mismatch");
            }
        }
        std::cout << "PASS " << schema_cases.size() << " native schema bridge cases\n";
        auto tools = common_json::parse(R"([{"type":"function","function":{"name":"weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}])");
        auto parser = build_chat_peg_parser([&](common_chat_peg_builder & p) {
            auto thinking = p.optional(p.literal("<think>") + p.reasoning(p.until("</think>")) + p.literal("</think>"));
            auto calls = p.standard_json_tools("<tool_call>", "</tool_call>", tools, true, false);
            return thinking + p.content(p.until("<tool_call>")) + p.optional(calls) + p.end();
        });
        Round round{}; round.parser.parser = parser;
        round.parser.reasoning_format = COMMON_REASONING_FORMAT_AUTO;
        const std::string prefix = "<think>Need weather.</think>Checking. ";
        const std::string first = "<tool_call>{\"name\":\"weather\",\"arguments\":{\"city\":\"Boston\"}}</tool_call>";
        const std::string second = "<tool_call>{\"name\":\"weather\",\"arguments\":{\"city\":\"Par";
        Json calls = Json::array(); std::string text, reasoning;
        for (char c : prefix + first + second) {
            round.raw += c;
            Json events;
            try { events = parse(round); } catch (...) { std::cerr << "raw=" << round.raw << " text=" << round.text << " reasoning=" << round.reasoning << "\n"; throw; }
            for (const auto & event : events) {
                if (event["type"] == "toolCall") calls.push_back(event);
                if (event["type"] == "text") text += event["text"].get<std::string>();
                if (event["type"] == "reasoning") reasoning += event["text"].get<std::string>();
            }
        }
        require(calls.size() == 1, "Must emit complete first call and withhold incomplete second call");
        require(Json::parse(calls[0]["rawArguments"].get<std::string>())["city"] == "Boston", "Raw arguments mismatch");
        require(text == "Checking. ", "Reasoning/protocol leaked into ordinary text");
        require(reasoning == "Need weather.", "Reasoning channel mismatch");
        round.stop = "cancelled";
        auto terminal = parse(round);
        require(terminal.size() == 2 && terminal[1]["type"] == "done", "Cancellation emitted incomplete tool");
        Round unicode{};
        for (char c : std::string("café/你好 \xF0\x9F\x8C\x8D")) { unicode.raw += c; auto encoded = parse(unicode).dump(); require(!encoded.empty(), "UTF-8 event serialization failed"); }
        require(unicode.text == unicode.raw, "UTF-8 token boundaries lost text");
        auto collect_text = [](const Json & events) {
            std::string text;
            for (const auto & event : events)
                if (event["type"] == "text") text += event["text"].get<std::string>();
            return text;
        };
        Round repeated{}; repeated.chat.additional_stops = {"###"};
        repeated.raw = "Hello ";
        std::string published = collect_text(parse(repeated));
        for (char c : std::string("###")) {
            repeated.raw += c;
            auto events = parse(repeated);
            require(collect_text(events).empty(), "Repeated stop prefix leaked to text events");
            published += collect_text(events);
        }
        require(published == "Hello " && repeated.stop == "complete", "Repeated stop marker failed");
        for (auto stops : {std::vector<std::string>{"bX", "aY"}, std::vector<std::string>{"aY", "bX"}}) {
            Round independent{}; independent.chat.additional_stops = stops;
            independent.raw = "ab";
            require(collect_text(parse(independent)) == "a", "Stops cumulatively shortened the buffer");
            independent.raw += "c";
            require(collect_text(parse(independent)) == "bc", "Unmatched prefix was not released");
        }
        for (auto stops : {std::vector<std::string>{"bX", "abY"}, std::vector<std::string>{"abY", "bX"}}) {
            Round longest{}; longest.chat.additional_stops = stops;
            longest.raw = "ab";
            require(collect_text(parse(longest)).empty(), "Longest hold across stop strings was not selected");
            longest.stop = "cancelled";
            require(collect_text(parse(longest)) == "ab", "Terminal unmatched prefix was not flushed");
        }
        std::ifstream mistral_file(WFLOAT_TEMPLATE_DIR "/Mistral-Small-3.2-24B-Instruct-2506.jinja");
        require(mistral_file.good(), "Mistral template fixture missing");
        std::stringstream mistral_source; mistral_source << mistral_file.rdbuf();
        Model mistral{};
        mistral.templates = common_chat_templates_init(nullptr, mistral_source.str(), "<s>", "</s>");
        auto history = Json::parse(R"({"messages":[
          {"role":"user","content":"Weather in Boston?"},
          {"role":"assistant","content":"","tool_calls":[
            {"id":"000000001","type":"function","function":{"name":"weather","arguments":"{\"city\":\"Boston\"}"}}]},
          {"role":"tool","tool_call_id":"000000001","content":"Sunny"}
        ]})");
        auto mistral_prompt = format(mistral, history).prompt;
        require(mistral_prompt.find("[CALL_ID]000000001") != std::string::npos,
            "Mistral assistant call ID was not preserved");
        require(mistral_prompt.find("[TOOL_RESULTS]000000001[TOOL_CONTENT]Sunny") != std::string::npos,
            "Mistral tool result did not round-trip with its call ID");
        history["messages"][1]["tool_calls"][0]["id"] = "call_uuid_0";
        history["messages"][2]["tool_call_id"] = "call_uuid_0";
        bool invalid_id_rejected = false;
        try { format(mistral, history); } catch (const std::exception &) { invalid_id_rejected = true; }
        require(invalid_id_rejected, "Expected native formatter to reject unnormalized long Mistral IDs");
        std::ifstream qwen_file(WFLOAT_TEMPLATE_DIR "/Qwen-Qwen3-0.6B.jinja");
        require(qwen_file.good(), "Qwen template fixture missing");
        std::stringstream qwen_source; qwen_source << qwen_file.rdbuf();
        Model qwen{};
        qwen.templates = common_chat_templates_init(nullptr, qwen_source.str(), "<|endoftext|>", "<|im_end|>");
        auto structured = Json::parse(R"({"messages":[{"role":"user","content":"Answer yes."}],
          "jsonSchema":{"type":"object","properties":{"answer":{"const":"yes"}},"required":["answer"],"additionalProperties":false}})");
        std::string disabled_prompt;
        for (bool thinking : {false, true}) {
            structured["reasoning"] = thinking;
            Round constrained{};
            constrained.chat = format(qwen, structured);
            require(constrained.chat.supports_thinking, "Qwen reasoning support missing");
            require(!constrained.chat.grammar.empty(), "Qwen structured output grammar missing");
            require(!constrained.chat.grammar_lazy, "Qwen structured output grammar must apply immediately");
            if (!thinking) disabled_prompt = constrained.chat.prompt;
            else require(disabled_prompt != constrained.chat.prompt, "Qwen reasoning switch did not change prompt");
            constrained.parser = common_chat_parser_params(constrained.chat);
            constrained.parser.reasoning_format = COMMON_REASONING_FORMAT_AUTO;
            constrained.parser.parser.load(constrained.chat.parser);
            std::string response = thinking ? "<think>Consider carefully.</think>" : "";
            response += R"({"answer":"yes"})";
            std::string answer, thoughts;
            for (char c : response) {
                constrained.raw += c;
                for (auto & event : parse(constrained)) {
                    if (event["type"] == "text") answer += event["text"].get<std::string>();
                    if (event["type"] == "reasoning") thoughts += event["text"].get<std::string>();
                }
            }
            constrained.stop = "complete";
            for (auto & event : parse(constrained)) {
                if (event["type"] == "text") answer += event["text"].get<std::string>();
                if (event["type"] == "reasoning") thoughts += event["text"].get<std::string>();
            }
            require(Json::parse(answer).at("answer") == "yes", "Qwen structured answer parsed incorrectly");
            require(thoughts == (thinking ? "Consider carefully." : ""), "Qwen reasoning leaked or disappeared");
        }
        for (auto schema : {Json::object(), Json(true)}) {
            structured["jsonSchema"] = schema;
            auto any_json = format(qwen, structured);
            require(!any_json.grammar.empty() && !any_json.grammar_lazy, "Any-JSON schema silently disabled Qwen JSON grammar");
        }
        const Json any_value = {{"type", Json::array({"object", "array", "string", "number", "boolean", "null"})}};
        auto grammar_for = [&](const Json & schema, bool tool) {
            auto request = structured;
            if (tool) {
                request.erase("jsonSchema");
                request["tools"] = Json::array({{{"type", "function"}, {"function", {
                    {"name", "echo"}, {"parameters", schema}}}}});
            } else request["jsonSchema"] = schema;
            return format(qwen, request).grammar;
        };
        // Report the separate known converter incompatibility without claiming
        // that normalization fixes allOf or locking its incorrect behavior in.
        auto string_intersection = Json::parse(R"({"type":"string","allOf":[{"minLength":2}]})");
        auto closed_object = Json::parse(R"({"type":"object","properties":{},"additionalProperties":false})");
        std::cout << "AUDIT string allOf grammar equals closed-object grammar: "
                  << (grammar_for(string_intersection, false) == grammar_for(closed_object, false))
                  << "; validator accepts ab: " << wfloat::schema::validate(string_intersection, "ab")["valid"] << "\n";
        for (bool tool : {false, true}) {
            for (auto properties : {Json::object(), Json{{"value", {{"type", "string"}}}}}) {
                Json omitted = {{"type", "object"}, {"properties", properties}};
                auto explicit_allow = omitted; explicit_allow["additionalProperties"] = true;
                require(grammar_for(omitted, tool) == grammar_for(explicit_allow, tool),
                    "Omitted additionalProperties grammar differs from explicit true");
            }
        }
        for (auto nested : {Json::object(), Json(true)}) {
            Json array_schema = {{"type", "array"}, {"items", nested}, {"minItems", 1}, {"maxItems", 1}};
            auto array_reference = array_schema; array_reference["items"] = any_value;
            require(grammar_for(array_schema, false) == grammar_for(array_reference, false),
                "Nested any-JSON array grammar differs from explicit reference");
            Json property_schema = {{"type", "object"}, {"properties", {{"value", nested}}},
                {"required", Json::array({"value"})}, {"additionalProperties", false}};
            auto property_reference = property_schema; property_reference["properties"]["value"] = any_value;
            for (bool tool : {false, true}) {
                require(grammar_for(property_schema, tool) == grammar_for(property_reference, tool),
                    "Nested any-JSON property/tool grammar differs from explicit reference");
            }
        }
        for (auto nested : {Json::object(), Json(true)}) {
            Json extras = {{"type", "object"}, {"properties", Json::object()}, {"additionalProperties", nested}};
            auto explicit_extras = extras;
            // true is already a supported converter sentinel; {} needs rewriting.
            explicit_extras["additionalProperties"] = nested == true ? Json(true) : any_value;
            for (bool tool : {false, true})
                require(grammar_for(extras, tool) == grammar_for(explicit_extras, tool),
                    "Additional-property schema grammar differs from explicit reference");
            for (const char * key : {"anyOf", "oneOf"}) {
                Json alternatives = {{key, Json::array({nested, Json{{"type", "string"}}})}};
                auto reference = alternatives; reference[key][0] = any_value;
                require(grammar_for(alternatives, false) == grammar_for(reference, false),
                    "Alternative any-JSON grammar differs from explicit reference");
            }
        }
        auto locations = Json::parse(R"({
            "properties":{"value":{},"items":true,"blocked":false},
            "$defs":{"value":{},"items":true,"blocked":false},
            "items":true,"additionalProperties":false,"not":{"not":true},
            "anyOf":[{},true,false],"allOf":[{},true,false],"oneOf":[{},true,false],
            "const":{"properties":{},"items":true,"additionalProperties":false},
            "enum":[{},true,false,{"items":{}}],
            "default":{"properties":{},"items":true},"examples":[{},true,{"not":{}}]
        })");
        auto original_locations = locations;
        normalize_grammar_schema(locations);
        for (const char * key : {"const", "enum", "default", "examples"})
            require(locations[key] == original_locations[key], "Normalization rewrote literal data");
        for (const char * key : {"properties", "$defs"}) {
            require(locations[key]["value"] == any_value && locations[key]["items"] == any_value,
                "Schema map entries were not normalized");
            require(locations[key]["blocked"] == false, "Schema map false was rewritten");
        }
        require(locations["items"] == any_value && locations["not"]["not"] == any_value,
            "Single schema locations were not normalized");
        require(locations["additionalProperties"] == false, "Explicit additionalProperties:false changed");
        for (const char * key : {"anyOf", "allOf", "oneOf"})
            require(locations[key][0] == any_value && locations[key][1] == any_value && locations[key][2] == false,
                "Schema array locations were not normalized correctly");
        for (auto literal_schema : {Json{{"const", original_locations["const"]}},
                                    Json{{"enum", original_locations["enum"]}}}) {
            auto normalized = literal_schema; normalize_grammar_schema(normalized);
            require(normalized == literal_schema, "Literal-only schema changed");
            require(!grammar_for(literal_schema, false).empty(), "Literal-preserving schema lost its grammar");
        }
        auto normalized_intersection = string_intersection;
        normalize_grammar_schema(normalized_intersection);
        require(normalized_intersection == string_intersection, "Normalization changed the unresolved allOf case");
        structured["jsonSchema"] = false;
        bool false_rejected = false;
        try { format(qwen, structured); } catch (const std::exception &) { false_rejected = true; }
        require(false_rejected, "False schema silently disabled JSON grammar");
        // Exercise overlapping complete stops and unmatched UTF-8 prefixes at a
        // terminal boundary, including a whole stop delivered in one token.
        for (auto stops : {std::vector<std::string>{"END", "ENDING"}, std::vector<std::string>{"ENDING", "END"}}) {
            Round stopped{}; stopped.chat.additional_stops = stops;
            stopped.raw = "hello ENDING ignored";
            require(collect_text(parse(stopped)) == "hello " && stopped.stop == "complete", "Overlapping complete stop failed");
        }
        Round utf_stop{}; utf_stop.chat.additional_stops = {"你好!"};
        utf_stop.raw = "safe 你好";
        require(collect_text(parse(utf_stop)) == "safe ", "UTF-8 stop prefix leaked");
        utf_stop.stop = "maxTokens";
        require(collect_text(parse(utf_stop)) == "你好", "Terminal UTF-8 stop prefix not released");
        std::cout << "PASS complete/incomplete tools, reasoning separation, incremental parser, cancellation, UTF-8, longest/independent template stop prefixes, Mistral call/result ID round-trip, Qwen reasoning + schema, overlapping/UTF-8 stops, recursive any-JSON/tool grammar and object defaults, literal preservation\n";
    } catch (const std::exception & e) { std::cerr << e.what() << '\n'; return 1; }
}
