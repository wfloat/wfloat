import threading
import unittest

from wfloat._operations import CancellationEvent, OperationCancelledError, check_cancelled, ModelLifecycle


class CancellationTests(unittest.TestCase):
    def test_local_stop_does_not_mutate_application_event(self):
        caller = threading.Event()
        linked = CancellationEvent(caller)
        linked.set()
        self.assertTrue(linked.is_set())
        self.assertFalse(caller.is_set())
        with self.assertRaises(OperationCancelledError):
            check_cancelled(linked)

    def test_external_stop_is_visible(self):
        caller = threading.Event()
        linked = CancellationEvent(caller)
        self.assertFalse(linked.is_set())
        caller.set()
        self.assertTrue(linked.wait(0.1))
        self.assertTrue(caller.is_set())

    def test_wait_timeout(self):
        self.assertFalse(CancellationEvent().wait(0))

    def test_invalid_event(self):
        with self.assertRaises(TypeError):
            CancellationEvent(object())

    def test_independent_operations(self):
        one, two = CancellationEvent(), CancellationEvent()
        one.set()
        self.assertFalse(two.is_set())

    def test_context_cleanup_preserves_original_application_exception(self):
        class BrokenCleanup(ModelLifecycle):
            def unload(self):
                raise RuntimeError("cleanup")
        original = KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt) as caught:
            with BrokenCleanup():
                raise original
        self.assertIs(caught.exception, original)
        with self.assertRaisesRegex(RuntimeError, "cleanup"):
            with BrokenCleanup():
                pass
