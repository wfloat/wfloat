import android.os.Debug;
import android.os.Process;
import android.os.SystemClock;
import com.wfloat.bench.ArtGcCountFieldsKt;
import java.util.Arrays;
import java.util.Map;
import org.json.JSONObject;

/** Uses the production helper from the release APK in a separate ART process. */
public class ArtGcCountProbe {
  private static final byte[][] held = new byte[64][];
  private static volatile int checksum;
  private static long sample(String phase, long allocatedPayload) throws Exception {
    long before = Long.parseLong(Debug.getRuntimeStat("art.gc.gc-count"));
    Map<String,Object> row = ArtGcCountFieldsKt.readArtGcCount();
    long after = Long.parseLong(Debug.getRuntimeStat("art.gc.gc-count"));
    if(row.get("error")!=null) throw new AssertionError(row);
    long count=((Number)row.get("count")).longValue();
    if(!row.get("rawCount").equals(Long.toString(count)) || before>count || count>after)
      throw new AssertionError("collector outside adjacent direct queries");
    int heldCount=0;for(byte[] b:held) if(b!=null) ++heldCount;
    JSONObject out=new JSONObject();out.put("phase",phase);out.put("pid",Process.myPid());
    out.put("collector",new JSONObject(row));out.put("directBefore",before);out.put("directAfter",after);
    out.put("totalRequestedPayloadBytes",allocatedPayload);out.put("reachablePayloadBytes",heldCount*65536L);
    out.put("uptimeMs",SystemClock.elapsedRealtime());System.out.println(out.toString());return count;
  }
  public static void main(String[] args) throws Exception {
    long allocated=0;
    try {
      sample("warmup",0);long baseline=sample("baseline",0);
      long deadline=SystemClock.elapsedRealtime()+10000;long latest=baseline;
      // At most 4 MiB retained in the ring, plus one replacement array. No System.gc().
      for(int i=0;i<8192 && SystemClock.elapsedRealtime()<deadline;++i) {
        byte[] b=new byte[65536];b[0]=(byte)i;b[b.length-1]=(byte)(i>>>8);
        held[i%held.length]=b;checksum^=b[0];allocated+=b.length;
        if(i%64==63) {
          latest=sample("churn",allocated);
          if(latest>=baseline+2) break;
        }
      }
      long finalHeld=sample("workload_finished",allocated);
      Arrays.fill(held,null);long released=sample("references_released",allocated);
      if(finalHeld<=baseline || released<finalHeld) throw new AssertionError("positive cumulative response not observed");
      System.out.println("PASS: natural allocation-driven GC response, adjacent API comparisons, bounded references released");
    } finally {Arrays.fill(held,null);}
  }
}
