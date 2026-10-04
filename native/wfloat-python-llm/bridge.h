#pragma once
/* Opaque handles are single-owner; serialize calls and destroy rounds before
 * their model. Returned strings must be released with wfloat_python_llm_free.
 * Null pointer results report a thread-local error. No C++ exception crosses
 * this ABI. step performs at most 32 prompt tokens or one sampled token. */
#if defined(_WIN32)
#define WFLOAT_PY_LLM_API __declspec(dllexport)
#else
#define WFLOAT_PY_LLM_API __attribute__((visibility("default")))
#endif
#ifdef __cplusplus
extern "C" {
#endif
WFLOAT_PY_LLM_API int wfloat_python_llm_abi_version(void);
WFLOAT_PY_LLM_API const char * wfloat_python_llm_error(void);
WFLOAT_PY_LLM_API void wfloat_python_llm_free(void *);
WFLOAT_PY_LLM_API void * wfloat_python_llm_create(const char *, int, int, const char *);
WFLOAT_PY_LLM_API int wfloat_python_llm_context_size(void *);
WFLOAT_PY_LLM_API void wfloat_python_llm_destroy(void *);
WFLOAT_PY_LLM_API char * wfloat_python_llm_count(void *, const char *);
WFLOAT_PY_LLM_API void * wfloat_python_llm_begin(void *, const char *);
WFLOAT_PY_LLM_API char * wfloat_python_llm_step(void *, int);
WFLOAT_PY_LLM_API void wfloat_python_llm_end(void *);
WFLOAT_PY_LLM_API char * wfloat_python_llm_schema(const char *);
#ifdef __cplusplus
}
#endif
