package com.wfloat.bench
import org.junit.Assert.*
import org.junit.Test
class CgroupPathsTest {
  @Test fun resolvesUnifiedAndLegacyMounts() {
    val mounts="1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n2 0 0:2 / /dev/cpuctl rw - cgroup cgroup rw,cpu,cpuacct"
    val targets=CgroupPaths.resolve(mounts,"0::/uid_123/pid_456\n2:cpu,cpuacct:/foreground")
    assertEquals(listOf("/sys/fs/cgroup/uid_123/pid_456","/dev/cpuctl/foreground"),targets.map{it.path})
  }
  @Test fun honorsMountedSubtreesAndEscapes() {
    val mounts="1 0 0:1 /uid_123 /mounted\\040group rw - cgroup2 cgroup rw"
    assertEquals("/mounted group/pid_456",CgroupPaths.resolve(mounts,"0::/uid_123/pid_456").single().path)
    assertTrue(CgroupPaths.resolve(mounts,"0::/uid_1234/pid_456").isEmpty())
    assertTrue(CgroupPaths.resolve(mounts,"0::/uid_123/../private").isEmpty())
  }
  @Test fun ancestorsStopAtMountIncludingRootMount() {
    val direct=CgroupPaths.resolve("1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw","0::/apps/uid_1")
    assertEquals(listOf("/sys/fs/cgroup/apps/uid_1","/sys/fs/cgroup/apps","/sys/fs/cgroup"),CgroupPaths.ancestors(direct).map{it.path})
    val root=CgroupPaths.resolve("1 0 0:1 / / rw - cgroup2 cgroup rw","0::/apps")
    assertEquals(listOf("/apps","/"),CgroupPaths.ancestors(root).map{it.path})
    assertEquals(listOf(0,1),CgroupPaths.ancestors(root).map{it.ancestorDepth})
  }
}
