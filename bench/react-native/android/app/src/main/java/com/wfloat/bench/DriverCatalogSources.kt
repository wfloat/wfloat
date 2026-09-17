package com.wfloat.bench
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.ArrayDeque

internal object DriverCatalogSources {
  private var cached:JSONObject?=null
  private val queue=ArrayDeque<Pair<File,Int>>()
  private val visited=HashSet<String>()
  private val rows=JSONArray()
  private var started=false
  private var capturedAt=0L
  private var duration=0L
  fun read():JSONObject {
    if(started && queue.isEmpty())cached?.let{return it}
    val start=SystemClock.elapsedRealtimeNanos();var limited=false
    if(!started){started=true;capturedAt=start
      for(path in listOf("/sys/class/sec","/sys/class/lcd","/sys/class/graphics","/sys/devices/system/memory","/sys/devices/soc0","/sys/class","/sys/kernel","/sys/devices/platform","/sys/bus/event_source/devices","/sys/bus/iio/devices","/sys/devices/system/cpu","/sys/devices/system/node","/sys/class/thermal","/sys/class/backlight","/sys/class/accel","/sys/kernel/apusys","/sys/kernel/npu","/sys/kernel/fastrpc","/sys/class/power_supply","/sys/class/hwmon","/sys/class/devfreq","/sys/class/devfreq-event","/sys/class/kgsl","/sys/class/misc","/sys/class/drm","/sys/class/net","/sys/class/scsi_host","/sys/class/block","/sys/class/wakeup","/sys/class/powercap","/sys/block","/sys/kernel/mm","/sys/kernel/slab","/sys/kernel/dma_heap","/sys/kernel/ion","/sys/kernel/gpu","/sys/kernel/ged","/sys/fs/f2fs","/sys/fs/ext4","/sys/bus/platform/devices","/sys/bus/platform/drivers"))queue.add(File(path) to 0)
    }
    while(queue.isNotEmpty()) {
      if(SystemClock.elapsedRealtimeNanos()-start>100_000_000L){limited=true;break}
      val (dir,depth)=queue.removeFirst();val canonical=try{dir.canonicalPath}catch(e:Exception){dir.path};if(!visited.add(canonical))continue
      val children=dir.listFiles()?.sortedBy {it.name};val row=JSONObject().put("path",dir.path).put("depth",depth)
      row.put("entryNames",children?.let{JSONArray(it.take(1024).map{f->f.name})}?:JSONObject.NULL).put("error",if(children==null) "directory listing unavailable or absent" else JSONObject.NULL)
      if((children?.size?:0)>1024){row.put("entryLimitReached",true);limited=true}
      rows.put(row)
      if(children!=null)for(child in children)if(child.isDirectory)queue.add(child to depth+1)
    }
    duration+=SystemClock.elapsedRealtimeNanos()-start
    return JSONObject().put("directories",rows).put("complete",queue.isEmpty()).put("scanLimitReached",limited).put("pendingDirectories",queue.size).put("capturedElapsedRealtimeNanos",capturedAt.toString()).put("durationNanos",duration.toString()).put("scope","Incremental directory-name discovery only, no unknown attribute reads. Symlink targets deduplicated; traversal resumes each sample until exhaustion. Displayed names capped at 1024 per directory; all subdirectories traversed. Used to locate additional driver telemetry.").also{cached=it}
  }
}
