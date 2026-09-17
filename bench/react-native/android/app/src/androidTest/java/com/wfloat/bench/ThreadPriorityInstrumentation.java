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

/** Test APK only: a disposable worker lowers its own nice value without modifying app threads. */
public class ThreadPriorityInstrumentation extends Instrumentation {
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
        int tid=Process.myTid(),initial=Process.getThreadPriority(tid);
        if(initial>0)throw new IllegalStateException("Expected non-positive initial nice, got "+initial);
        for(int nice:new int[]{0,10,19}) {
          Process.setThreadPriority(nice); // Only less favorable transitions; the worker exits afterward.
          Log.i("WfloatPriorityProbe",new JSONObject().put("event","phase_start").put("processId",Process.myPid()).put("tid",tid).put("nice",nice).put("sampledAtMs",System.currentTimeMillis()).toString());
          for(int i=0;i<8;i++) {
            ThreadCpuStat s=read(tid);int api=Process.getThreadPriority(tid);
            if(s.getNice()!=nice||api!=nice||s.getPriority()!=nice+20)throw new IllegalStateException("Mismatch: requested="+nice+" nice="+s.getNice()+" api="+api+" kernel="+s.getPriority());
            Log.i("WfloatPriorityProbe",new JSONObject().put("event","check").put("processId",Process.myPid()).put("tid",tid).put("startTimeTicks",s.getStartTicks()).put("nice",s.getNice()).put("priority",s.getPriority()).put("apiNice",api).put("sampledAtMs",System.currentTimeMillis()).toString());
            Thread.sleep(1000);
          }
          Log.i("WfloatPriorityProbe",new JSONObject().put("event","phase_end").put("processId",Process.myPid()).put("tid",tid).put("nice",nice).put("sampledAtMs",System.currentTimeMillis()).toString());
        }
      }catch(Throwable e){failed.set(e);}
    },"NiceProbe");
    try {
      Intent launch=getTargetContext().getPackageManager().getLaunchIntentForPackage(getTargetContext().getPackageName());
      if(launch==null)throw new IllegalStateException("Missing activity");
      startActivitySync(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));Thread.sleep(8000);
      worker.start();worker.join(35000);
      if(worker.isAlive())throw new IllegalStateException("Worker deadline exceeded");
      if(failed.get()!=null)throw new IllegalStateException("Worker failed",failed.get());
      outcome=Activity.RESULT_OK;result.putString("stream","PASS: 24 priority/nice checks across 0, 10 and 19.\n");
    }catch(Exception error){Log.e("WfloatPriorityProbe","FAILED",error);result.putString("stream","FAILED: "+error+"\n");}
    finally {worker.interrupt();try{worker.join(2000);}catch(InterruptedException e){Thread.currentThread().interrupt();}
      if(worker.isAlive()){outcome=Activity.RESULT_CANCELED;result.putString("stream","FAILED: worker cleanup\n");}}
    finish(outcome,result);
  }
}
