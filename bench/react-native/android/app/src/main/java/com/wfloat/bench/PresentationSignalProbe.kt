package com.wfloat.bench

import android.graphics.Color
import android.graphics.HardwareBufferRenderer
import android.graphics.RenderNode
import android.hardware.HardwareBuffer
import android.hardware.SyncFence
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.SurfaceControl
import android.view.Window
import org.json.JSONObject
import java.time.Duration
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** Explicit four-pixel owned compositor layer, removed after completion or 3 s. */
internal class PresentationSignalProbe {
  private val main=Handler(Looper.getMainLooper())
  private val worker=ThreadPoolExecutor(1,1,1,TimeUnit.SECONDS,LinkedBlockingQueue<Runnable>(),java.util.concurrent.ThreadFactory {r->Thread(r,"BenchPresentFence").apply{isDaemon=true}}).apply{allowCoreThreadTimeOut(true)}
  private val lock=Any()
  private var generation=0
  private var layer:SurfaceControl?=null
  private var buffer:HardwareBuffer?=null
  private var renderer:HardwareBufferRenderer?=null
  private var state=JSONObject().put("state","not_requested")
  fun snapshot():JSONObject=synchronized(lock){JSONObject(state.toString())}
  private fun update(block:(JSONObject)->Unit)=synchronized(lock){block(state)}
  fun start(window:Window) {
    check(Looper.myLooper()==Looper.getMainLooper())
    stop("replaced");val token=++generation
    update {state=JSONObject().put("state","starting").put("startedMonotonicNs",System.nanoTime().toString()).put("scope","Explicit owned 2x2 rendered buffer submitted to an app-child SurfaceControl. Native latch time and present-fence signaling are compositor observations, not CPU/GPU execution duration or proof of panel photon timing. No timing overrides or unrelated layers.")}
    if(Build.VERSION.SDK_INT<35){update{it.put("state","API 35 required")};return}
    val root=window.decorView.rootSurfaceControl
    if(root==null){update{it.put("state","no attached root surface")};return}
    try {
      val b=HardwareBuffer.create(2,2,HardwareBuffer.RGBA_8888,1,HardwareBuffer.USAGE_GPU_COLOR_OUTPUT or HardwareBuffer.USAGE_GPU_SAMPLED_IMAGE or HardwareBuffer.USAGE_COMPOSER_OVERLAY);buffer=b
      val r=HardwareBufferRenderer(b);renderer=r
      val node=RenderNode("Bench presentation source");node.setPosition(0,0,2,2);node.beginRecording().drawColor(Color.rgb(30,90,75));node.endRecording();r.setContentRoot(node)
      val surface=SurfaceControl.Builder().setName("Wfloat owned presentation probe").setBufferSize(2,2).setOpaque(true).build();layer=surface
      val executor=java.util.concurrent.Executor {main.post(it)}
      r.obtainRenderRequest().draw(executor) {result->
        val acquire=result.fence
        try {
          if(token!=generation)return@draw
          update{it.put("renderStatus",result.status).put("renderCallbackMonotonicNs",System.nanoTime().toString()).put("acquireFenceValid",acquire.isValid).put("acquireFenceSignalTimeNative",acquire.signalTime.toString())}
          if(result.status!=HardwareBufferRenderer.RenderResult.SUCCESS){stop("render_failed");return@draw}
          val transaction=root.buildReparentTransaction(surface)
          if(transaction==null){stop("reparent_unavailable");return@draw}
          transaction.use {t->
            t.setBuffer(surface,b,acquire).setLayer(surface,Int.MAX_VALUE).setPosition(surface,4f,4f).setVisibility(surface,true)
              .addTransactionCompletedListener(executor) {stats->
                val present=stats.presentFence
                if(token!=generation){present.close();return@addTransactionCompletedListener}
                val callbackTime=System.nanoTime();val latch=stats.latchTimeNanos
                worker.execute {
                  val observation=JSONObject().put("latchTimeNanos",latch.toString()).put("callbackMonotonicNs",callbackTime.toString())
                  try {observation.put("presentFenceValid",present.isValid).put("signalTimeBeforeWaitNative",present.signalTime.toString());val began=System.nanoTime();val signaled=present.await(Duration.ofMillis(250));observation.put("awaitReturned",signaled).put("waitElapsedNs",(System.nanoTime()-began).toString()).put("signalTimeAfterWaitNative",present.signalTime.toString()).put("invalidSentinel",SyncFence.SIGNAL_TIME_INVALID.toString()).put("pendingSentinel",SyncFence.SIGNAL_TIME_PENDING.toString())}
                  catch(e:Exception){observation.put("error","${e.javaClass.simpleName}: ${e.message}")}
                  finally {present.close()}
                  main.post {if(token==generation){update{it.put("presentation",observation)};stop("completed")}}
                }
              }
            update{it.put("state","submitted").put("submitMonotonicNs",System.nanoTime().toString())};t.apply()
          }
        } catch(e:Exception){if(token==generation){update{it.put("error","${e.javaClass.simpleName}: ${e.message}")};stop("failed")}}
        finally {acquire.close()}
      }
      main.postDelayed({if(token==generation)stop("timed_out")},3000)
    }catch(e:Exception){update{it.put("error","${e.javaClass.simpleName}: ${e.message}")};stop("failed")}
  }
  fun stop(reason:String="cancelled") {
    check(Looper.myLooper()==Looper.getMainLooper());++generation
    if(Build.VERSION.SDK_INT>=35){
      layer?.let {s->try{SurfaceControl.Transaction().use{it.reparent(s,null).apply()}}catch(e:Exception){update{it.put("cleanupError",e.javaClass.simpleName)}}finally{s.release()}};layer=null
      renderer?.close();renderer=null;buffer?.close();buffer=null
    }
    update{if(it.optString("state") in listOf("starting","submitted"))it.put("state",reason).put("finishedMonotonicNs",System.nanoTime().toString())}
  }
}
