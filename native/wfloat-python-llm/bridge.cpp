#include "bridge.h"
#include <functional>
// Opaque declarations of the shared RN implementation, deliberately avoiding
// copies of its templates, parser, sampling, cache or schema implementation.
namespace wfloat_next::llm_detail {
struct Model;
struct Round;
const char * wfloat_native_last_error();
void wfloat_native_free_string(char *);
Model * wfloat_native_create(const char *, int, int, const char *, const std::function<bool()> *);
int wfloat_native_context_size(Model *);
void wfloat_native_destroy(Model *);
char * wfloat_native_count(Model *, const char *);
Round * wfloat_native_begin(Model *, const char *);
char * wfloat_native_step(Round *, int);
void wfloat_native_round_destroy(Round *);
char * wfloat_native_schema(const char *);
}
namespace impl = wfloat_next::llm_detail;
int wfloat_python_llm_abi_version() { return 1; }
const char * wfloat_python_llm_error() { return impl::wfloat_native_last_error(); }
void wfloat_python_llm_free(void * p) { impl::wfloat_native_free_string(static_cast<char *>(p)); }
void * wfloat_python_llm_create(const char * path, int context, int threads, const char * tmpl) {
    return impl::wfloat_native_create(path, context, threads, tmpl, nullptr);
}
int wfloat_python_llm_context_size(void * m) { return impl::wfloat_native_context_size(static_cast<impl::Model *>(m)); }
void wfloat_python_llm_destroy(void * m) { impl::wfloat_native_destroy(static_cast<impl::Model *>(m)); }
char * wfloat_python_llm_count(void * m, const char * request) { return impl::wfloat_native_count(static_cast<impl::Model *>(m), request); }
void * wfloat_python_llm_begin(void * m, const char * request) { return impl::wfloat_native_begin(static_cast<impl::Model *>(m), request); }
char * wfloat_python_llm_step(void * r, int cancel) { return impl::wfloat_native_step(static_cast<impl::Round *>(r), cancel); }
void wfloat_python_llm_end(void * r) { impl::wfloat_native_round_destroy(static_cast<impl::Round *>(r)); }
char * wfloat_python_llm_schema(const char * request) { return impl::wfloat_native_schema(request); }
