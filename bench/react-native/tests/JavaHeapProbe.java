import com.wfloat.bench.JavaHeapUsedFieldsKt;
import java.lang.ref.WeakReference;
import java.util.Map;

/** Separate ART process, calling the production collector from the release APK. */
public final class JavaHeapProbe {
  private static volatile byte[][] held;
  private static final long MiB = 1024 * 1024;
  private static long sample(String phase) throws Exception {
    for (int attempt = 0; attempt < 5; ++attempt) {
      Map<String, Object> row = JavaHeapUsedFieldsKt.readJavaHeapUsed();
      System.out.println(phase + " attempt=" + attempt + " " + row);
      if (row.get("bytes") != null) return ((Number)row.get("bytes")).longValue();
      Thread.sleep(20);
    }
    throw new AssertionError("No coherent sample in diagnostic phase " + phase);
  }
  private static void gc() throws Exception { System.gc(); Thread.sleep(100); }
  private static void near(long actual, long expected) {
    if (Math.abs(actual - expected) > MiB) throw new AssertionError("Unexpected Java heap delta: " + actual + " vs " + expected);
  }
  private static void collect(WeakReference<?>[] refs, int from, int to) throws Exception {
    for (int tries = 0; tries < 10; ++tries) {
      gc(); boolean clear = true;
      for (int i=from; i<to; ++i) if (refs[i].get() != null) clear = false;
      if (clear) return;
    }
    throw new AssertionError("Requested GC did not clear released arrays within the diagnostic deadline");
  }
  public static void main(String[] args) throws Exception {
    WeakReference<?>[] refs = new WeakReference<?>[16];
    for (int i=0; i<4; ++i) sample("warmup");
    gc(); long baseline = sample("baseline");
    held = new byte[16][];
    for (int i=0; i<16; ++i) {
      held[i] = new byte[(int)MiB]; held[i][0] = 71; held[i][(int)MiB-1] = 93;
      refs[i] = new WeakReference<byte[]>(held[i]);
    }
    gc(); long full = sample("held_16MiB"); near(full-baseline,16*MiB);
    for (int i=0; i<8; ++i) held[i] = null;
    sample("half_dereferenced_before_requested_gc");
    collect(refs,0,8); long half = sample("half_collected"); near(half-baseline,8*MiB);
    for (int i=8; i<16; ++i) if (held[i][0] != 71 || held[i][(int)MiB-1] != 93) throw new AssertionError("Retained array contents changed");
    held = null;
    sample("all_dereferenced_before_requested_gc");
    collect(refs,0,16); long released = sample("all_collected"); near(released,baseline);
    System.out.println("PASS production collector; requested payload deltas="+(full-baseline)+","+(half-baseline)+","+(released-baseline)+"; weak references cleared and retained contents verified");
  }
}
