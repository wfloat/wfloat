package com.wfloat.bench;
import android.app.Activity;
import android.app.Instrumentation;
import android.os.Bundle;
import org.json.JSONArray;
import org.json.JSONObject;

/** Test APK only: exercise the real JNI guard and cleanup owner in the app UID. */
public class NativeMallocInstrumentation extends Instrumentation {
  @Override public void onCreate(Bundle args) { super.onCreate(args);start(); }
  @Override public void onStart() {
    Bundle result=new Bundle();JSONArray rows=new JSONArray();
    try {
      BenchMemoryNative api=BenchMemoryNative.INSTANCE;
      for(int operation : new int[]{1,3,4}) {
        long handle=api.mallocCreate();int[] calls={0};boolean cancelled=false;
        try {
          try {api.mallocStep(handle,operation,()->++calls[0]<100);}
          catch(IllegalStateException expected){cancelled=true;}
          long held=api.mallocHeldBytes(handle);
          if(!cancelled || calls[0]!=100 || held<=0 || held>16777216) throw new AssertionError("JNI guard did not interrupt partial allocation");
          rows.put(new JSONObject().put("operation",operation).put("guardCalls",calls[0]).put("partialHeldBytes",held).put("cancelled",cancelled));
        } finally {api.mallocDestroy(handle);}
      }
      long handle=api.mallocCreate();boolean forwarded=false;
      try {
        try {api.mallocStep(handle,1,()->{throw new IllegalArgumentException("guard exception proof");});}
        catch(IllegalArgumentException expected){forwarded=expected.getMessage().equals("guard exception proof");}
        if(!forwarded || api.mallocHeldBytes(handle)!=0) throw new AssertionError("JNI guard exception was lost");
      } finally {api.mallocDestroy(handle);}
      result.putString("result", "PASS: real JNI cancellation on small, large and mmap operations; Java guard exception preserved; all handles destroyed");
      result.putString("cases",rows.toString());finish(Activity.RESULT_OK,result);
    } catch(Throwable error) {result.putString("error",error.toString());finish(Activity.RESULT_CANCELED,result);}
  }
}
