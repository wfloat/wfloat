package com.wfloat.bench

import android.os.SystemClock
import java.io.File
import java.io.FileInputStream
import org.json.JSONArray
import org.json.JSONObject

/** Fixed read-only kernel interfaces. No vendor service, root or thermal control. */
internal object SysfsDetailSources {
  fun read(cpuDetails:Boolean=false,family:String="all"):JSONObject {
    val rows=JSONArray();val directories=JSONArray();val start=SystemClock.elapsedRealtimeNanos();var bytes=0;var limited=false
    val budgetNanos=if(!cpuDetails && family in listOf("thermal","qualcomm_bus_dcvs")) 2_000_000_000L else 150_000_000L
    fun expired()=SystemClock.elapsedRealtimeNanos()-start>budgetNanos || bytes>=262144 || rows.length()>=2048
    fun text(path:String) {
      if(expired()){limited=true;return}
      val row=JSONObject().put("path",path).put("startedUptimeNanos",SystemClock.elapsedRealtimeNanos().toString())
      try {
        val limit=minOf(16384,262144-bytes);val buffer=ByteArray(limit+1);val count=FileInputStream(path).use { stream -> var n=0;while(n<buffer.size){val got=stream.read(buffer,n,buffer.size-n);if(got<0)break;n+=got};n }
        bytes+=count;row.put("text",String(buffer,0,minOf(count,limit),Charsets.UTF_8)).put("truncated",count>limit).put("error",JSONObject.NULL)
      }catch(e:Exception){row.put("error",e.toString()).put("text",JSONObject.NULL)}
      row.put("finishedUptimeNanos",SystemClock.elapsedRealtimeNanos().toString());rows.put(row)
    }
    fun entries(path:String,pattern:Regex,fallbackNames:List<String> = emptyList(),fields:(File)->List<String>) {
      if(expired()){limited=true;directories.put(JSONObject().put("path",path).put("error","scan limit reached before directory"));return}
      val all=File(path).listFiles()?.filter {pattern.matches(it.name)}?.sortedBy {it.name}
      directories.put(JSONObject().put("path",path).put("names",all?.let {JSONArray(it.map {f->f.name})}?:JSONObject.NULL).put("error",if(all==null) "directory listing unavailable" else JSONObject.NULL))
      if(all==null && fallbackNames.isNotEmpty())directories.put(JSONObject().put("path",path).put("fallbackCandidates",JSONArray(fallbackNames)))
      for(dir in all?.take(128)?:fallbackNames.map {File(path,it)}) {if(expired()){limited=true;break};for(name in fields(dir)){if(expired()){limited=true;break};text("${dir.path}/$name")}}
      if((all?.size?:0)>128)limited=true
    }
    if(cpuDetails) {
      for(name in listOf("online","offline","possible","present","isolated","nohz_full","housekeeping"))text("/sys/devices/system/cpu/$name")
      val root=File("/sys/devices/system/cpu")
      val enumerated=root.listFiles()?.filter {it.name.matches(Regex("cpu[0-9]+"))}?.sortedBy {it.name}
      // Standard numbered kernel paths remain worth attempting if readdir is
      // denied: directory listing and traversal/read have separate permissions.
      val cpus=enumerated?: (0 until 32).map {File(root,"cpu$it")}
      directories.put(JSONObject().put("path",root.path).put("enumerated",enumerated!=null).put("candidateCpuNames",JSONArray(cpus.map {it.name})).put("error",if(enumerated==null) "listing unavailable; bounded standard-path candidates" else JSONObject.NULL))
      for(cpu in cpus.take(32)) {
        if(expired()){limited=true;break}
        for(name in listOf("cpufreq/scaling_cur_freq","cpufreq/cpuinfo_cur_freq","cpufreq/scaling_min_freq","cpufreq/scaling_max_freq","cpufreq/cpuinfo_min_freq","cpufreq/cpuinfo_max_freq","cpufreq/scaling_governor","cpufreq/stats/time_in_state","cpufreq/stats/total_trans","cpufreq/stats/trans_table","dcvsh_freq_limit","topology/physical_package_id","topology/die_id","topology/core_id","topology/cluster_id","topology/cluster_cpus_list","topology/core_cpus_list","topology/package_cpus_list","topology/thread_siblings_list","topology/core_siblings_list"))text("${cpu.path}/$name")
        entries("${cpu.path}/cache",Regex("index[0-9]+"),(0..7).map {"index$it"}) {listOf("id","level","type","size","coherency_line_size","number_of_sets","ways_of_associativity","physical_line_partition","shared_cpu_list","allocation_policy","write_policy")}
        entries("${cpu.path}/cpuidle",Regex("state[0-9]+"),(0..7).map {"state$it"}) {listOf("name","desc","latency","residency","power","usage","time","above","below","rejected","disable","default_status","s2idle/time","s2idle/usage")}
      }
      if(cpus.size>32)limited=true
    } else {
    if(family=="samsung_cpu_limits") {
      // No limit_stat: reading rebases millisecond accounting and discards
      // sub-ms fractions. No vtable: reviewed getter logs and leaks a policy
      // reference on early returns. info retains virtual/real policy context.
      for(name in listOf("cpufreq_table","cpufreq_max_limit","cpufreq_min_limit","over_limit","info","sched_boost_type","vol_based_clk","vbf_offset","aboost_enabled","aboost_silver_low"))text("/sys/devices/system/cpu/cpufreq_limit/$name")
    }
    if(family=="kgsl_pagetables") {
      // KGSL page-table mapping accounting, not resident GPU memory.
      // 0/1 are driver-global/secure names; own PID is a separate table.
      for(id in listOf("0","1",android.os.Process.myPid().toString()).distinct())
        for(name in listOf("entries","mapped","max_mapped"))text("/sys/class/kgsl/kgsl/pagetables/$id/$name")
    }
    if(family=="qualcomm_bus_dcvs") {
      // Reviewed Qualcomm dcvs/memlat/bwmon getters: cached votes or SCMI
      // GET requests. No reset, log flush, trace enable or policy writes.
      // cur_freq is a vote/target, not measured bandwidth or residency.
      val root="/sys/devices/system/cpu/bus_dcvs"
      for(name in listOf("sample_ms","cpucp_sample_ms","hlos_cpucp_offset"))text("$root/memlat_settings/$name")
      entries(root,Regex("DDR|DDRQOS|L3|LLCC"),listOf("DDR","DDRQOS","L3","LLCC")) {bus ->
        entries(bus.path,Regex("memlat|.*memlat:.*|.*bwmon.*")) {mon ->
          when {
            mon.name=="memlat" -> listOf("adaptive_cur_freq","sampling_cur_freq","adaptive_low_freq","adaptive_high_freq")
            mon.name.contains("bwmon") -> listOf("cur_freq","min_freq","max_freq","sample_ms","window_ms","guard_band_mbps","decay_rate","io_percent","bw_step","up_scale","up_thres","down_thres","down_count","hist_memory","hyst_trigger_count","hyst_length","idle_length","idle_mbps","ab_scale","mbps_zones","second_vote_limit")
            else -> listOf("cur_freq","min_freq","max_freq","freq_map","ipm_ceil","fe_stall_floor","be_stall_floor","freq_scale_pct","wb_pct_thres","wb_filter_ipm","freq_scale_ceil_mhz","freq_scale_floor_mhz")
          }
        }
        listOf("cur_freq","available_frequencies","hw_min_freq","hw_max_freq","boost_freq")
      }
    }
    if(family=="backlight") {
      entries("/sys/class/backlight",Regex("[A-Za-z0-9_.:-]+"),listOf("panel0-backlight","lcd-backlight")) {listOf("brightness","actual_brightness","max_brightness","bl_power","type","scale")}
    }
    if(family=="slab") {
      // Native aggregate/node/CPU text; read handlers count/copy without reset.
      // Debug validation, shrink, allocation stacks and tracing are excluded.
      entries("/sys/kernel/slab",Regex("[A-Za-z0-9_:.-]+"),listOf("kmalloc-64","kmalloc-128","kmalloc-256")) {
        listOf("object_size","slab_size","size","align","objects","objects_partial","total_objects","slabs","partial","cpu_slabs","slabs_cpu_partial","objs_per_slab","order","aliases","min_partial","cpu_partial","reclaim_account","hwcache_align","cache_dma","destroy_by_rcu","usersize","alloc_fastpath","alloc_slowpath","free_rcu_sheaf","free_rcu_sheaf_fail","free_fastpath","free_slowpath","free_add_partial","free_remove_partial","alloc_slab","alloc_node_mismatch","free_slab","order_fallback","cmpxchg_double_fail","sheaf_flush","sheaf_refill","sheaf_alloc","sheaf_free","barn_get","barn_get_fail","barn_put","barn_put_fail","sheaf_prefill_fast","sheaf_prefill_slow","sheaf_prefill_oversize","sheaf_return_fast","sheaf_return_slow")
      }
    }
    if(family=="ufs_monitor") {
      val fields=listOf("monitor_enable","monitor_chunk_size")+listOf("read","write").flatMap {direction -> listOf("total_sectors","total_busy","nr_requests","req_latency_avg","req_latency_min","req_latency_max","req_latency_sum").map {"${direction}_$it"}}
      // Cached host-monitor counters only, no enable/reset and no live device
      // descriptor commands. Time fields are microseconds; scope is controller.
      entries("/sys/bus/platform/devices",Regex(".*(ufs|ufshc).*"),listOf("1d84000.ufshc","14700000.ufs")){fields.map {"monitor/$it"}}
      for(driver in listOf("ufshcd","ufshcd-qcom","ufshcd-exynos","ufshcd-mtk"))
        entries("/sys/bus/platform/drivers/$driver",Regex(".*(ufs|ufshc).*")){fields.map {"monitor/$it"}}
    }
    if(family=="qualcomm_core_control") {
      // Reviewed core_ctl show handlers copy cached policy/load state under
      // state_lock; they do not clear busy history or change CPU availability.
      entries("/sys/devices/system/cpu",Regex("cpu[0-9]+"),(0 until 32).map {"cpu$it"}) {
        listOf("min_cpus","max_cpus","offline_delay_ms","busy_up_thres","busy_down_thres","task_thres","is_big_cluster","need_cpus","active_cpus","global_state","not_preferred","enable").map {"core_ctl/$it"}
      }
      for(name in listOf("aggr_mode","aggr_iobusy"))text("/sys/module/msm_performance/workload_modes/$name")
    }
    if(family=="iio_power") {
      entries("/sys/bus/iio/devices",Regex("iio:device[0-9]+"),(0..3).map {"iio:device$it"}) {dir ->
        val names=dir.list()?.filter {it.matches(Regex("in_(temp|voltage|current|power|energy)[A-Za-z0-9_-]*_(raw|input|scale|offset|label|sampling_frequency|oversampling_ratio|calibscale|calibbias|integration_time|hardwaregain)"))}?:emptyList()
        listOf("name")+names
      }
      // A raw read may request an ADC conversion. No sensor buffer/trigger,
      // sampling configuration, calibration, resets or unrelated motion inputs.
    }
    if(family=="pmu_catalog") {
      // Event definitions and encoding metadata only. Never open a PMU device,
      // enable a counter or write configuration while enumerating this catalog.
      entries("/sys/bus/event_source/devices",Regex("[A-Za-z0-9_.:-]+")) { dir ->
        val fields=mutableListOf("type","cpumask","cpus","nr_addr_filters","perf_event_mux_interval_ms")
        for(sub in listOf("caps","format","events")) {
          val children=File(dir,sub).listFiles()?.filter {it.name.matches(Regex("[A-Za-z0-9_.:-]+")) && it.isFile}?.sortedBy {it.name}
          directories.put(JSONObject().put("path","${dir.path}/$sub").put("names",children?.let {JSONArray(it.map {f->f.name})}?:JSONObject.NULL).put("error",if(children==null) "directory listing unavailable or absent" else JSONObject.NULL))
          if((children?.size?:0)>512)limited=true
          for(child in children?.take(512)?:emptyList())fields.add("$sub/${child.name}")
        }
        fields
      }
    }
    if(family=="wakeup") {
      entries("/sys/class/wakeup",Regex("wakeup[0-9]+"),(0..15).map {"wakeup$it"}) {
        listOf("name","active_count","event_count","wakeup_count","expire_count","active_time_ms","total_time_ms","max_time_ms","last_change_ms","prevent_suspend_time_ms")
      }
      text("/sys/kernel/debug/wakeup_sources")
    }
    if(family=="suspend") {
      // /sys/power/wakeup_count is deliberately excluded: its read can block
      // until in-progress wakeup events complete (suspend handshake protocol).
      for(name in listOf("state","mem_sleep","disk","autosleep","pm_async","pm_wakeup_irq"))text("/sys/power/$name")
      for(name in listOf("success","fail","failed_freeze","failed_prepare","failed_resume","failed_resume_early","failed_resume_noirq","failed_suspend","failed_suspend_late","failed_suspend_noirq","last_failed_dev","last_failed_errno","last_failed_step","last_hw_sleep","total_hw_sleep","max_hw_sleep"))text("/sys/power/suspend_stats/$name")
      text("/sys/kernel/debug/suspend_stats")
    }
    if(family=="runtime_power") {
      val fields=listOf("control","async","wakeup","wakeup_count","wakeup_active_count","wakeup_abort_count","wakeup_expire_count","wakeup_active","wakeup_total_time_ms","wakeup_max_time_ms","wakeup_last_time_ms","wakeup_prevent_sleep_time_ms","autosuspend_delay_ms","pm_qos_resume_latency_us","pm_qos_latency_tolerance_us","pm_qos_no_power_off","runtime_status","runtime_active_time","runtime_suspended_time","runtime_usage","runtime_enabled","runtime_active_kids")
      for((root,pattern,fallback) in listOf(Triple("/sys/devices/system/cpu",Regex("cpu[0-9]+"),listOf("cpu0")),Triple("/sys/class/devfreq",Regex(".+"),emptyList()),Triple("/sys/class/block",Regex(".+"),listOf("sda","mmcblk0","zram0")),Triple("/sys/class/kgsl",Regex("kgsl-3d[0-9]+"),listOf("kgsl-3d0"))))
        entries(root,pattern,fallback){fields.map {"power/$it"}+fields.map {"device/power/$it"}}
    }
    if(family=="powercap") {
      // Bounded control/zone traversal, never energy resets or policy writes.
      fun zones(root:String,depth:Int) {
        if(depth>3||expired()){limited=true;return}
        val all=File(root).listFiles()?.filter {it.isDirectory && it.name !in listOf("device","subsystem","power") && (it.name.contains(":") || depth==0)}?.sortedBy {it.name}
        directories.put(JSONObject().put("path",root).put("names",all?.let {JSONArray(it.map {f->f.name})}?:JSONObject.NULL).put("error",if(all==null)"directory listing unavailable" else JSONObject.NULL))
        for(zone in all?.take(32)?:emptyList()) {
          if(expired()){limited=true;break}
          for(name in listOf("name","energy_uj","max_energy_range_uj","power_uw","max_power_range_uw","enabled"))text("${zone.path}/$name")
          val constraints=zone.list()?.filter {it.matches(Regex("constraint_[0-9]+_(name|power_limit_uw|time_window_us|max_power_uw|min_power_uw|max_time_window_us|min_time_window_us)"))}?.sorted()?:emptyList()
          for(name in constraints.take(64))text("${zone.path}/$name")
          zones(zone.path,depth+1)
        }
        if((all?.size?:0)>32)limited=true
      }
      zones("/sys/class/powercap",0)
    }
    if(family=="cpu_policy") {
      // Policy paths can have different traversal permissions than cpuN aliases.
      // Keep hardware feedback distinct from requested scaling frequency.
      entries("/sys/devices/system/cpu/cpufreq",Regex("policy[0-9]+"),(0 until 32).map {"policy$it"}) {
        listOf("affected_cpus","related_cpus","bios_limit","cpuinfo_cur_freq","cpuinfo_avg_freq","cpuinfo_min_freq","cpuinfo_max_freq","cpuinfo_transition_latency","scaling_available_frequencies","scaling_available_governors","scaling_driver","scaling_governor","scaling_cur_freq","scaling_min_freq","scaling_max_freq","scaling_setspeed","stats/time_in_state","stats/total_trans","stats/trans_table")
      }
      text("/sys/devices/system/cpu/cpufreq/boost")
    }
    if((family=="thermal"||family=="cooling"||family=="all") && File("/sys/class/thermal").list()==null) {
      directories.put(JSONObject().put("path","/sys/class/thermal").put("fallbackCandidates","thermal_zone0..15 type/temp; cooling_device0..15 type/cur_state/max_state"))
      for(i in 0..15){if(family!="cooling")for(name in listOf("type","temp"))text("/sys/class/thermal/thermal_zone$i/$name");if(family!="thermal")for(name in listOf("type","cur_state","max_state"))text("/sys/class/thermal/cooling_device$i/$name")}
    }
    val powerFields=listOf("type","status","health","present","online","capacity","capacity_level","voltage_now","voltage_avg","current_now","current_avg","charge_counter","charge_now","charge_full","charge_full_design","energy_now","energy_full","energy_full_design","power_now","temp","cycle_count","time_to_empty_now","time_to_full_now","time_to_empty_avg","time_to_full_avg","voltage_ocv","voltage_min_design","voltage_max_design","voltage_max","current_max","input_current_limit","input_voltage_limit","charge_type","charge_control_limit","charge_control_limit_max","temp_ambient","capacity_alert_min","capacity_alert_max","temp_alert_min","temp_alert_max","temp_min","temp_max","voltage_min","capacity_error_margin","charge_control_start_threshold","charge_control_end_threshold","charge_types","charge_term_current","precharge_current","charge_behaviour","technology","internal_resistance","state_of_health","input_power_limit","usb_type","charge_avg","charge_empty","charge_empty_design","energy_avg","energy_empty","energy_empty_design","power_avg","constant_charge_current","constant_charge_current_max","constant_charge_voltage","constant_charge_voltage_max","voltage_boot","current_boot","scope")
    if((family=="power_supply"||family=="all") && File("/sys/class/power_supply").list()==null) {
      directories.put(JSONObject().put("path","/sys/class/power_supply").put("fallbackCandidates",JSONArray(listOf("battery"))))
      for(name in powerFields)text("/sys/class/power_supply/battery/$name")
    }
    // Read each zone identity/temperature before optional trip/policy detail.
    if(family=="kgsl") {
      // Qualcomm KGSL driver ABI candidates, independently attempted as app UID.
      // kgsl_sharedmem.c: process accounting and driver-wide bytes, not dedicated VRAM.
      val pid=android.os.Process.myPid()
      for(name in listOf("gpumem_mapped","gpumem_unmapped","imported_mem","kernel","kernel_max","user","user_max","ion","ion_max"))text("/sys/class/kgsl/kgsl/proc/$pid/$name")
      for(name in listOf("vmalloc","vmalloc_max","page_alloc","page_alloc_max","coherent","coherent_max","secure","secure_max","mapped","mapped_max"))text("/sys/class/kgsl/kgsl/$name")
      // gpubusy/gpu_busy_percentage can clear shared cached stats when powered
      // off in KGSL. They are deliberately excluded from passive collection.
      for(name in listOf("gpuclk","max_gpuclk","min_gpuclk","thermal_pwrlevel","num_pwrlevels","gpu_model","gpu_available_frequencies","clock_mhz","freq_table_mhz","temp","reset_count","ifpc_count","throttling","hwcg","sptp_pc","lm","acd","bcl","dms","lpac","gpu_llc_slice_enable","gpuhtw_llc_slice_enable","devfreq/cur_freq","devfreq/min_freq","devfreq/max_freq","devfreq/available_frequencies","devfreq/trans_stat"))text("/sys/class/kgsl/kgsl-3d0/$name")
    }
    if(family=="samsung_gpu") {
      // Samsung exposes common aliases over different underlying GPU drivers.
      // Preserve native units: gpu_tmu formatting differs between drivers.
      for(name in listOf("gpu_model","gpu_clock","gpu_min_clock","gpu_max_clock","gpu_freq_table","gpu_tmu"))text("/sys/kernel/gpu/$name")
      val exynos=android.os.Build.HARDWARE.lowercase().let {it.startsWith("exynos")||it.matches(Regex("s5e[0-9]+"))}
      val maliModel=(0 until rows.length()).map {rows.getJSONObject(it)}.any {it.optString("path")=="/sys/kernel/gpu/gpu_model" && it.optString("text").contains("mali",ignoreCase=true)}
      val mediatekSamsung=android.os.Build.MANUFACTURER.equals("samsung",ignoreCase=true) && android.os.Build.HARDWARE.matches(Regex("mt[0-9]+"))
      if(exynos && maliModel) {
        // Reviewed gpex cached getters. Do not read egp_profile: it consumes
        // shared frame records. Qualcomm's gpu_busy alias also resets stats.
        for(name in listOf("gpu_busy","gpu_governor","gpu_available_governor","gpu_mm_min_clock"))text("/sys/kernel/gpu/$name")
        for(name in listOf("clock","asv_table","time_in_state","dvfs_max_lock","dvfs_min_lock","dvfs_max_lock_status","dvfs_min_lock_status","tmu","weight_table_idx_0","weight_table_idx_1","queued_threshold_0","queued_threshold_1"))text("/sys/class/misc/mali0/device/$name")
      } else if(mediatekSamsung) {
        // GED SKI -> mtk_get_gpu_loading -> cached gpu_av_loading. Unlike
        // loading2(reset), this getter does not consume/reset shared samples.
        // Both governor strings are hardcoded "Default" in the reviewed SKI.
        for(name in listOf("gpu_busy","gpu_governor","gpu_available_governor"))text("/sys/kernel/gpu/$name")
      } else directories.put(JSONObject().put("path","/sys/kernel/gpu/gpu_busy").put("error","not queried: reviewed Exynos/Mali or Samsung/MediaTek driver identity not established; other drivers may reset shared statistics"))
    }
    if(family=="sgpu") {
      // Samsung Xclipse SGPU: cached getters in devfreq/interface. The reviewed
      // S5E9925 device tree supplies the fallback address. Keep raw percentages:
      // current_utilization is compute-weighted/capped, not pure busy time;
      // current_cu_utilization is compute activity, not hardware CU occupancy.
      entries("/sys/class/devfreq",Regex(".+"),listOf("16e00000.sgpu")) {
        listOf("dvfs_table","available_governors","available_utilization_sources","current_utilization","current_cu_utilization","job_queue_count","time_in_state","total_kernel_pages","local_minlock_status","highspeed","utilization_source","governor","wakeup","min_freq","max_freq","valid_time","min_thresholds","max_thresholds","downstay_times","power_ratio","compute_weight","local_minlock_util","local_minlock_temp").map {"interface/$it"}+listOf("profiler/weight_table_idx","profiler/freq_margin")
      }
      // profiler/egp_profile consumes shared frame records: never read it here.
    }
    if(family=="mediatek_ged") {
      // MediaTek GED exports cached utilization components and frequency policy.
      // These handlers read globals/getters; no profiling enablement, writes,
      // counter resets or power/governor changes. Keep native text and units.
      for(name in listOf("gpu_loading","gpu_block","gpu_idle","gpu_dvfs_enable","gpu_debug_enable","gpu_bottom_freq","gpu_cust_boost_freq","gpu_cust_upbound_freq"))text("/sys/module/ged/parameters/$name")
      for(root in listOf("/sys/kernel/ged/hal","/sys/kernel/debug/ged/hal","/d/ged/hal"))
        for(name in listOf("gpu_utilization","current_freqency","previous_freqency","total_gpu_freq_level_count"))text("$root/$name")
    }
    if(family=="mali") {
      // Pixel's gpu_top read resets shared interval counters: deliberately excluded.
      val fields=listOf("gpuinfo","gpu_memory","utilization","clock_info","dvfs_table","power_stats","uid_time_in_state","available_frequencies","cur_freq","max_freq","min_freq","min_compute_freq","scaling_max_freq","scaling_min_freq","time_in_state","trans_stat","governor","capacity_headroom","capacity_history_depth")
      for(name in fields)text("/sys/class/misc/mali0/device/$name")
      val discovered=File("/sys/devices/platform").listFiles()?.filter {it.name.matches(Regex("[0-9a-fA-F]+[.]mali"))}?.map {it.path}?:emptyList()
      val roots=(discovered+listOf("/sys/devices/platform/1f000000.mali")).distinct().take(8)
      for(root in roots)for(name in fields)text("$root/$name")
      text("/sys/kernel/pixel_stat/gpu/mem/total_page_count")
    }
    if(family=="dmabuf") {
      for(path in listOf("/sys/kernel/ion/total_heaps_kb","/sys/kernel/ion/total_pools_kb","/sys/kernel/dma_heap/total_pools_kb"))text(path)
      entries("/sys/kernel/mm/cma",Regex("[A-Za-z0-9_.:-]+"),listOf("reserved","linux,cma")) {listOf("alloc_pages_success","alloc_pages_fail","release_pages_success","total_pages","available_pages")}

      // CONFIG_DMABUF_SYSFS_STATS: inode-keyed system buffers, not app RAM.
      // A denied readdir need not deny a known inode's readable attributes.
      // Only use DMA-BUF identities observed through this process's own FDs.
      val known=File("/proc/self/fd").listFiles()?.take(128)?.mapNotNull {fd ->
        try {if(android.system.Os.readlink(fd.path).contains("dmabuf")) android.system.Os.stat(fd.path).st_ino.toString() else null}catch(_:Exception){null}
      }?.distinct()?:emptyList()
      entries("/sys/kernel/dmabuf/buffers",Regex("[0-9]+"),known) {listOf("size","exporter_name")}
    }
    if(family=="network") {
      val names=try {java.net.NetworkInterface.getNetworkInterfaces()?.toList()?.map {it.name}?.filter {it.matches(Regex("[A-Za-z0-9_.:-]+"))}?:emptyList()}catch(_:Exception){emptyList()}
      val stats=listOf("rx_packets","tx_packets","rx_bytes","tx_bytes","rx_errors","tx_errors","rx_dropped","tx_dropped","multicast","collisions","rx_length_errors","rx_over_errors","rx_crc_errors","rx_frame_errors","rx_fifo_errors","rx_missed_errors","tx_aborted_errors","tx_carrier_errors","tx_fifo_errors","tx_heartbeat_errors","tx_window_errors","rx_compressed","tx_compressed","rx_nohandler","rx_otherhost_dropped")
      entries("/sys/class/net",Regex("[A-Za-z0-9_.:-]+"),names.ifEmpty {listOf("lo","wlan0","eth0","rmnet_data0")} ) {
        listOf("ifindex","type","mtu","flags","operstate","carrier","carrier_changes","carrier_up_count","carrier_down_count","speed","duplex","tx_queue_len")+stats.map {"statistics/$it"}
      }
    }
    if(family=="filesystem") {
      val fallback=(0..15).map {"dm-$it"}+listOf("sda","sda1","userdata")
      entries("/sys/fs/f2fs",Regex("(?!features$)[A-Za-z0-9_.:-]+"),fallback) {
        listOf("lifetime_write_kbytes","dirty_segments","free_segments","ovp_segments","reserved_blocks","current_reserved_blocks","unusable","encoding","mounted_time_sec","main_blkaddr","cp_foreground_calls","cp_background_calls","gc_foreground_calls","gc_background_calls","moved_blocks_foreground","moved_blocks_background","avg_vblocks","compr_written_block","compr_saved_block","compr_new_inode","iostat_enable","iostat_period_ms","pending_discard","issued_discard","queued_discard","undiscard_blks","current_atomic_write","peak_atomic_write","committed_atomic_block","revoked_atomic_block","gc_reclaimed_segments","gc_segment_mode","sb_status","cp_status")
      }
      entries("/sys/fs/ext4",Regex("(?!features$)[A-Za-z0-9_.:-]+"),fallback) {
        listOf("delayed_allocation_blocks","session_write_kbytes","lifetime_write_kbytes","errors_count","warning_count","msg_count","first_error_time","last_error_time","reserved_clusters")
      }
    }
    if(family=="memory_policy") {
      for(name in listOf("enabled","defrag","shmem_enabled","use_zero_page","hpage_pmd_size","khugepaged/pages_collapsed","khugepaged/full_scans","khugepaged/pages_to_scan","khugepaged/scan_sleep_millisecs","khugepaged/alloc_sleep_millisecs","khugepaged/max_ptes_none","khugepaged/max_ptes_swap","khugepaged/max_ptes_shared"))text("/sys/kernel/mm/transparent_hugepage/$name")
      entries("/sys/kernel/mm/transparent_hugepage",Regex("hugepages-[0-9]+kB")){listOf("enabled","shmem_enabled","stats/anon_fault_alloc","stats/anon_fault_fallback","stats/anon_fault_fallback_charge","stats/swpout","stats/swpout_fallback","stats/nr_anon","stats/nr_anon_partially_mapped","stats/split","stats/split_failed","stats/split_deferred")}
      for(name in listOf("pages_shared","pages_sharing","pages_unshared","pages_volatile","pages_skipped","full_scans","stable_node_chains","stable_node_dups","ksm_zero_pages","general_profit","run","pages_to_scan","sleep_millisecs","merge_across_nodes","use_zero_pages","max_page_sharing"))text("/sys/kernel/mm/ksm/$name")
      entries("/sys/kernel/mm/hugepages",Regex("hugepages-[0-9]+kB")){listOf("nr_hugepages","nr_overcommit_hugepages","free_hugepages","resv_hugepages","surplus_hugepages")}
      for(name in listOf("online","possible","has_cpu","has_normal_memory"))text("/sys/devices/system/node/$name")
      entries("/sys/devices/system/node",Regex("node[0-9]+"),listOf("node0")){listOf("cpulist","distance","meminfo","numastat","vmstat")}
      // Only side-effect-free controls; never stat_refresh/drop_caches/compact_memory.
      for(name in listOf("swappiness","min_free_kbytes","watermark_scale_factor","watermark_boost_factor","overcommit_memory","overcommit_ratio","overcommit_kbytes","dirty_background_ratio","dirty_background_bytes","dirty_ratio","dirty_bytes","dirty_expire_centisecs","dirty_writeback_centisecs","vfs_cache_pressure","page-cluster","max_map_count","compact_unevictable_allowed","compaction_proactiveness","extfrag_threshold"))text("/proc/sys/vm/$name")
    }
    if(family=="block") {
      entries("/sys/block",Regex("zram[0-9]+"),listOf("zram0")) {listOf("mm_stat","io_stat","bd_stat","disksize","orig_data_size","compr_data_size","mem_used_total","mem_limit","mem_used_max","same_pages","pages_compacted","huge_pages","comp_algorithm","initstate","writeback_limit","writeback_limit_enable")}
      val fields=listOf("stat","inflight","size","ro","removable","alignment_offset","discard_alignment","queue/logical_block_size","queue/physical_block_size","queue/minimum_io_size","queue/optimal_io_size","queue/read_ahead_kb","queue/max_sectors_kb","queue/max_hw_sectors_kb","queue/max_segments","queue/max_segment_size","queue/nr_requests","queue/scheduler","queue/rotational","queue/write_cache","queue/discard_granularity","queue/discard_max_bytes","queue/discard_max_hw_bytes","queue/nr_zones","queue/zoned","queue/chunk_sectors")
      entries("/sys/block",Regex(".+")){fields}
      if(File("/sys/block").list()==null) {
        directories.put(JSONObject().put("path","/sys/block").put("fallbackCandidates","sda..sdd, mmcblk0, nvme0n1, dm-0..3, zram0"))
        for(device in listOf("sda","sdb","sdc","sdd","mmcblk0","nvme0n1","dm-0","dm-1","dm-2","dm-3","zram0")) for(name in fields)text("/sys/block/$device/$name")
      }
    }
    if(family=="thermal"||family=="all") entries("/sys/class/thermal",Regex("thermal_zone[0-9]+")) {listOf("type","temp")}
    if(family=="thermal"||family=="all") entries("/sys/class/thermal",Regex("thermal_zone[0-9]+")) {dir ->
      val names=dir.list()?.filter {it.matches(Regex("trip_point_[0-9]+_(type|temp|hyst)"))}?.sorted()
      listOf("mode","policy","available_policies","sustainable_power","slope","offset","integral_cutoff","k_po","k_pu","k_i","k_d")+(names?: (0..15).flatMap {listOf("trip_point_${it}_type","trip_point_${it}_temp","trip_point_${it}_hyst")})
    }
    if(family=="cooling"||family=="all") entries("/sys/class/thermal",Regex("cooling_device[0-9]+")) {listOf("type","cur_state","max_state","stats/time_in_state_ms","stats/total_trans","stats/trans_table")}
    if(family=="devfreq"||family=="all") entries("/sys/class/devfreq",Regex(".+")) {listOf("name","cur_freq","min_freq","max_freq","available_frequencies","governor","available_governors","trans_stat","polling_interval","load")}
    if(family=="power_supply"||family=="all") entries("/sys/class/power_supply",Regex(".+")) {powerFields}
    if(family=="hwmon"||family=="all") entries("/sys/class/hwmon",Regex("hwmon[0-9]+")) {dir -> listOf("name","update_interval")+(dir.list()?.filter {it.matches(Regex("(temp|power|energy|in|curr|fan|humidity|freq)[0-9]+_(input|average|label|min|max|crit|lcrit|alarm|min_alarm|max_alarm|crit_alarm|lcrit_alarm|lowest|highest|offset|fault|type|enable|min_hyst|max_hyst|crit_hyst|lcrit_hyst|average_interval|average_interval_min|average_interval_max|cap|cap_min|cap_max|cap_hyst|accuracy|input_highest|input_lowest|average_highest|average_lowest|average_max|average_min|rated_min|rated_max|emergency|emergency_hyst|emergency_alarm|cap_alarm|div|pulses|target)"))}?:emptyList())}
    }
    return JSONObject().put("family",if(cpuDetails) "cpu" else family).put("betweenQueryBudgetNanos",budgetNanos.toString()).put("directories",directories).put("files",rows).put("bytesRead",bytes).put("boundedScanLimitReached",limited).put("startedUptimeNanos",start.toString()).put("finishedUptimeNanos",SystemClock.elapsedRealtimeNanos().toString())
  }
}
