import android.os.Debug;
import android.os.Process;
import com.wfloat.bench.NativeHeapFreeFieldsKt;
import java.util.Map;
import org.json.JSONObject;

/** Separate diagnostic process; loads the exact production helper from the release APK. */
public class NativeHeapFreeProbe {
  private static native void change(int operation);
  private static long sample(String phase, long requested) throws Exception {
    long before = Debug.getNativeHeapFreeSize();
    Map<String, Object> row = NativeHeapFreeFieldsKt.readNativeHeapFree();
    long after = Debug.getNativeHeapFreeSize();
    if (row.get("error") != null) throw new AssertionError(row);
    long free = ((Number) row.get("bytes")).longValue();
    if (!row.get("rawBytes").equals(Long.toString(free))) throw new AssertionError("raw mismatch");
    if (Math.abs(free - before) > 262144 || Math.abs(free - after) > 262144)
      throw new AssertionError("collector disagrees with adjacent public API queries");
    JSONObject out = new JSONObject();
    out.put("phase", phase); out.put("pid", Process.myPid()); out.put("requestedHeldBytes", requested);
    out.put("collector", new JSONObject(row)); out.put("directFreeBeforeBytes", before);
    out.put("directFreeAfterBytes", after); out.put("allocatedBytes", Debug.getNativeHeapAllocatedSize());
    System.out.println(out.toString());
    return free;
  }
  public static void main(String[] args) throws Exception {
    System.load(args[0]);
    try {
      // Resolve helper, JSON and JNI paths before measuring. No forced GC or allocator settings.
      sample("initial", 0);
      change(1); sample("warm_small_held", 16777216); change(0); sample("warm_released", 0);
      long base = sample("small_baseline", 0);
      change(1); long held = sample("small_held", 16777216);
      change(2); long half = sample("small_half_released", 8388608);
      change(0); long released = sample("small_released", 0);
      if (base - held < 12 * 1048576L || half - held < 6 * 1048576L || released - half < 6 * 1048576L)
        throw new AssertionError("small allocator free-space response missing");
      change(3); sample("large_held", 16777216);
      change(0); sample("large_released", 0);
      change(4); sample("mmap_held", 16777216);
      change(0); sample("mmap_released", 0);
      System.out.println("PASS: production collector and bounded small-block release response");
    } finally { change(0); }
  }
}
