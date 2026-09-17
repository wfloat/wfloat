import android.os.Debug;

/** Separate diagnostic process; never bundled into the app. */
public final class NativeHeapProbe {
  private static native void change(int operation);
  public static void main(String[] args) {
    System.load(args[0]);
    long[] readings = new long[7];
    for (int i = 0; i < 20; ++i) Debug.getNativeHeapAllocatedSize();
    readings[0] = Debug.getNativeHeapAllocatedSize();
    try {
      change(1); readings[1] = Debug.getNativeHeapAllocatedSize(); // 16 x malloc(1 MiB)
      change(2); readings[2] = Debug.getNativeHeapAllocatedSize(); // free half
      change(3); readings[3] = Debug.getNativeHeapAllocatedSize(); // free remainder
      change(4); readings[4] = Debug.getNativeHeapAllocatedSize(); // mmap + touch 16 MiB
      change(5); readings[5] = Debug.getNativeHeapAllocatedSize(); // munmap
      change(1); readings[6] = Debug.getNativeHeapAllocatedSize(); // repeat
    } finally { change(0); }
    long released = Debug.getNativeHeapAllocatedSize();
    String[] labels = {"baseline", "malloc_16MiB", "free_half", "free_all", "mmap_16MiB", "munmap", "malloc_repeat"};
    for (int i = 0; i < readings.length; ++i)
      System.out.println(labels[i] + " bytes=" + readings[i] + " delta=" + (readings[i] - readings[0]));
    System.out.println("final_release bytes=" + released + " delta=" + (released - readings[0]));
    long MiB = 1024 * 1024;
    if (readings[1]-readings[0] < 16*MiB || readings[1]-readings[0] > 18*MiB ||
        readings[1]-readings[2] < 7*MiB || readings[1]-readings[2] > 9*MiB ||
        Math.abs(readings[3]-readings[0]) > MiB || Math.abs(readings[4]-readings[3]) > MiB ||
        Math.abs(readings[5]-readings[3]) > MiB || readings[6]-readings[5] < 16*MiB ||
        Math.abs(released-readings[0]) > MiB) throw new AssertionError("Unexpected allocator transitions");
    System.out.println("PASS actual Debug API malloc/free/mmap transitions");
  }
}
