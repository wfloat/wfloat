// Synchronous llama-common logging adapter for the single-thread WASM artifact.
// Upstream common/log.cpp starts a std::thread, unavailable without pthreads.
#include "log.h"
#include <emscripten/emscripten.h>
#include <cstdarg>
#include <cstdio>
#include <vector>

struct common_log { bool paused = false; FILE * file = nullptr; };
namespace {
int verbosity = LOG_LEVEL_WARN;
common_log main_log;
int threshold(ggml_log_level level) {
    switch (level) {
        case GGML_LOG_LEVEL_ERROR: return LOG_LEVEL_ERROR;
        case GGML_LOG_LEVEL_WARN: return LOG_LEVEL_WARN;
        case GGML_LOG_LEVEL_DEBUG: return LOG_LEVEL_DEBUG;
        case GGML_LOG_LEVEL_NONE: return LOG_LEVEL_OUTPUT;
        default: return LOG_LEVEL_INFO;
    }
}
}
int common_log_get_verbosity_thold() { return verbosity; }
void common_log_set_verbosity_thold(int value) { verbosity = value; }
common_log * common_log_init() { return new common_log; }
common_log * common_log_main() { return &main_log; }
void common_log_pause(common_log * log) { log->paused = true; }
void common_log_resume(common_log * log) { log->paused = false; }
void common_log_free(common_log * log) {
    if (!log || log == &main_log) return;
    if (log->file) std::fclose(log->file);
    delete log;
}
void common_log_add(common_log * log, ggml_log_level level, const char * format, ...) {
    if (!log || log->paused || threshold(level) > verbosity) return;
    va_list args, measure; va_start(args, format); va_copy(measure, args);
    int size = std::vsnprintf(nullptr, 0, format, measure); va_end(measure);
    if (size < 0) { va_end(args); return; }
    std::vector<char> text(static_cast<size_t>(size) + 1);
    std::vsnprintf(text.data(), text.size(), format, args); va_end(args);
    int flags = EM_LOG_CONSOLE;
    if (level == GGML_LOG_LEVEL_WARN) flags |= EM_LOG_WARN;
    if (level == GGML_LOG_LEVEL_ERROR) flags |= EM_LOG_ERROR;
    emscripten_log(flags, "%s", text.data());
    if (log->file) std::fputs(text.data(), log->file);
}
void common_log_default_callback(ggml_log_level level, const char * text, void *) { common_log_add(&main_log, level, "%s", text); }
void common_log_set_file(common_log * log, const char * path) {
    if (log->file) std::fclose(log->file);
    log->file = path ? std::fopen(path, "a") : nullptr;
}
// Browser consoles supply presentation and timestamps; terminal styling is omitted.
void common_log_set_colors(common_log *, log_colors) {}
void common_log_set_prefix(common_log *, bool) {}
void common_log_set_timestamps(common_log *, bool) {}
void common_log_flush(common_log * log) { if (log->file) std::fflush(log->file); }
