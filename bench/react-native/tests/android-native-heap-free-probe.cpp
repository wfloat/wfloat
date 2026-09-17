#include <jni.h>
#include <cstdlib>
#include <sys/mman.h>

namespace {
constexpr size_t MiB = 1024 * 1024;
void *small[4096] = {};
void *large[16] = {};
void *mapping = MAP_FAILED;
void release() {
  for (auto &p : small) { free(p); p = nullptr; }
  for (auto &p : large) { free(p); p = nullptr; }
  if (mapping != MAP_FAILED) { munmap(mapping, 16 * MiB); mapping = MAP_FAILED; }
}
void touch(void *p, size_t size) {
  auto bytes = static_cast<volatile unsigned char *>(p);
  for (size_t i = 0; i < size; i += 4096) bytes[i] = 0x5a;
  bytes[size - 1] = 0x5a;
}
}
extern "C" JNIEXPORT void JNICALL Java_NativeHeapFreeProbe_change(JNIEnv *env, jclass, jint op) {
  if (op == 0) { release(); return; }
  if (op == 2) { for (size_t i = 0; i < 2048; ++i) { free(small[i]); small[i] = nullptr; } return; }
  if (op == 1 || op == 3) {
    release();
    const size_t count = op == 1 ? 4096 : 16;
    const size_t size = op == 1 ? 4096 : MiB;
    auto blocks = op == 1 ? small : large;
    for (size_t i = 0; i < count; ++i) {
      blocks[i] = malloc(size);
      if (!blocks[i]) { release(); env->ThrowNew(env->FindClass("java/lang/OutOfMemoryError"), "bounded malloc probe"); return; }
      touch(blocks[i], size);
    }
  } else if (op == 4) {
    release();
    mapping = mmap(nullptr, 16 * MiB, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (mapping == MAP_FAILED) { env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "bounded mmap failed"); return; }
    touch(mapping, 16 * MiB);
  }
}
