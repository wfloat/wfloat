package com.wfloat.bench

import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Choreographer
import android.view.FrameMetrics
import android.view.Window
import org.json.JSONArray
import org.json.JSONObject

/** Three-second opt-in observation plus a tiny owned compositor-presentation probe. */
internal class FrameSignalProbe {
  private val handler=Handler(Looper.getMainLooper())
  private val lock=Any()
  private val presentation=if(Build.VERSION.SDK_INT>=35)PresentationSignalProbe() else null
  private var active=false
  private var generation=0
  private var window:Window?=null
  private var listener:Window.OnFrameMetricsAvailableListener?=null
  private var frameCallback:Choreographer.FrameCallback?=null
  private var vsyncCallback:Any?=null
  private var state=JSONObject().put("state","not_requested")
  fun snapshot():JSONObject=synchronized(lock){JSONObject(state.toString()).put("presentationProbe",presentation?.snapshot()?:JSONObject().put("state","API 35 required"))}
  fun start(w:Window)=handler.post {
    stopOnMain("replaced")
    val token=++generation
    synchronized(lock){state=JSONObject().put("state","recording").put("startedAtMs",System.currentTimeMillis()).put("scope","app window frame timing and callback scheduling").put("frames",JSONArray()).put("vsyncs",JSONArray())}
    active=true;window=w
    presentation?.start(w)
    val callback=Window.OnFrameMetricsAvailableListener {_,metrics,dropped ->
      if(active) synchronized(lock) {
        val rows=state.getJSONArray("frames")
        if(rows.length()<256) {
          val values=JSONObject();val names=listOf("UNKNOWN_DELAY_DURATION","INPUT_HANDLING_DURATION","ANIMATION_DURATION","LAYOUT_MEASURE_DURATION","DRAW_DURATION","SYNC_DURATION","COMMAND_ISSUE_DURATION","SWAP_BUFFERS_DURATION","TOTAL_DURATION","FIRST_DRAW_FRAME","INTENDED_VSYNC_TIMESTAMP","VSYNC_TIMESTAMP")
          for((index,name) in names.withIndex())values.put(name,metrics.getMetric(index).toString())
          if(Build.VERSION.SDK_INT>=31){values.put("GPU_DURATION",metrics.getMetric(FrameMetrics.GPU_DURATION).toString());values.put("DEADLINE",metrics.getMetric(FrameMetrics.DEADLINE).toString())}
          if(Build.VERSION.SDK_INT>=36)values.put("FRAME_TIMELINE_VSYNC_ID",metrics.getMetric(FrameMetrics.FRAME_TIMELINE_VSYNC_ID).toString())
          rows.put(JSONObject().put("receivedUptimeNanos",System.nanoTime().toString()).put("droppedReportsSinceLastCallback",dropped).put("metrics",values))
        }else state.put("frameLimitReached",true)
      }
    }
    listener=callback;w.addOnFrameMetricsAvailableListener(callback,handler)
    val choreographer=Choreographer.getInstance()
    if(Build.VERSION.SDK_INT>=33) {
      val vsync=object:Choreographer.VsyncCallback {override fun onVsync(data:Choreographer.FrameData) {
        if(!active||generation!=token)return
        synchronized(lock){val rows=state.getJSONArray("vsyncs");if(rows.length()<256){val timelines=JSONArray();for(t in data.frameTimelines)timelines.put(JSONObject().put("vsyncId",t.vsyncId.toString()).put("expectedPresentationTimeNanos",t.expectedPresentationTimeNanos.toString()).put("deadlineNanos",t.deadlineNanos.toString()));rows.put(JSONObject().put("frameTimeNanos",data.frameTimeNanos.toString()).put("receivedUptimeNanos",System.nanoTime().toString()).put("preferredVsyncId",data.preferredFrameTimeline.vsyncId.toString()).put("timelines",timelines))}else state.put("vsyncLimitReached",true)}
        choreographer.postVsyncCallback(this)
      }};vsyncCallback=vsync;choreographer.postVsyncCallback(vsync)
    }else{
      val cb=object:Choreographer.FrameCallback {override fun doFrame(time:Long){if(!active||generation!=token)return;synchronized(lock){val rows=state.getJSONArray("vsyncs");if(rows.length()<256)rows.put(JSONObject().put("frameTimeNanos",time.toString()).put("receivedUptimeNanos",System.nanoTime().toString())) else state.put("vsyncLimitReached",true)};choreographer.postFrameCallback(this)}};frameCallback=cb;choreographer.postFrameCallback(cb)
    }
    handler.postDelayed({if(generation==token)stopOnMain("completed")},3000)
  }
  private fun stopOnMain(reason:String) {
    presentation?.stop(reason)
    if(!active)return;active=false;++generation
    listener?.let {window?.removeOnFrameMetricsAvailableListener(it)};listener=null;window=null
    val c=Choreographer.getInstance();frameCallback?.let {c.removeFrameCallback(it)};frameCallback=null
    if(Build.VERSION.SDK_INT>=33)(vsyncCallback as? Choreographer.VsyncCallback)?.let {c.removeVsyncCallback(it)};vsyncCallback=null
    synchronized(lock){state.put("state",reason).put("finishedAtMs",System.currentTimeMillis())}
  }
  fun stop() {handler.post {stopOnMain("cancelled")}}
}
