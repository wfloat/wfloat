package com.wfloat.bench;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import java.io.FileInputStream;
import java.util.ArrayList;
import org.json.JSONObject;

/** Test APK only: known handles are held while the normal foreground dashboard samples. */
public class FileDescriptorInstrumentation extends Instrumentation {
  @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
  private void boundary(String stage, int held) throws Exception {
    int[] reading = BenchFileDescriptorsNative.INSTANCE.read();
    Log.i("WfloatFdProbe", new JSONObject().put("stage", stage).put("held", held)
      .put("count", reading[0]).put("collectorDescriptor", reading[1]).put("pid", Process.myPid())
      .put("uptimeMs", SystemClock.elapsedRealtime()).put("wallMs", System.currentTimeMillis()).toString());
  }
  @Override public void onStart() {
    ArrayList<FileInputStream> handles = new ArrayList<>();
    Bundle result = new Bundle();
    int outcome = Activity.RESULT_CANCELED;
    try {
      Intent launch = getTargetContext().getPackageManager().getLaunchIntentForPackage(getTargetContext().getPackageName());
      if (launch == null) throw new IllegalStateException("Missing launch activity");
      startActivitySync(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      Thread.sleep(10000);
      boundary("baseline_start", 0); Thread.sleep(8000); boundary("baseline_end", 0);
      for (int i = 0; i < 32; ++i) handles.add(new FileInputStream("/dev/null"));
      for (FileInputStream handle : handles)
        if (!handle.getFD().valid()) throw new IllegalStateException("Probe handle is invalid");
      boundary("held_start", handles.size()); Thread.sleep(8000); boundary("held_end", handles.size());
      for (FileInputStream handle : handles) handle.close();
      handles.clear();
      boundary("released_start", 0); Thread.sleep(8000); boundary("released_end", 0);
      result.putString("stream", "Opened and closed 32 validated /dev/null handles. Compare WfloatFileDescriptors samples with WfloatFdProbe boundaries.\n");
      outcome = Activity.RESULT_OK;
    } catch (Exception error) {
      Log.e("WfloatFdProbe", "Handle check failed", error);
      result.putString("stream", "FAILED: " + error + "\n");
    } finally {
      for (FileInputStream handle : handles) try { handle.close(); } catch (Exception ignored) {}
    }
    finish(outcome, result);
  }
}
