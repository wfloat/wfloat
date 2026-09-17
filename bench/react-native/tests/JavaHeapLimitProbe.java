import com.wfloat.bench.JavaHeapLimitFieldsKt;
import java.util.Map;

/** Separate bounded ART process, loading the production collector from its APK. */
public final class JavaHeapLimitProbe {
  private static volatile byte[][] held;
  private static void check(String phase, long expected) {
    Map<String,Object> row = JavaHeapLimitFieldsKt.readJavaHeapLimit();
    long direct = Runtime.getRuntime().maxMemory();
    System.out.println(phase + " direct="+direct+" expected="+expected+" "+row);
    if (!"finite".equals(row.get("limitKind")) || row.get("error") != null ||
        !Long.toString(direct).equals(row.get("rawBytes")) || row.get("bytes") == null ||
        ((Number)row.get("bytes")).longValue() != direct || direct != expected)
      throw new AssertionError("Collector disagrees with configured runtime limit");
  }
  public static void main(String[] args) {
    long expected = Long.parseLong(args[0]);
    check("baseline", expected);
    held = new byte[8][];
    for(int i=0; i<8; ++i) {
      held[i] = new byte[1024*1024]; held[i][0]=71; held[i][held[i].length-1]=93;
    }
    check("holding_8MiB", expected);
    for(byte[] bytes:held) if(bytes[0]!=71 || bytes[bytes.length-1]!=93) throw new AssertionError("Payload changed");
    held=null;
    check("references_released", expected);
    System.out.println("PASS production limit collector; configured maximum unchanged across bounded allocation and reference release");
  }
}
