// Native port of wfloat-web/native/llama-wasm/round_runtime.cpp.
// Keep parser, grammar, sampling and cache behavior synchronized with that source.
#include "Backend.h"
#include "LlmAssets.h"
#include "LlmModelParams.h"
#include <cstdio>
#include "llama.h"
#include "common.h"
#include "chat.h"
#include "chat-peg-parser.h"
#include "sampling.h"
#include "log.h"
#include "schema/validator.h"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <memory>
#include <mutex>
#include <stdexcept>

namespace wfloat_next {
namespace llm_detail {
using Json = nlohmann::json;
thread_local std::string error;
void warning_log(ggml_log_level level, const char * text, void *) {
    // CONT inherits the preceding severity; do not leak INFO continuation dumps.
    static thread_local ggml_log_level severity = GGML_LOG_LEVEL_INFO;
    if (level != GGML_LOG_LEVEL_CONT) severity = level;
    if (severity == GGML_LOG_LEVEL_WARN || severity == GGML_LOG_LEVEL_ERROR)
        std::fputs(text, stderr);
}
struct Model {
    llama_model * model = nullptr;
    llama_context * context = nullptr;
    const llama_vocab * vocab = nullptr;
    common_chat_templates_ptr templates;
    std::vector<llama_token> cache;
    ~Model() { if (context) llama_free(context); if (model) llama_model_free(model); }
};
struct Round {
    Model * model;
    common_chat_params chat;
    common_chat_parser_params parser;
    common_sampler_ptr sampler;
    std::vector<llama_token> input;
    size_t evaluated = 0, reused = 0, emitted_tools = 0;
    int output = 0, max_tokens = -1;
    std::string raw, text, reasoning, stop;
    Json pending = Json::array();
};
char * copy(const std::string & s) {
    auto p = static_cast<char *>(std::malloc(s.size() + 1));
    if (!p) throw std::bad_alloc();
    std::memcpy(p, s.c_str(), s.size() + 1); return p;
}
template<class F> char * result(F f) {
    try { return copy(f().dump()); }
    catch (const std::exception & e) { error = e.what(); return nullptr; }
}
// Called only after schema preflight. Visit schema-valued keywords explicitly:
// const/enum/default/examples may contain objects that only look like schemas.
void normalize_grammar_schema(Json & schema) {
    if (schema == true || (schema.is_object() && schema.empty())) {
        schema = {{"type", Json::array({"object", "array", "string", "number", "boolean", "null"})}};
        return;
    }
    if (!schema.is_object()) return; // Preserve false schemas/sentinels.
    for (const char * key : {"properties", "$defs"}) {
        if (schema.contains(key))
            for (auto & child : schema[key]) normalize_grammar_schema(child);
    }
    for (const char * key : {"items", "additionalProperties", "not"}) {
        if (!schema.contains(key)) continue;
        // The converter already handles this true sentinel correctly. Turning
        // it into an object can change its dispatch ahead of an allOf branch.
        if (std::strcmp(key, "additionalProperties") == 0 && schema[key] == true) continue;
        normalize_grammar_schema(schema[key]);
    }
    for (const char * key : {"anyOf", "allOf", "oneOf"}) {
        if (schema.contains(key))
            for (auto & child : schema[key]) normalize_grammar_schema(child);
    }
    // Only the properties conversion path needs this default made explicit;
    // unconstrained objects already allow extras. Do not reroute other schemas.
    if (schema.contains("properties") && !schema.contains("additionalProperties"))
        schema["additionalProperties"] = true;
}
common_chat_params format(Model & m, const Json & request) {
    common_chat_templates_inputs in;
    in.messages = common_chat_msgs_parse_oaicompat(common_json::parse(request.at("messages").dump()));
    if (request.contains("tools")) in.tools = common_chat_tools_parse_oaicompat(common_json::parse(request.at("tools").dump()));
    for (auto & tool : in.tools) {
        auto schema = Json::parse(tool.parameters);
        auto check = wfloat::schema::checkSchema(schema);
        if (!check.at("valid").get<bool>()) throw std::runtime_error(check.dump());
        normalize_grammar_schema(schema);
        tool.parameters = schema.dump();
    }
    if (request.contains("jsonSchema")) {
        if (!in.tools.empty()) throw std::runtime_error("Tools and structured output cannot be combined.");
        auto check = wfloat::schema::checkSchema(request.at("jsonSchema"));
        if (!check.at("valid").get<bool>()) throw std::runtime_error(check.dump());
        auto schema = request.at("jsonSchema");
        // Common template adapters use an empty/non-object schema as their
        // "no response format" sentinel. Preserve any-JSON semantics without
        // silently disabling the answer grammar (including reasoning templates).
        if (schema == false) throw std::runtime_error("The false schema permits no output and cannot be used for generation.");
        normalize_grammar_schema(schema);
        in.json_schema = schema.dump();
    }
    in.parallel_tool_calls = true;
    in.reasoning_format = COMMON_REASONING_FORMAT_AUTO;
    if (request.contains("reasoning")) {
        in.enable_thinking = request.at("reasoning").get<bool>();
        in.chat_template_kwargs["enable_thinking"] = in.enable_thinking ? "true" : "false";
    }
    auto formatted = common_chat_templates_apply(m.templates.get(), in);
    if (request.contains("jsonSchema") && formatted.grammar.empty())
        throw std::runtime_error("This model template cannot constrain the requested JSON schema.");
    return formatted;
}
// Honor model metadata before applying caller overrides. Common exposes the keys
// but keeps its metadata-to-sampler helper private.
void model_sampling_defaults(const llama_model * model, common_params_sampling & s) {
    auto number = [&](llama_model_meta_key key, auto & field) {
        char value[128] = {};
        int n = llama_model_meta_val_str(model, llama_model_meta_key_str(key), value, sizeof(value));
        if (n <= 0 || n >= static_cast<int>(sizeof(value))) return;
        char * end = nullptr; double parsed = std::strtod(value, &end);
        if (end == value || *end || !std::isfinite(parsed)) throw std::runtime_error("Invalid model sampling metadata.");
        using T = std::decay_t<decltype(field)>;
        if constexpr (std::is_integral_v<T>) {
            if (parsed < INT32_MIN || parsed > INT32_MAX || parsed != std::trunc(parsed))
                throw std::runtime_error("Invalid integer model sampling metadata.");
        }
        field = static_cast<T>(parsed);
    };
    number(LLAMA_MODEL_META_KEY_SAMPLING_TOP_K, s.top_k);
    number(LLAMA_MODEL_META_KEY_SAMPLING_TOP_P, s.top_p);
    number(LLAMA_MODEL_META_KEY_SAMPLING_MIN_P, s.min_p);
    number(LLAMA_MODEL_META_KEY_SAMPLING_TEMP, s.temp);
    number(LLAMA_MODEL_META_KEY_SAMPLING_PENALTY_REPEAT, s.penalty_repeat);
    number(LLAMA_MODEL_META_KEY_SAMPLING_PENALTY_LAST_N, s.penalty_last_n);
}
std::unique_ptr<common_chat_peg_mapper> mapper(common_chat_msg & msg, common_chat_format fmt) {
    if (fmt == COMMON_CHAT_FORMAT_PEG_GEMMA4) return std::make_unique<common_chat_peg_gemma4_mapper>(msg);
    if (fmt == COMMON_CHAT_FORMAT_PEG_MINIMAX_M3) return std::make_unique<common_chat_peg_minimax_m3_mapper>(msg);
    return std::make_unique<common_chat_peg_mapper>(msg);
}
// Decode only whole UTF-8 sequences: a token may end midway through a code point.
size_t utf8_end(const std::string & s) {
    if (s.empty()) return 0;
    size_t start = s.size() - 1;
    while (start > 0 && (static_cast<unsigned char>(s[start]) & 0xc0) == 0x80) --start;
    auto c = static_cast<unsigned char>(s[start]);
    size_t n = c < 0x80 ? 1 : c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
    return start + n <= s.size() ? s.size() : start;
}
void delta(Json & events, const char * type, std::string & previous, const std::string & current) {
    // A partial PEG failure at the next protocol marker can temporarily return
    // a shorter captured prefix. Keep already published content until it recovers.
    if (previous.compare(0, current.size(), current) == 0) return;
    if (current.compare(0, previous.size(), previous) != 0) throw std::runtime_error("Chat parser revised already emitted content.");
    if (current.size() > previous.size()) events.push_back({{"type", type}, {"text", current.substr(previous.size())}});
    previous = current;
}
Json usage(const Round & r) {
    return {{"type", "usage"}, {"inputTokens", r.input.size()}, {"outputTokens", r.output}};
}
Json parse(Round & r) {
    Json events = Json::array({usage(r)});
    for (auto & event : r.pending) events.push_back(std::move(event));
    r.pending = Json::array();
    const size_t available = utf8_end(r.raw);
    size_t first_stop = std::string::npos;
    size_t hold = 0;
    // Compute every match against the same unmodified buffer boundary. A
    // repeated prefix (e.g. ## of ###) must hold its longest possible match.
    for (const auto & stop : r.chat.additional_stops) {
        if (stop.empty()) continue;
        first_stop = std::min(first_stop, r.raw.find(stop));
        if (r.stop.empty()) {
            for (size_t n = std::min(stop.size() - 1, available); n > hold; --n) {
                if (r.raw.compare(available - n, n, stop, 0, n) == 0) {
                    hold = n;
                    break;
                }
            }
        }
    }
    size_t end = available;
    if (first_stop != std::string::npos) {
        end = std::min(end, first_stop);
        if (r.stop.empty()) r.stop = "complete";
    } else if (r.stop.empty()) {
        end -= hold;
    }
    auto raw = r.raw.substr(0, end);
    auto msg = common_chat_parse(raw, true, r.parser);
    delta(events, "reasoning", r.reasoning, msg.reasoning_content);
    delta(events, "text", r.text, msg.content);
    // The common partial mapper can close JSON braces for display. Never infer
    // completeness from that JSON: only map fully captured TOOL syntax nodes.
    if (!r.parser.parser.empty()) {
        std::string effective = r.parser.generation_prompt + raw;
        common_peg_parse_context ctx(effective, COMMON_PEG_PARSE_FLAG_LENIENT);
        auto parsed = r.parser.parser.parse(ctx);
        size_t complete = 0;
        ctx.ast.visit(parsed, [&](const common_peg_ast_node & node) {
            if (node.tag != common_chat_peg_builder::TOOL || node.is_partial) return;
            bool partial = false;
            ctx.ast.visit(node.id, [&](const common_peg_ast_node & child) { partial |= child.is_partial; });
            if (partial) return;
            common_chat_msg call_msg;
            common_peg_parse_result subtree(COMMON_PEG_PARSE_RESULT_SUCCESS, node.start, node.end, {node.id});
            mapper(call_msg, r.parser.format)->from_ast(ctx.ast, subtree);
            for (const auto & call : call_msg.tool_calls) {
                if (complete++ < r.emitted_tools) continue;
                events.push_back({{"type", "toolCall"}, {"id", call.id}, {"name", call.name}, {"rawArguments", call.arguments}});
            }
        });
        r.emitted_tools = std::max(r.emitted_tools, complete);
    }
    if (!r.stop.empty()) events.push_back({{"type", "done"}, {"stopReason", r.stop},
        {"inputTokens", r.input.size()}, {"outputTokens", r.output}, {"cachedInputTokens", r.reused}});
    return events;
}
void decode(Model & m, llama_token * tokens, size_t count) {
    auto batch = llama_batch_get_one(tokens, static_cast<int32_t>(count));
    if (llama_decode(m.context, batch) != 0) {
        llama_memory_clear(llama_get_memory(m.context), true); m.cache.clear();
        throw std::runtime_error("llama_decode failed.");
    }
    m.cache.insert(m.cache.end(), tokens, tokens + count);
}

const char * wfloat_native_last_error() { return error.c_str(); }
void wfloat_native_free_string(char * p) { std::free(p); }
Model * wfloat_native_create_paths(const std::vector<std::string>& paths, int context_size, int threads, const char * tmpl, const Cancel* cancel = nullptr) {
    try {
        static std::once_flag once; std::call_once(once, [] {
            llama_log_set(warning_log, nullptr);
            ggml_log_set(warning_log, nullptr);
            common_log_set_verbosity_thold(LOG_LEVEL_WARN);
            llama_backend_init();
        });
        if (context_size <= 0 || threads <= 0) throw std::runtime_error("Positive context size and thread count required.");
        auto m = std::make_unique<Model>();
        auto mp = nativeLlmModelParams();
        if (cancel) {
            mp.progress_callback = [](float, void* opaque) -> bool {
                try { const auto& fn = *static_cast<const Cancel*>(opaque); return !(fn && fn()); }
                catch (...) { return false; }
            };
            mp.progress_callback_user_data = const_cast<Cancel*>(cancel);
        }
        if (paths.empty()) throw std::invalid_argument("Missing GGUF paths.");
        if (cancel) checkCancelled(*cancel);
        std::vector<const char*> splits;
        for (const auto& path : paths) splits.push_back(path.c_str());
        m->model = paths.size() == 1 ? llama_model_load_from_file(splits.front(), mp)
            : llama_model_load_from_splits(splits.data(), splits.size(), mp);
        if (!m->model) throw std::runtime_error("Failed to load GGUF.");
        if (llama_model_has_encoder(m->model)) throw std::runtime_error("Chat runtime currently requires a decoder-only model.");
        auto cp = llama_context_default_params();
        cp.n_ctx = context_size; cp.n_batch = 128; cp.n_ubatch = 128;
        cp.n_threads = threads; cp.n_threads_batch = threads;
        m->context = llama_init_from_model(m->model, cp);
        if (!m->context) throw std::runtime_error("Failed to initialize context.");
        m->vocab = llama_model_get_vocab(m->model);
        if ((!tmpl || !*tmpl) && !llama_model_chat_template(m->model, nullptr))
            throw std::runtime_error("GGUF has no chat template; supply an explicit chatTemplate.");
        m->templates = common_chat_templates_init(m->model, tmpl ? tmpl : "");
        return m.release();
    } catch (const std::exception & e) { error = e.what(); return nullptr; }
}
// Preserve the Python C ABI adapter's exact single-file entry point.
Model * wfloat_native_create(const char * path, int context_size, int threads, const char * tmpl, const Cancel* cancel = nullptr) {
    return wfloat_native_create_paths({path}, context_size, threads, tmpl, cancel);
}
int wfloat_native_context_size(Model * m) { return llama_n_ctx(m->context); }
void wfloat_native_destroy(Model * m) { delete m; }
char * wfloat_native_count(Model * m, const char * request) {
    return result([&] { return Json(common_tokenize(m->vocab, format(*m, Json::parse(request)).prompt, true, true).size()); });
}
Round * wfloat_native_begin(Model * m, const char * request) {
    try {
        auto req = Json::parse(request);
        auto r = std::make_unique<Round>(); r->model = m;
        r->chat = format(*m, req);
        r->parser = common_chat_parser_params(r->chat);
        r->parser.reasoning_format = COMMON_REASONING_FORMAT_AUTO;
        if (!r->chat.parser.empty()) r->parser.parser.load(r->chat.parser);
        r->input = common_tokenize(m->vocab, r->chat.prompt, true, true);
        if (r->input.empty()) throw std::runtime_error("Formatted request has no tokens.");
        if (req.contains("reasoning")) {
            bool wants_thinking = req.at("reasoning").get<bool>();
            bool unsupported = wants_thinking && !r->chat.supports_thinking;
            if (!wants_thinking) {
                auto thinking_request = req; thinking_request["reasoning"] = true;
                auto thinking_chat = format(*m, thinking_request);
                // The common helper named support_enable_thinking only detects
                // reasoning, not whether the template can actually switch it off.
                unsupported = thinking_chat.supports_thinking &&
                    thinking_chat.prompt == r->chat.prompt && thinking_chat.grammar == r->chat.grammar;
            }
            if (unsupported) r->pending.push_back({{"type", "warning"},
                {"message", "This model template cannot honor the requested reasoning preference."}});
        }
        if (req.contains("maxTokensPerRound")) {
            r->max_tokens = req.at("maxTokensPerRound").get<int>();
            if (r->max_tokens <= 0) throw std::runtime_error("maxTokensPerRound must be positive.");
        }
        if (r->input.size() >= llama_n_ctx(m->context)) { r->stop = "contextLimit"; return r.release(); }
        common_params_sampling s;
        model_sampling_defaults(m->model, s);
#define SET(field, key) if (req.contains(key)) s.field = req.at(key).get<decltype(s.field)>()
        SET(temp, "temperature"); SET(top_p, "topP"); SET(top_k, "topK"); SET(min_p, "minP");
        SET(penalty_repeat, "repetitionPenalty"); SET(penalty_present, "presencePenalty");
        SET(penalty_freq, "frequencyPenalty"); SET(seed, "seed");
#undef SET
        if (!r->chat.grammar.empty()) s.grammar = {req.contains("jsonSchema") ? COMMON_GRAMMAR_TYPE_OUTPUT_FORMAT : COMMON_GRAMMAR_TYPE_TOOL_CALLS, r->chat.grammar};
        s.grammar_lazy = r->chat.grammar_lazy; s.generation_prompt = r->chat.generation_prompt;
        for (const auto & token : r->chat.preserved_tokens) {
            auto ids = common_tokenize(m->vocab, token, false, true);
            if (ids.size() == 1) s.preserved_tokens.insert(ids[0]);
        }
        s.grammar_triggers = r->chat.grammar_triggers;
        for (auto & trigger : s.grammar_triggers) {
            if (trigger.type != COMMON_GRAMMAR_TRIGGER_TYPE_WORD) continue;
            auto ids = common_tokenize(m->vocab, trigger.value, false, true);
            if (ids.size() == 1) { trigger.type = COMMON_GRAMMAR_TRIGGER_TYPE_TOKEN; trigger.token = ids[0]; s.preserved_tokens.insert(ids[0]); }
        }
        r->sampler.reset(common_sampler_init(m->model, s));
        if (!r->sampler) throw std::runtime_error("Failed to initialize sampler/grammar.");
        for (auto token : r->input) common_sampler_accept(r->sampler.get(), token, false);
        size_t prefix = 0;
        while (prefix < m->cache.size() && prefix < r->input.size() && m->cache[prefix] == r->input[prefix]) ++prefix;
        // Re-evaluate the final prompt token to obtain current logits even on an exact hit.
        prefix = std::min(prefix, r->input.size() - 1);
        if (!llama_memory_seq_rm(llama_get_memory(m->context), 0, prefix, -1)) {
            llama_memory_clear(llama_get_memory(m->context), true); prefix = 0;
        }
        m->cache.resize(prefix); r->evaluated = r->reused = prefix;
        return r.release();
    } catch (const std::exception & e) { error = e.what(); return nullptr; }
}
char * wfloat_native_step(Round * r, int cancel) {
    return result([&] {
        auto & m = *r->model;
        if (cancel && r->stop.empty()) r->stop = "cancelled";
        if (!r->stop.empty()) return parse(*r);
        if (r->evaluated < r->input.size()) {
            size_t n = std::min<size_t>(32, r->input.size() - r->evaluated);
            decode(m, r->input.data() + r->evaluated, n); r->evaluated += n;
            return Json::array({usage(*r)});
        }
        if (r->max_tokens >= 0 && r->output >= r->max_tokens) { r->stop = "maxTokens"; return parse(*r); }
        if (m.cache.size() >= llama_n_ctx(m.context)) { r->stop = "contextLimit"; return parse(*r); }
        auto token = common_sampler_sample(r->sampler.get(), m.context, -1);
        common_sampler_accept(r->sampler.get(), token, true); ++r->output;
        if (llama_vocab_is_eog(m.vocab, token)) { r->stop = "complete"; return parse(*r); }
        r->raw += common_token_to_piece(m.context, token, true);
        // Cache only tokens actually decoded, never sampled-but-unevaluated tokens.
        decode(m, &token, 1);
        return parse(*r);
    });
}
void wfloat_native_round_destroy(Round * r) { delete r; }
char * wfloat_native_schema(const char * request) {
    return result([&] { auto j = Json::parse(request); return j.value("validate", false)
        ? wfloat::schema::validate(j.at("schema"), j.at("value")) : wfloat::schema::checkSchema(j.at("schema")); });
}
}

namespace {
struct Llm final : Backend {
    std::unique_ptr<llm_detail::Model> model;
    explicit Llm(const Json& j, const Cancel& cancel) {
        checkCancelled(cancel);
        const auto options = j.value("options", Json::object());
        auto paths = llmModelPaths(j);
        auto tmpl = options.value("chatTemplate", std::string());
        model.reset(llm_detail::wfloat_native_create_paths(paths, options.value("contextSize", 2048),
                                                   options.value("numThreads", 1), tmpl.c_str(), &cancel));
        if (!model) throw std::runtime_error(llm_detail::error);
        checkCancelled(cancel);
    }
    Json info() const override { return {{"contextSize", llama_n_ctx(model->context)}}; }
    static Json take(char* value) {
        if (!value) throw std::runtime_error(llm_detail::error);
        std::unique_ptr<char, decltype(&std::free)> owned(value, &std::free);
        return Json::parse(value);
    }
    Json request(const Json& j, const Emit& emit, const Cancel& cancel) override {
        const auto op = j.at("op").get<std::string>();
        if (op == "schema") return take(llm_detail::wfloat_native_schema(j.dump().c_str()));
        if (op == "count") return take(llm_detail::wfloat_native_count(model.get(), j.at("request").dump().c_str()));
        if (op != "generateRound") throw std::invalid_argument("Unsupported LLM operation: " + op);
        if (!emit) throw std::invalid_argument("generateRound requires an event callback.");
        std::unique_ptr<llm_detail::Round> round(llm_detail::wfloat_native_begin(model.get(), j.at("request").dump().c_str()));
        if (!round) throw std::runtime_error(llm_detail::error);
        bool done = false;
        while (!done) {
            auto events = take(llm_detail::wfloat_native_step(round.get(), cancel && cancel()));
            for (const auto& event : events) {
                emit(event.dump());
                if (event.at("type") == "done") done = true;
            }
        }
        return nullptr;
    }
};
}
std::unique_ptr<Backend> makeLlm(const Json& j, const Cancel& cancel) { return std::make_unique<Llm>(j, cancel); }
} // wfloat_next
