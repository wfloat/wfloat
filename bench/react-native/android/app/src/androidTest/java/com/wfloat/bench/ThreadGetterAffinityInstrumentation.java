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

/** Test APK only: a disposable worker compares full, pinned and restored reported masks. */
public class ThreadGetterAffinityInstrumentation extends Instrumentation {
  private static int[] allowedCpus() { return ThreadPlacementInstrumentation.allowedCpus(); }
  private static int setOwnCpus(int[] cpus) { return ThreadPlacementInstrumentation.setOwnCpus(cpus); }

  private static String text(String path) throws Exception {
    return new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(path)), java.nio.charset.StandardCharsets.UTF_8);
  }
  // Independent representation of the stored mask: hexadecimal Cpus_allowed,
  // rather than the production collector's decimal Cpus_allowed_list parser.
  private static int[] storedMask(int tid) throws Exception {
    String raw=text("/proc/self/task/"+tid+"/status");String hex=null;String pid=null;
    for(String line:raw.split("\\n")) {
      if(line.startsWith("Cpus_allowed:")){if(hex!=null)throw new IllegalStateException("Duplicate mask");hex=line.substring(line.indexOf(':')+1).trim().replace(",","");}
      if(line.startsWith("Pid:")){if(pid!=null)throw new IllegalStateException("Duplicate identity");pid=line.substring(line.indexOf(':')+1).trim();}
    }
    if(!Integer.toString(tid).equals(pid)||hex==null||!hex.matches("[0-9a-fA-F]+")||hex.length()>256)throw new IllegalStateException("Invalid status reference");
    java.math.BigInteger bits=new java.math.BigInteger(hex,16);
    int[] ids=new int[bits.bitCount()];int count=0;
    for(int i=0;i<bits.bitLength();i++)if(bits.testBit(i))ids[count++]=i;
    return ids;
  }
  private static boolean same(int[] a,int[] b){return java.util.Arrays.equals(a,b);}
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
        int tid=Process.myTid();original=storedMask(tid);
        int[] effective=allowedCpus();
        if(effective==null||effective.length==0||(!allowSingleCpu&&effective.length<2))throw new IllegalStateException("No effective CPU for pinning");
        int pin=effective[0];
        if(java.util.Arrays.stream(original).noneMatch(cpu -> cpu==pin))throw new IllegalStateException("Pin target outside stored mask");
        if(original==null||original.length<1)throw new IllegalStateException("Need two allowed CPUs (or explicit single-CPU validation)");
        int phase=0;
        for(int[] requested:new int[][]{new int[]{pin},new int[]{effective[Math.min(1,effective.length-1)]},original}) {
          int cpu=requested[0];
          Log.i("WfloatGetterProbe",new JSONObject().put("event","pin_request").put("processId",Process.myPid()).put("tid",tid).put("phase",phase).put("cpu",cpu)
            .put("requested",new org.json.JSONArray(requested)).put("initialStored",new org.json.JSONArray(original)).put("currentAllowed",new org.json.JSONArray(allowedCpus()))
            .put("cgroup",new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get("/proc/self/task/"+tid+"/cgroup")),java.nio.charset.StandardCharsets.UTF_8))
            .put("sampledAtMs",System.currentTimeMillis()).toString());
          int error=setOwnCpus(requested);
          if(error!=0)throw new IllegalStateException("sched_setaffinity cpu="+cpu+" errno="+error);
          Log.i("WfloatGetterProbe",new JSONObject().put("event","phase_start").put("processId",Process.myPid()).put("tid",tid).put("phase",phase).put("cpu",cpu).put("sampledAtMs",System.currentTimeMillis()).toString());
          for(int i=0;i<8;i++) {
            int[] before=allowedCpus(),storedBefore=storedMask(tid);ThreadCpuStat stat=read(tid);
            ThreadGetterAffinityResult reading=ThreadGetterAffinity.INSTANCE.read(Integer.toString(tid),stat.getStartTicks());
            int[] after=allowedCpus(),storedAfter=storedMask(tid);int currentCpu=ThreadPlacementInstrumentation.currentCpu();
            boolean agreement=reading.getAvailable()&&same(before,after)&&reading.getCpuIds().equals(java.util.Arrays.stream(before).boxed().collect(java.util.stream.Collectors.toList()));
            Log.i("WfloatGetterProbe",new JSONObject().put("event","check").put("processId",Process.myPid()).put("tid",tid).put("startTimeTicks",stat.getStartTicks()).put("phase",phase).put("protocol","pinned_pair_restore_v1").put("requested",new org.json.JSONArray(requested)).put("storedBefore",new org.json.JSONArray(storedBefore)).put("storedAfter",new org.json.JSONArray(storedAfter)).put("currentCpu",currentCpu).put("directAgreement",agreement)
              .put("cpuIds",new org.json.JSONArray(reading.getCpuIds())).put("apiBefore",new org.json.JSONArray(before)).put("apiAfter",new org.json.JSONArray(after))
              .put("available",reading.getAvailable()).put("reason",reading.getReason()).put("sampledAtMs",System.currentTimeMillis()).toString());
            if(!reading.getAvailable()||!same(storedBefore,requested)||!same(storedAfter,requested))
              throw new IllegalStateException("Unavailable getter or controlled stored assignment changed: "+reading);
            if(phase<2 && (!agreement||before.length!=1||before[0]!=requested[0]||currentCpu!=requested[0]))
              throw new IllegalStateException("Pinned getter/execution mismatch: "+reading);
            // Restored broad masks may be filtered between sequential reads.
            // Retain all observations; do not make equality a universal contract.
            checksDone.incrementAndGet();Thread.sleep(1000);
          }
          Log.i("WfloatGetterProbe",new JSONObject().put("event","phase_end").put("processId",Process.myPid()).put("tid",tid).put("phase",phase).put("cpu",cpu).put("sampledAtMs",System.currentTimeMillis()).toString());
          phase++;
        }
      }catch(Throwable e){failed.set(e);}
      finally {
        if(original!=null) {
          int error=setOwnCpus(original);
          if(error!=0)failed.compareAndSet(null,new IllegalStateException("Affinity restore errno="+error));
          Log.i("WfloatGetterProbe","Affinity restore errno="+error);
        }
      }
    },"GetterProbe");
    try {
      System.loadLibrary("bench_placement_probe");
      int[] invalid=BenchThreadAffinityNative.INSTANCE.read(0);
      if(invalid.length!=1||invalid[0]!=22)throw new IllegalStateException("Invalid TID did not return EINVAL");
      Intent launch=getTargetContext().getPackageManager().getLaunchIntentForPackage(getTargetContext().getPackageName());
      if(launch==null)throw new IllegalStateException("Missing activity");
      startActivitySync(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));Thread.sleep(8000);
      worker.start();worker.join(35000);
      if(worker.isAlive())throw new IllegalStateException("Worker deadline exceeded");
      if(failed.get()!=null)throw new IllegalStateException("Worker failed",failed.get());
      outcome=Activity.RESULT_OK;result.putString("stream","PASS: "+checksDone.get()+" getter checks. Two pinned comparisons and restored observations; broad differences retained."+"\n");
    }catch(Throwable error){Log.e("WfloatGetterProbe","FAILED",error);result.putString("stream","FAILED: "+error+"\n");}
    finally {worker.interrupt();try{worker.join(2000);}catch(InterruptedException e){Thread.currentThread().interrupt();}
      if(worker.isAlive()){outcome=Activity.RESULT_CANCELED;result.putString("stream","FAILED: worker cleanup\n");}}
    finish(outcome,result);
  }
}
