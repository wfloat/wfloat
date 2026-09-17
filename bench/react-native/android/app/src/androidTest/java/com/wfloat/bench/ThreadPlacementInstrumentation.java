package com.wfloat.bench;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.os.Process;
import android.util.Log;
import java.io.FileReader;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

/** Test APK only: a disposable worker visits two allowed CPUs, then restores affinity. */
public class ThreadPlacementInstrumentation extends Instrumentation {
  static native int[] allowedCpus();
  static native int setOwnCpus(int[] cpus);
  static native int currentCpu();
  private boolean allowSingleCpu;
  @Override public void onCreate(Bundle args) { super.onCreate(args); allowSingleCpu=args!=null&&"true".equals(args.getString("allowSingleCpu")); start(); }
  private ThreadCpuStat read(int tid) throws Exception {
    StringBuilder text=new StringBuilder();char[] buf=new char[2048];
    try(FileReader f=new FileReader("/proc/self/task/"+tid+"/stat")){int n;while((n=f.read(buf))!=-1)text.append(buf,0,n);}
    return ThreadCpuStat.Companion.parse(text.toString(),Integer.toString(tid));
  }
  @Override public void onStart() {
    Bundle result=new Bundle();int outcome=Activity.RESULT_CANCELED;AtomicReference<Throwable> failed=new AtomicReference<>();
    java.util.concurrent.atomic.AtomicInteger checksDone=new java.util.concurrent.atomic.AtomicInteger();
    Thread worker=new Thread(()->{
      int[] original=null;
      try {
        int tid=Process.myTid();original=allowedCpus();
        if(original==null||original.length<1||(!allowSingleCpu&&original.length<2))throw new IllegalStateException("Need two allowed CPUs (or explicit single-CPU validation)");
        int phase=0;
        for(int cpu:original.length==1?new int[]{original[0]}:new int[]{original[0],original[1],original[0]}) {
          Log.i("WfloatPlacementProbe",new JSONObject().put("event","pin_request").put("processId",Process.myPid()).put("tid",tid).put("phase",phase).put("cpu",cpu)
            .put("initialAllowed",new org.json.JSONArray(original)).put("currentAllowed",new org.json.JSONArray(allowedCpus()))
            .put("cgroup",new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get("/proc/self/task/"+tid+"/cgroup")),java.nio.charset.StandardCharsets.UTF_8))
            .put("sampledAtMs",System.currentTimeMillis()).toString());
          int error=setOwnCpus(new int[]{cpu});
          if(error!=0)throw new IllegalStateException("sched_setaffinity cpu="+cpu+" errno="+error);
          Log.i("WfloatPlacementProbe",new JSONObject().put("event","phase_start").put("processId",Process.myPid()).put("tid",tid).put("phase",phase).put("cpu",cpu).put("sampledAtMs",System.currentTimeMillis()).toString());
          for(int i=0;i<8;i++) {
            int before=currentCpu();ThreadCpuStat s=read(tid);int after=currentCpu();
            if(before!=cpu||after!=cpu||s.getLastCpu()!=cpu)throw new IllegalStateException("Last CPU getter/parser mismatch");
            Log.i("WfloatPlacementProbe",new JSONObject().put("event","check").put("processId",Process.myPid()).put("tid",tid).put("startTimeTicks",s.getStartTicks()).put("phase",phase).put("cpu",cpu).put("lastCpu",s.getLastCpu()).put("apiBefore",before).put("apiAfter",after).put("sampledAtMs",System.currentTimeMillis()).toString());
            checksDone.incrementAndGet();Thread.sleep(1000);
          }
          Log.i("WfloatPlacementProbe",new JSONObject().put("event","phase_end").put("processId",Process.myPid()).put("tid",tid).put("phase",phase).put("cpu",cpu).put("sampledAtMs",System.currentTimeMillis()).toString());
          phase++;
        }
      }catch(Throwable e){failed.set(e);}
      finally {
        if(original!=null) {
          int error=setOwnCpus(original);
          if(error!=0)failed.compareAndSet(null,new IllegalStateException("Affinity restore errno="+error));
          Log.i("WfloatPlacementProbe","Affinity restore errno="+error);
        }
      }
    },"PlacementProbe");
    try {
      System.loadLibrary("bench_placement_probe");
      Intent launch=getTargetContext().getPackageManager().getLaunchIntentForPackage(getTargetContext().getPackageName());
      if(launch==null)throw new IllegalStateException("Missing activity");
      startActivitySync(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));Thread.sleep(8000);
      worker.start();worker.join(35000);
      if(worker.isAlive())throw new IllegalStateException("Worker deadline exceeded");
      if(failed.get()!=null)throw new IllegalStateException("Worker failed",failed.get());
      outcome=Activity.RESULT_OK;result.putString("stream","PASS: "+checksDone.get()+" last-CPU checks. "+(checksDone.get()==24?"Two-CPU movement validated.":"Single CPU only; movement unvalidated.")+"\n");
    }catch(Throwable error){Log.e("WfloatPlacementProbe","FAILED",error);result.putString("stream","FAILED: "+error+"\n");}
    finally {worker.interrupt();try{worker.join(2000);}catch(InterruptedException e){Thread.currentThread().interrupt();}
      if(worker.isAlive()){outcome=Activity.RESULT_CANCELED;result.putString("stream","FAILED: worker cleanup\n");}}
    finish(outcome,result);
  }
}
