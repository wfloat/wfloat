package com.wfloat.bench;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

/** Test APK only. Known running/sleeping workers exercise the production parser and dashboard. */
public class ThreadStatesInstrumentation extends Instrumentation {
  @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
  private String read(int tid) throws Exception {
    String text=new String(Files.readAllBytes(Paths.get("/proc/self/task/"+tid+"/stat")),StandardCharsets.UTF_8);
    return ThreadCpuStat.Companion.parse(text,Integer.toString(tid)).getRunState();
  }
  private String status(int tid) throws Exception {
    String text=new String(Files.readAllBytes(Paths.get("/proc/self/task/"+tid+"/status")),StandardCharsets.UTF_8);
    for(String line:text.split("\n"))if(line.startsWith("State:"))return line.substring(6).trim().substring(0,1);
    throw new IllegalStateException("Missing status state");
  }
  @Override public void onStart() {
    Bundle result=new Bundle();int outcome=Activity.RESULT_CANCELED;
    AtomicBoolean stop=new AtomicBoolean(false);AtomicInteger busyId=new AtomicInteger(),sleepId=new AtomicInteger();
    CountDownLatch ready=new CountDownLatch(2),release=new CountDownLatch(1);
    Thread busy=new Thread(()->{busyId.set(Process.myTid());ready.countDown();while(!stop.get()){}},"StateBusy");
    Thread sleeper=new Thread(()->{sleepId.set(Process.myTid());ready.countDown();try{release.await(30,TimeUnit.SECONDS);}catch(InterruptedException e){Thread.currentThread().interrupt();}},"StateSleep");
    try {
      Intent launch=getTargetContext().getPackageManager().getLaunchIntentForPackage(getTargetContext().getPackageName());
      if(launch==null)throw new IllegalStateException("Missing activity");
      startActivitySync(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));Thread.sleep(8000);
      busy.start();sleeper.start();if(!ready.await(2,TimeUnit.SECONDS))throw new IllegalStateException("Workers not ready");
      Thread.sleep(100);
      for(int i=0;i<12;i++) {
        String b=read(busyId.get()),s=read(sleepId.get()),bs=status(busyId.get()),ss=status(sleepId.get());
        if(!b.equals("R")||!s.equals("S")||!b.equals(bs)||!s.equals(ss))throw new IllegalStateException("Unexpected states: "+b+","+s+","+bs+","+ss);
        Log.i("WfloatStateProbe",new JSONObject().put("event","workers").put("processId",Process.myPid()).put("busyTid",busyId.get()).put("sleepTid",sleepId.get()).put("busyState",b).put("sleepState",s).put("statusAgrees",true).put("sampledAtMs",System.currentTimeMillis()).toString());
        Thread.sleep(1000);
      }
      outcome=Activity.RESULT_OK;result.putString("stream","PASS: 12 production-parser running/sleeping checks agreed with /proc status.\n");
    }catch(Exception error){Log.e("WfloatStateProbe","FAILED",error);result.putString("stream","FAILED: "+error+"\n");}
    finally {
      stop.set(true);release.countDown();
      try{busy.join(2000);sleeper.join(2000);}catch(InterruptedException e){Thread.currentThread().interrupt();}
      if(busy.isAlive()||sleeper.isAlive()){outcome=Activity.RESULT_CANCELED;result.putString("stream","FAILED: worker cleanup\n");}
    }
    finish(outcome,result);
  }
}
