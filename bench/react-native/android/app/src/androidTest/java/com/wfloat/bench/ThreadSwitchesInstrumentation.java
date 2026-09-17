package com.wfloat.bench;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.nio.charset.StandardCharsets;
import java.math.BigInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.json.JSONArray;

/** Test APK only: compare the production parser with the calling thread's getrusage counters. */
public class ThreadSwitchesInstrumentation extends Instrumentation {
  private static native long[] ownSwitches();
  private static volatile long sink;
  @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
  private static long[] direct() {
    long[] values=ownSwitches();
    if(values==null||values.length!=2)throw new IllegalStateException("getrusage(RUSAGE_THREAD) failed");
    return values;
  }
  @Override public void onStart() {
    Bundle result=new Bundle();int outcome=Activity.RESULT_CANCELED;AtomicReference<Throwable> failed=new AtomicReference<>();
    Thread worker=new Thread(()->{
      try {
        int tid=Process.myTid();String id=Integer.toString(tid);
        ThreadCpuStat stat=ThreadCpuStat.Companion.parse(new String(Files.readAllBytes(Paths.get("/proc/self/task/"+id+"/stat")),StandardCharsets.UTF_8),id);
        for(String phase:new String[]{"sleep","busy"}) {
          long[] initial=direct();
          Log.i("WfloatSwitchesProbe",new JSONObject().put("event","phase_start").put("phase",phase).put("processId",Process.myPid()).put("tid",tid)
            .put("startTimeTicks",stat.getStartTicks()).put("api",new JSONArray(initial)).put("sampledAtMs",System.currentTimeMillis()).toString());
          for(int i=0;i<8;i++) {
            if(phase.equals("sleep"))Thread.sleep(500);
            else {
              long until=SystemClock.elapsedRealtime()+500,v=1;
              while(SystemClock.elapsedRealtime()<until){if(Thread.currentThread().isInterrupted())throw new InterruptedException();for(int j=0;j<10000;j++)v=v*1664525+1013904223;}
              sink=v;
            }
            long[] before=direct();
            ThreadStatusResult status=ThreadStatus.INSTANCE.read(id,stat.getStartTicks());
            ThreadSwitchesResult c=status.getSwitches();long[] after=direct();
            if(!c.getAvailable()||!status.getAffinity().getAvailable())throw new IllegalStateException("Shared status failed: "+status);
            String[] values={c.getVoluntaryCount(),c.getInvoluntaryCount()};
            for(int k=0;k<2;k++) {
              BigInteger value=new BigInteger(values[k]);
              if(value.compareTo(BigInteger.valueOf(before[k]))<0||value.compareTo(BigInteger.valueOf(after[k]))>0)
                throw new IllegalStateException("Counter outside API bracket");
            }
            Log.i("WfloatSwitchesProbe",new JSONObject().put("event","check").put("processId",Process.myPid()).put("tid",tid).put("startTimeTicks",stat.getStartTicks())
              .put("phase",phase).put("voluntaryCount",values[0]).put("involuntaryCount",values[1]).put("apiBefore",new JSONArray(before)).put("apiAfter",new JSONArray(after))
              .put("cpuList",status.getAffinity().getCpuList()).put("sampledAtMs",System.currentTimeMillis()).toString());
          }
          long[] last=direct();int target=phase.equals("sleep")?0:1;
          Log.i("WfloatSwitchesProbe",new JSONObject().put("event","phase_end").put("phase",phase).put("api",new JSONArray(last)).put("sampledAtMs",System.currentTimeMillis()).toString());
          if(last[target]<=initial[target])throw new IllegalStateException("No positive "+phase+" response; inconclusive workload");
        }
      }catch(Throwable error){failed.set(error);}
    },"SwitchesProbe");
    try {
      System.loadLibrary("bench_switches_probe");
      Intent launch=getTargetContext().getPackageManager().getLaunchIntentForPackage(getTargetContext().getPackageName());
      if(launch==null)throw new IllegalStateException("Missing activity");
      startActivitySync(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));Thread.sleep(8000);
      worker.start();worker.join(20000);
      if(worker.isAlive())throw new IllegalStateException("Worker deadline exceeded");
      if(failed.get()!=null)throw new IllegalStateException("Worker failed",failed.get());
      outcome=Activity.RESULT_OK;result.putString("stream","PASS: 16 context-switch checks; sleep and busy responses positive.\n");
    }catch(Throwable error){Log.e("WfloatSwitchesProbe","FAILED",error);result.putString("stream","FAILED: "+error+"\n");}
    finally {worker.interrupt();try{worker.join(2000);}catch(InterruptedException error){Thread.currentThread().interrupt();}
      if(worker.isAlive()){outcome=Activity.RESULT_CANCELED;result.putString("stream","FAILED: worker cleanup\n");}}
    finish(outcome,result);
  }
}
