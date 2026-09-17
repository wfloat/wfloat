import android.os.Debug;
import android.os.Process;
import android.os.SystemClock;
import com.wfloat.bench.ArtAllocatedBytesFieldsKt;
import com.wfloat.bench.ArtFreedBytesFieldsKt;
import com.wfloat.bench.JavaHeapUsedFieldsKt;
import java.util.Arrays;
import java.util.Map;
import org.json.JSONObject;
import org.json.JSONArray;

/** Runs outside the app and loads its production helpers from the release APK. */
public class ArtFreedBytesProbe {
  private static final byte[][] held = new byte[64][];
  private static volatile int checksum;
  private static long[] sample(String phase, long payload) throws Exception {
    long before=Long.parseLong(Debug.getRuntimeStat("art.gc.bytes-allocated"));
    Map<String,Object> row=ArtAllocatedBytesFieldsKt.readArtAllocatedBytes();
    long after=Long.parseLong(Debug.getRuntimeStat("art.gc.bytes-allocated"));
    if(row.get("error")!=null) throw new AssertionError(row);
    long bytes=((Number)row.get("bytes")).longValue();
    if(!row.get("rawBytes").equals(Long.toString(bytes)) || before>bytes || bytes>after)
      throw new AssertionError("production reading outside adjacent direct queries");
    // Freed accounting may decrease, so do not assume an ordered interval.
    // Seek equal neighboring reads with unchanged completed-GC count; retain every attempt.
    JSONArray attempts=new JSONArray();Map<String,Object> freedRow=null;long freed=0;boolean matched=false;
    for(int attempt=0;attempt<8;++attempt) {
      long gcBefore=Long.parseLong(Debug.getRuntimeStat("art.gc.gc-count"));
      long freedBefore=Long.parseLong(Debug.getRuntimeStat("art.gc.bytes-freed"));
      freedRow=ArtFreedBytesFieldsKt.readArtFreedBytes();
      long freedAfter=Long.parseLong(Debug.getRuntimeStat("art.gc.bytes-freed"));
      long gcAfter=Long.parseLong(Debug.getRuntimeStat("art.gc.gc-count"));
      if(freedRow.get("error")!=null) throw new AssertionError(freedRow);
      freed=((Number)freedRow.get("bytes")).longValue();
      if(!freedRow.get("rawBytes").equals(Long.toString(freed))) throw new AssertionError("raw freed bytes mismatch");
      JSONObject attemptRow=new JSONObject();attemptRow.put("before",freedBefore);attemptRow.put("collected",freed);
      attemptRow.put("after",freedAfter);attemptRow.put("gcBefore",gcBefore);attemptRow.put("gcAfter",gcAfter);
      attempts.put(attemptRow);
      if(freedBefore==freed && freed==freedAfter && gcBefore==gcAfter) {matched=true;break;}
    }
    if(!matched) throw new AssertionError("no stable direct match: "+attempts);
    Map<String,Object> heap=JavaHeapUsedFieldsKt.readJavaHeapUsed();
    if(heap.get("error")!=null) throw new AssertionError(heap);
    long used=((Number)heap.get("bytes")).longValue();
    long reachable=0;for(byte[] b:held) if(b!=null) reachable+=b.length;
    JSONObject out=new JSONObject();out.put("phase",phase);out.put("pid",Process.myPid());
    out.put("collector",new JSONObject(row));out.put("directBefore",before);out.put("directAfter",after);
    out.put("freedCollector",new JSONObject(freedRow));out.put("freedReadAttempts",attempts);
    out.put("javaHeapUsed",new JSONObject(heap));out.put("gcCount",Debug.getRuntimeStat("art.gc.gc-count"));
    out.put("totalRequestedPayloadBytes",payload);out.put("reachablePayloadBytes",reachable);
    out.put("uptimeMs",SystemClock.elapsedRealtime());System.out.println(out.toString());
    return new long[]{bytes,used,freed};
  }
  public static void main(String[] args) throws Exception {
    long payload=0;
    try {
      sample("warmup",0);long[] baseline=sample("baseline",0);
      sample("measurement_only",0);
      for(int i=0;i<held.length;++i) {
        byte[] b=new byte[262144];b[0]=(byte)i;b[b.length-1]=(byte)(i+1);
        held[i]=b;checksum^=b[0];payload+=b.length;
      }
      long[] retained=sample("held_16m",payload);
      Arrays.fill(held,null);
      // Explicit GC is diagnostic-only. Production sampling never requests it.
      System.gc();System.gc();long[] released=sample("released_after_gc",payload);
      if(retained[0]-baseline[0]<8L*1024*1024 || released[0]<retained[0] || retained[1]-released[1]<8L*1024*1024 || released[2]-retained[2]<8L*1024*1024)
        throw new AssertionError("retention/reclamation contrast not observed");
      long deadline=SystemClock.elapsedRealtime()+10000;
      for(int i=0;i<1024;++i) {
        if(SystemClock.elapsedRealtime()>deadline) throw new AssertionError("churn deadline exceeded");
        byte[] b=new byte[65536];b[0]=(byte)i;b[b.length-1]=(byte)(i>>>8);
        held[i%held.length]=b;checksum^=b[0];payload+=b.length;
        if(i%64==63) sample("churn",payload);
      }
      long[] churn=sample("churn_finished",payload);
      Arrays.fill(held,null);System.gc();System.gc();long[] finalRow=sample("final_after_gc",payload);
      if(finalRow[0]<churn[0] || finalRow[0]-released[0]<32L*1024*1024 || finalRow[2]-released[2]<32L*1024*1024)
        throw new AssertionError("cumulative churn response not observed");
      System.out.println("PASS: reclaimed bytes respond to release/GC and churn; stable direct matches verified without monotonic assumptions");
    } finally {Arrays.fill(held,null);}
  }
}
