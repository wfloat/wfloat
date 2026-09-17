package com.wfloat.bench
import org.junit.Assert.*
import org.junit.Test

class NativeMallocCheckTest {
  private class Ops : NativeMallocOperations {
    var bytes=0L;var closed=0;var steps=0;var failAt=0
    override fun step(operation: Int, guard: NativeMallocGuard) {
      check(guard.isActive());++steps
      bytes=when(operation){0->0L;2->8388608L;else->16777216L}
      if(steps==failAt) error("injected partial allocation failure")
    }
    override fun heldBytes()=bytes
    override fun close(){++closed;bytes=0}
  }
  private fun counters()=listOf(nativeHeapAllocatedFields(123),nativeHeapFreeFields(456),nativeHeapSizeFields(789))
  @Test fun completeOrderedRunClosesOnce() {
    val ops=Ops();var ticks=100L
    val result=runNativeMallocCheck(1,{++ticks},{true},{ops},::counters)
    assertEquals("completed",result["stage"]);assertNull(result["error"])
    assertEquals(10,(result["phases"] as List<*>).size);assertEquals(9,ops.steps)
    assertEquals(1,ops.closed);assertEquals(0L,ops.bytes)
  }
  @Test fun partialAllocationFailureCleansUpAndRetainsPriorPhases() {
    val ops=Ops().apply{failAt=4};var ticks=0L
    val result=runNativeMallocCheck(2,{++ticks},{true},{ops},::counters)
    assertEquals("failed",result["stage"]);assertEquals(4,(result["phases"] as List<*>).size)
    assertEquals(1,ops.closed);assertEquals(0L,ops.bytes)
  }
  @Test fun lifecycleChangeDuringReadCancelsAndCleansUp() {
    val ops=Ops();var ticks=0L;var active=true;var reads=0
    val result=runNativeMallocCheck(3,{++ticks},{active},{ops},{if(++reads==2) active=false;counters()})
    assertEquals("cancelled",result["stage"]);assertEquals(1,(result["phases"] as List<*>).size)
    assertEquals(1,ops.closed);assertEquals(0L,ops.bytes)
  }
  @Test fun deadlineCancelsAfterAnAllocation() {
    val ops=Ops();var ticks=0L
    val result=runNativeMallocCheck(4,{ticks},{true},{ops},{if(ops.bytes>0) ticks=10_000_000_000;counters()})
    assertEquals("cancelled",result["stage"]);assertEquals(1,ops.closed);assertEquals(0L,ops.bytes)
  }
  @Test fun inactiveRequestDoesNotAllocate() {
    var created=false
    val result=runNativeMallocCheck(5,{0L},{false},{created=true;Ops()},::counters)
    assertEquals("cancelled",result["stage"]);assertFalse(created);assertTrue((result["phases"] as List<*>).isEmpty())
  }
  @Test fun unavailableCounterIsPreservedWithoutLosingOthers() {
    val ops=Ops();var ticks=0L
    val result=runNativeMallocCheck(6,{++ticks},{true},{ops},{listOf(nativeHeapAllocatedFields(null,"unavailable"),nativeHeapFreeFields(2),nativeHeapSizeFields(3))})
    assertEquals("completed",result["stage"])
    val phase=(result["phases"] as List<*>)[0] as Map<*,*>
    assertEquals("unavailable",(phase["allocated"] as Map<*,*>)["error"])
    assertEquals(2.0,(phase["free"] as Map<*,*>)["bytes"])
  }
}
