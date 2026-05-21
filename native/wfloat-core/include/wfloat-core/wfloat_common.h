#ifndef WFLOAT_CORE_WFLOAT_COMMON_H_
#define WFLOAT_CORE_WFLOAT_COMMON_H_

#ifdef __cplusplus
extern "C" {
#endif

typedef enum wfloat_status {
  WFLOAT_STATUS_OK = 0,
  WFLOAT_STATUS_INVALID_ARGUMENT = 1,
  WFLOAT_STATUS_NOT_SUPPORTED = 2,
  WFLOAT_STATUS_CANCELLED = 3,
  WFLOAT_STATUS_BACKEND_ERROR = 4,
  WFLOAT_STATUS_INTERNAL_ERROR = 5,
} wfloat_status_t;

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // WFLOAT_CORE_WFLOAT_COMMON_H_
