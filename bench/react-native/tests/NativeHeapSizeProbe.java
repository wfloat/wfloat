import android.os.Debug;
import android.os.Process;
import com.wfloat.bench.NativeHeapSizeFieldsKt;
import java.util.Map;
import org.json.JSONObject;

/** Separate diagnostic process using the production helper from the release APK. */
public class NativeHeapSizeProbe {
  private static native void change(int operation);
  private static native long mapped();
  private static long sample(String phase, long requested) throws Exception {
    long before = Debug.getNativeHeapSize();
    Map<String, Object> row = NativeHeapSizeFieldsKt.readNativeHeapSize();
    long after = Debug.getNativeHeapSize();
    long nativeValue = mapped();
    if (row.get("error") != null) throw new AssertionError(row);
    long size = ((Number) row.get("bytes")).longValue();
    if (!row.get("rawBytes").equals(Long.toString(size))) throw new AssertionError("raw mismatch");
    // Initialization may map allocator pages. Record exact comparisons, with a
    // bounded allowance for this separate process's helper/JSON initialization.
    if (Math.abs(size-before)>262144 || Math.abs(size-after)>262144 || Math.abs(size-nativeValue)>262144)
      throw new AssertionError("collector disagrees with adjacent API/mallinfo queries");
    long allocated = Debug.getNativeHeapAllocatedSize(), free = Debug.getNativeHeapFreeSize();
    JSONObject out = new JSONObject();
    out.put("phase",phase); out.put("pid",Process.myPid()); out.put("requestedHeldBytes",requested);
    out.put("collector",new JSONObject(row)); out.put("directBeforeBytes",before);
    out.put("directAfterBytes",after); out.put("mallinfoUsmblksBytes",nativeValue);
    out.put("allocatedBytes",allocated); out.put("freeBytes",free);
    System.out.println(out.toString());
    return size;
  }
  public static void main(String[] args) throws Exception {
    System.load(args[0]);
    try {
      sample("initial",0);
      long cold = sample("cold_baseline",0);
      change(1); long warm = sample("warm_small_held",16777216);
      if(warm-cold<12*1048576L) throw new AssertionError("small-pool growth not observed");
      change(0); sample("warm_released",0);
      sample("small_baseline",0);
      change(1); sample("small_held",16777216);
      change(2); sample("small_half_released",8388608);
      change(0); long base = sample("small_released",0);
      change(3); long large = sample("large_held",16777216);
      if(large-base<12*1048576L) throw new AssertionError("large mapped-space growth not observed");
      change(0); long freed = sample("large_released",0);
      change(4); long mmap = sample("mmap_held",16777216);
      change(0); long unmapped = sample("mmap_released",0);
      if(Math.abs(mmap-freed)>262144 || Math.abs(unmapped-mmap)>262144)
        throw new AssertionError("direct mmap unexpectedly changed allocator size");
      System.out.println("PASS: production collector, allocator growth and mmap exclusion; all diagnostic allocations released");
    } finally { change(0); }
  }
}
