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

/** Test APK only: a disposable worker changes only normal/batch/idle policy. */
public class ThreadSchedulerInstrumentation extends Instrumentation {
  private static native int setOwnPolicy(int policy);
  private static native int[] readScheduler(int tid);
  @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
  private ThreadCpuStat read(int tid) throws Exception {
    StringBuilder text=new StringBuilder();char[] buf=new char[2048];
    try(FileReader f=new FileReader("/proc/self/task/"+tid+"/stat")){int n;while((n=f.read(buf))!=-1)text.append(buf,0,n);}
    return ThreadCpuStat.Companion.parse(text.toString(),Integer.toString(tid));
  }
  @Override public void onStart() {
    Bundle result=new Bundle();int outcome=Activity.RESULT_CANCELED;AtomicReference<Throwable> failed=new AtomicReference<>();
    Thread worker=new Thread(()->{
      try {
        int tid=Process.myTid();
        for(int policy:new int[]{0,3,5}) {
          int error=setOwnPolicy(policy);
          if(error!=0)throw new IllegalStateException("sched_setscheduler failed: policy="+policy+" errno="+error);
          Log.i("WfloatSchedulerProbe",new JSONObject().put("event","phase_start").put("processId",Process.myPid()).put("tid",tid).put("policy",policy).put("sampledAtMs",System.currentTimeMillis()).toString());
          for(int i=0;i<8;i++) {
            ThreadCpuStat s=read(tid);int[] api=readScheduler(tid);
            // sched_getscheduler includes reset-on-fork; /proc stat exports policy separately.
            if(api[2]!=0||api[3]!=0||s.getPolicy()!=policy||(api[0]&~0x40000000)!=policy||s.getRtPriority()!=0||api[1]!=0)
              throw new IllegalStateException("Scheduler getter/parser mismatch");
            Log.i("WfloatSchedulerProbe",new JSONObject().put("event","check").put("processId",Process.myPid()).put("tid",tid).put("startTimeTicks",s.getStartTicks()).put("policy",s.getPolicy()).put("rtPriority",s.getRtPriority()).put("apiPolicy",api[0]).put("apiRtPriority",api[1]).put("sampledAtMs",System.currentTimeMillis()).toString());
            Thread.sleep(1000);
          }
          Log.i("WfloatSchedulerProbe",new JSONObject().put("event","phase_end").put("processId",Process.myPid()).put("tid",tid).put("policy",policy).put("sampledAtMs",System.currentTimeMillis()).toString());
        }
      }catch(Throwable e){failed.set(e);}
    },"SchedulerProbe");
    try {
      System.loadLibrary("bench_scheduler_probe");
      Intent launch=getTargetContext().getPackageManager().getLaunchIntentForPackage(getTargetContext().getPackageName());
      if(launch==null)throw new IllegalStateException("Missing activity");
      startActivitySync(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));Thread.sleep(8000);
      worker.start();worker.join(35000);
      if(worker.isAlive())throw new IllegalStateException("Worker deadline exceeded");
      if(failed.get()!=null)throw new IllegalStateException("Worker failed",failed.get());
      outcome=Activity.RESULT_OK;result.putString("stream","PASS: 24 scheduler checks across normal, batch and idle.\n");
    }catch(Throwable error){Log.e("WfloatSchedulerProbe","FAILED",error);result.putString("stream","FAILED: "+error+"\n");}
    finally {worker.interrupt();try{worker.join(2000);}catch(InterruptedException e){Thread.currentThread().interrupt();}
      if(worker.isAlive()){outcome=Activity.RESULT_CANCELED;result.putString("stream","FAILED: worker cleanup\n");}}
    finish(outcome,result);
  }
}
