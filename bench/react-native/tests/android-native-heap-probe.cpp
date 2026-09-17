#include <jni.h>
#include <cstdlib>
#include <cstring>
#include <sys/mman.h>

namespace {
constexpr size_t MiB = 1024 * 1024;
void* blocks[16] = {};
void* mapping = MAP_FAILED;
void release() {
  for (auto &block : blocks) { free(block); block = nullptr; }
  if (mapping != MAP_FAILED) { munmap(mapping, 16 * MiB); mapping = MAP_FAILED; }
}
}
extern "C" JNIEXPORT void JNICALL Java_NativeHeapProbe_change(JNIEnv* env, jclass, jint op) {
  switch (op) {
    case 0: release(); return;
    case 1:
      for (auto &block : blocks) {
        if (block) { env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "Already allocated"); return; }
        block = malloc(MiB);
        if (!block) { release(); env->ThrowNew(env->FindClass("java/lang/OutOfMemoryError"), "malloc failed"); return; }
        memset(block, 0x5a, MiB);
      }
      return;
    case 2: for (int i = 0; i < 8; ++i) { free(blocks[i]); blocks[i] = nullptr; } return;
    case 3: release(); return;
    case 4:
      mapping = mmap(nullptr, 16 * MiB, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
      if (mapping == MAP_FAILED) { env->ThrowNew(env->FindClass("java/lang/RuntimeException"), "mmap failed"); return; }
      memset(mapping, 0x6b, 16 * MiB); return;
    case 5: release(); return;
  }
}
