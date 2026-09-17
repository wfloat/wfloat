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
public class ThreadAffinityInstrumentation extends Instrumentation {
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
  @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
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
        if(effective==null||effective.length==0)throw new IllegalStateException("No effective CPU for pinning");
        int pin=effective[0];
        if(java.util.Arrays.stream(original).noneMatch(cpu -> cpu==pin))throw new IllegalStateException("Pin target outside stored mask");
        if(original==null||original.length<1)throw new IllegalStateException("Need two allowed CPUs (or explicit single-CPU validation)");
        int phase=0;
        for(int[] requested:new int[][]{original,new int[]{pin},original}) {
          int cpu=requested[0];
          Log.i("WfloatAffinityProbe",new JSONObject().put("event","pin_request").put("processId",Process.myPid()).put("tid",tid).put("phase",phase).put("cpu",cpu)
            .put("requested",new org.json.JSONArray(requested)).put("initialStored",new org.json.JSONArray(original)).put("currentAllowed",new org.json.JSONArray(allowedCpus()))
            .put("cgroup",new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get("/proc/self/task/"+tid+"/cgroup")),java.nio.charset.StandardCharsets.UTF_8))
            .put("sampledAtMs",System.currentTimeMillis()).toString());
          int error=setOwnCpus(requested);
          if(error!=0)throw new IllegalStateException("sched_setaffinity cpu="+cpu+" errno="+error);
          Log.i("WfloatAffinityProbe",new JSONObject().put("event","phase_start").put("processId",Process.myPid()).put("tid",tid).put("phase",phase).put("cpu",cpu).put("sampledAtMs",System.currentTimeMillis()).toString());
          for(int i=0;i<8;i++) {
            int[] before=allowedCpus(),storedBefore=storedMask(tid);ThreadCpuStat stat=read(tid);
            ThreadAffinityResult reading=ThreadAffinity.INSTANCE.read(Integer.toString(tid),stat.getStartTicks());
            int[] storedAfter=storedMask(tid),after=allowedCpus();int currentCpu=ThreadPlacementInstrumentation.currentCpu();
            Log.i("WfloatAffinityProbe",new JSONObject().put("event","check").put("comparison","stored_hex_and_request_v2")
              .put("processId",Process.myPid()).put("tid",tid).put("startTimeTicks",stat.getStartTicks()).put("phase",phase)
              .put("requested",new org.json.JSONArray(requested)).put("storedBefore",new org.json.JSONArray(storedBefore)).put("storedAfter",new org.json.JSONArray(storedAfter))
              .put("cpuList",reading.getCpuList()).put("cpuCount",reading.getCpuCount()).put("apiBefore",new org.json.JSONArray(before)).put("apiAfter",new org.json.JSONArray(after))
              .put("available",reading.getAvailable()).put("reason",reading.getReason()).put("currentCpu",currentCpu)
              .put("getterDiffersFromStored",!same(before,storedBefore)||!same(after,storedAfter))
              .put("online",text("/sys/devices/system/cpu/online").trim()).put("sampledAtMs",System.currentTimeMillis()).toString());
            if(!reading.getAvailable()||!same(storedBefore,requested)||!same(storedAfter,requested))
              throw new IllegalStateException("Stored assignment did not match controlled request: "+reading);
            java.util.ArrayList<Integer> parsed=new java.util.ArrayList<>();
            for(String part:reading.getCpuList().split(",")) {
              String[] range=part.split("-");int first=Integer.parseInt(range[0]),last=range.length==2?Integer.parseInt(range[1]):first;
              if(last-first>1024)throw new IllegalStateException("Oversized diagnostic range");
              for(int c=first;c<=last;c++)parsed.add(c);
            }
            if(parsed.size()!=requested.length||reading.getCpuCount()!=requested.length)throw new IllegalStateException("Stored CPU count mismatch");
            for(int j=0;j<requested.length;j++)if(parsed.get(j)!=requested[j])throw new IllegalStateException("Stored CPU IDs mismatch");
            if(phase==1&&currentCpu!=pin)throw new IllegalStateException("Pinned worker ran on unexpected CPU");
            // Getter values are retained observations, not an equality oracle for stored affinity.
            checksDone.incrementAndGet();Thread.sleep(1000);
          }
          Log.i("WfloatAffinityProbe",new JSONObject().put("event","phase_end").put("processId",Process.myPid()).put("tid",tid).put("phase",phase).put("cpu",cpu).put("sampledAtMs",System.currentTimeMillis()).toString());
          phase++;
        }
      }catch(Throwable e){failed.set(e);}
      finally {
        if(original!=null) {
          int error=setOwnCpus(original);
          if(error!=0)failed.compareAndSet(null,new IllegalStateException("Affinity restore errno="+error));
          Log.i("WfloatAffinityProbe","Affinity restore errno="+error);
        }
      }
    },"AffinityProbe");
    try {
      System.loadLibrary("bench_placement_probe");
      Intent launch=getTargetContext().getPackageManager().getLaunchIntentForPackage(getTargetContext().getPackageName());
      if(launch==null)throw new IllegalStateException("Missing activity");
      startActivitySync(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));Thread.sleep(8000);
      worker.start();worker.join(35000);
      if(worker.isAlive())throw new IllegalStateException("Worker deadline exceeded");
      if(failed.get()!=null)throw new IllegalStateException("Worker failed",failed.get());
      outcome=Activity.RESULT_OK;result.putString("stream","PASS: "+checksDone.get()+" affinity checks. Stored masks compared with independent hex fields and controlled requests; getter recorded separately."+"\n");
    }catch(Throwable error){Log.e("WfloatAffinityProbe","FAILED",error);result.putString("stream","FAILED: "+error+"\n");}
    finally {worker.interrupt();try{worker.join(2000);}catch(InterruptedException e){Thread.currentThread().interrupt();}
      if(worker.isAlive()){outcome=Activity.RESULT_CANCELED;result.putString("stream","FAILED: worker cleanup\n");}}
    finish(outcome,result);
  }
}
