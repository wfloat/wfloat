package com.wfloat.bench

import android.os.Handler
import android.os.Looper
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.ViewGroup
import android.view.Window
import android.widget.FrameLayout
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/** Explicit owned window for EGL timestamps. At most one native job in flight. */
internal class EglFrameSignalProbe {
  private val main = Handler(Looper.getMainLooper())
  private val lock = Any()
  private val busy = AtomicBoolean(false)
  private var generation = 0
  private var view: SurfaceView? = null
  private var state = JSONObject().put("state", "not_requested")
  fun snapshot(): JSONObject = synchronized(lock) { JSONObject(state.toString()) }
  private fun update(block: (JSONObject) -> Unit) = synchronized(lock) { block(state) }
  fun start(window: Window) {
    check(Looper.myLooper() == Looper.getMainLooper())
    stop("replaced")
    val token = ++generation
    if (busy.get()) { update { state = JSONObject().put("state", "previous_native_job_pending") }; return }
    update { state = JSONObject().put("state", "waiting_for_surface").put("startedMonotonicNs", System.nanoTime().toString()) }
    val parent = window.decorView.findViewById<ViewGroup>(android.R.id.content)
    if (parent == null) { stop("no_content_view"); return }
    val surfaceView = SurfaceView(window.context)
    surfaceView.setZOrderOnTop(true)
    surfaceView.holder.setFixedSize(2, 2)
    var submitted = false
    surfaceView.holder.addCallback(object : SurfaceHolder.Callback {
      override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) = Unit
      override fun surfaceDestroyed(holder: SurfaceHolder) { if (token == generation) stop("surface_destroyed") }
      override fun surfaceCreated(holder: SurfaceHolder) {
        if (token != generation || submitted || !busy.compareAndSet(false, true)) return
        submitted = true
        val surface = holder.surface
        update { it.put("state", "running") }
        Thread({
          val result = try { JSONObject(BenchSignalsNative.eglFrameProbe(surface)) }
            catch (e: Exception) { JSONObject().put("error", "${e.javaClass.simpleName}: ${e.message}") }
          finally { busy.set(false) }
          main.post { if (token == generation) { update { it.put("result", result) }; stop("completed") } }
        }, "BenchEglFrame").apply { isDaemon = true }.start()
      }
    })
    view = surfaceView
    parent.addView(surfaceView, FrameLayout.LayoutParams(2, 2).apply { leftMargin = 8; topMargin = 8 })
    main.postDelayed({ if (token == generation) stop("timed_out") }, 2500)
  }
  fun stop(reason: String = "cancelled") {
    check(Looper.myLooper() == Looper.getMainLooper())
    ++generation
    view?.let { (it.parent as? ViewGroup)?.removeView(it) }; view = null
    update {
      if (it.optString("state") in listOf("waiting_for_surface", "running"))
        it.put("state", reason).put("nativeJobStillRunning", busy.get()).put("finishedMonotonicNs", System.nanoTime().toString())
    }
  }
}
