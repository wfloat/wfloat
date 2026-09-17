package com.wfloat.bench

import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Resolve only kernel-reported cgroup mounts/membership; never write controls. */
internal object CgroupPaths {
  data class Mount(val root:String,val path:String,val type:String,val controllers:Set<String>)
  data class Target(val path:String,val type:String,val controllers:Set<String>,val mountPath:String="",val ancestorDepth:Int=0)
  private fun decode(s:String)=Regex("\\\\([0-7]{3})").replace(s){it.groupValues[1].toInt(8).toChar().toString()}
  fun resolve(mountinfo:String,membership:String):List<Target> {
    val mounts=mountinfo.lineSequence().mapNotNull {line->
      val halves=line.split(" - ",limit=2);if(halves.size!=2)return@mapNotNull null
      val left=halves[0].split(' ');val right=halves[1].split(' ')
      if(left.size<6||right.size<3||right[0] !in listOf("cgroup","cgroup2"))return@mapNotNull null
      Mount(decode(left[3]),decode(left[4]),right[0],right[2].split(',').toSet())
    }.toList()
    return membership.lineSequence().flatMap {line->
      val parts=line.split(':',limit=3);if(parts.size!=3)return@flatMap emptySequence<Target>()
      val controllers=parts[1].split(',').filter{it.isNotEmpty()}.toSet();val member=parts[2]
      if(!member.startsWith('/')||member.split('/').any{it==".."||it=="."})return@flatMap emptySequence<Target>()
      mounts.asSequence().filter {m->if(controllers.isEmpty())m.type=="cgroup2" else m.type=="cgroup"&&controllers.any{it in m.controllers}}.mapNotNull {m->
        if(m.root!="/" && member!=m.root && !member.startsWith(m.root+"/"))return@mapNotNull null
        val suffix=if(m.root=="/")member else member.removePrefix(m.root)
        Target((m.path.trimEnd('/')+suffix).trimEnd('/').ifEmpty{"/"},m.type,controllers,m.path.trimEnd('/').ifEmpty{"/"})
      }
    }.distinct().toList()
  }
  fun ancestors(direct:List<Target>):List<Target> = direct.flatMap {target->
    val chain=mutableListOf(target);var path=target.path;var depth=0
    val boundary=target.mountPath.ifEmpty{target.path}
    while(path!=boundary&&depth<32&&(boundary=="/"||path.startsWith(boundary+"/"))){
      path=path.substringBeforeLast('/',"").ifEmpty{"/"}
      if(boundary!="/"&&path.length<boundary.length)break
      chain.add(target.copy(path=path,ancestorDepth=++depth))
    };chain
  }.distinctBy{it.path to it.type}

}
internal object CgroupSources {
  private val v2=listOf("cgroup.type","cgroup.events","cgroup.stat","cgroup.controllers","cgroup.subtree_control","cpu.stat","cpu.stat.local","cpu.weight.nice","cpu.idle","cpu.max","cpu.max.burst","cpu.weight","cpu.uclamp.min","cpu.uclamp.max","cpu.pressure","cpuset.cpus","cpuset.cpus.effective","cpuset.cpus.exclusive","cpuset.cpus.exclusive.effective","cpuset.cpus.isolated","cpuset.cpus.partition","cpuset.mems","cpuset.mems.effective","memory.current","memory.peak","memory.min","memory.low","memory.high","memory.max","memory.stat","memory.events","memory.events.local","memory.swap.current","memory.swap.peak","memory.swap.high","memory.swap.max","memory.swap.events","memory.zswap.current","memory.zswap.max","memory.zswap.writeback","memory.oom.group","memory.numa_stat","memory.pressure","io.stat","io.cost.qos","io.cost.model","io.latency","io.max","io.weight","io.pressure","pids.current","pids.peak","pids.max","pids.events","pids.events.local","rdma.current","rdma.peak","rdma.max","rdma.events","rdma.events.local","misc.capacity","misc.current","misc.peak","misc.max","misc.events","misc.events.local","dmem.current","dmem.peak","dmem.capacity","dmem.min","dmem.low","dmem.max")
  private val v1=mapOf("cpu" to listOf("cpu.stat","cpu.shares","cpu.cfs_quota_us","cpu.cfs_period_us","cpu.rt_runtime_us","cpu.rt_period_us"),"cpuacct" to listOf("cpuacct.stat","cpuacct.usage","cpuacct.usage_percpu","cpuacct.usage_user","cpuacct.usage_sys","cpuacct.usage_all"),"cpuset" to listOf("cpus","mems","effective_cpus","effective_mems","memory_pressure","sched_load_balance"),"memory" to listOf("memory.stat","memory.usage_in_bytes","memory.max_usage_in_bytes","memory.limit_in_bytes","memory.soft_limit_in_bytes","memory.failcnt","memory.memsw.usage_in_bytes","memory.memsw.limit_in_bytes","memory.kmem.usage_in_bytes","memory.kmem.max_usage_in_bytes","memory.kmem.limit_in_bytes","memory.kmem.failcnt","memory.kmem.tcp.usage_in_bytes","memory.kmem.tcp.max_usage_in_bytes","memory.kmem.tcp.limit_in_bytes","memory.kmem.tcp.failcnt","memory.memsw.max_usage_in_bytes","memory.memsw.failcnt","memory.swappiness","memory.move_charge_at_immigrate","memory.use_hierarchy","memory.oom_control","memory.numa_stat"),"blkio" to listOf("blkio.io_service_bytes","blkio.io_serviced","blkio.io_wait_time","blkio.io_service_time","blkio.io_queued","blkio.throttle.io_service_bytes","blkio.throttle.io_serviced","blkio.io_merged","blkio.io_time","blkio.sectors","blkio.avg_queue_size","blkio.group_wait_time","blkio.idle_time","blkio.empty_time","blkio.dequeue"),"pids" to listOf("pids.current","pids.max","pids.events"),"schedtune" to listOf("schedtune.boost","schedtune.prefer_idle"),"freezer" to listOf("freezer.state"))
  fun read():JSONObject {
    val began=SystemClock.elapsedRealtimeNanos();val mount=File("/proc/self/mountinfo").readText();val membership=File("/proc/self/cgroup").readText();val direct=CgroupPaths.resolve(mount,membership)
    val targets=CgroupPaths.ancestors(direct)
    val rows=JSONArray();var bytes=0;var limited=false
    outer@for(target in targets) {
      val hugeNames=if(target.type=="cgroup2") listOf("2MB","1GB","64KB","16MB").flatMap{size->listOf("current","max","events","events.local","numa_stat").map{"hugetlb.$size.$it"}} else emptyList()
      val discoveredHuge=if(target.type=="cgroup2") File(target.path).list()?.filter{it.matches(Regex("hugetlb\\.[0-9]+[KMG]B\\.(current|max|events(\\.local)?|numa_stat)"))}?:emptyList() else emptyList()
      val names=if(target.type=="cgroup2")(v2+hugeNames+discoveredHuge).distinct() else target.controllers.flatMap{v1[it]?:emptyList()}.distinct()
      for(name in names) {
        if(rows.length()>=2048||bytes>=1048576||SystemClock.elapsedRealtimeNanos()-began>250000000){limited=true;break@outer}
        val path=target.path.trimEnd('/')+"/"+name;val row=JSONObject().put("path",path).put("cgroupVersion",target.type).put("ancestorDepth",target.ancestorDepth).put("startedUptimeNanos",SystemClock.elapsedRealtimeNanos().toString())
        try {val limit=minOf(65536,1048576-bytes);val raw=File(path).inputStream().use {input->val data=ByteArray(limit+1);var used=0;while(used<data.size){val n=input.read(data,used,data.size-used);if(n<0)break;used+=n};data.copyOf(used)};bytes+=raw.size;row.put("text",raw.copyOf(minOf(raw.size,limit)).toString(Charsets.UTF_8)).put("truncated",raw.size>limit).put("error",JSONObject.NULL)}
        catch(e:Exception){row.put("text",JSONObject.NULL).put("error","${e.javaClass.simpleName}: ${e.message}")}
        row.put("finishedUptimeNanos",SystemClock.elapsedRealtimeNanos().toString());rows.put(row)
      }
    }
    return JSONObject().put("membership",membership).put("resolvedGroups",JSONArray(targets.map{JSONObject().put("path",it.path).put("type",it.type).put("ancestorDepth",it.ancestorDepth).put("mountPath",it.mountPath).put("controllers",JSONArray(it.controllers.toList()))})).put("files",rows).put("readBytes",bytes).put("ancestorDepthLimitReached",targets.any{it.ancestorDepth==32&&it.path!=it.mountPath}).put("boundedScanLimitReached",limited).put("scope","reported cgroups and their mount-bounded ancestors; shared hierarchical counters must not be summed; raw limits and policy are retained without inferring an effective budget")
  }
}
