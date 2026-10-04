"""Synchronous operation ownership and cooperative cancellation."""
from __future__ import annotations

import threading
from contextlib import contextmanager


class OperationCancelledError(Exception):
    """An operation stopped before producing its complete result."""


class CancellationEvent:
    """Operation-owned cancellation linked to a caller event without mutating it."""

    def __init__(self, external=None):
        if external is not None and not isinstance(external, threading.Event):
            raise TypeError("cancel_event must be a threading.Event")
        self._external = external
        self._local = threading.Event()

    def is_set(self):
        return self._local.is_set() or (self._external is not None and self._external.is_set())

    def set(self):
        self._local.set()

    def wait(self, timeout=None):
        import time
        deadline = None if timeout is None else time.monotonic() + timeout
        while not self.is_set():
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                return False
            self._local.wait(0.02 if remaining is None else min(remaining, 0.02))
        return True


def check_cancelled(event):
    if event is not None and event.is_set():
        raise OperationCancelledError("Operation cancelled")


class ModelLifecycle:
    """One active operation per model, serialized without polling native pointers."""

    def __init__(self):
        self._operation_lock = threading.RLock()
        self._closed = False

    def _ensure_open(self):
        if self._closed:
            raise RuntimeError("Model has been unloaded")

    @contextmanager
    def _operation(self):
        with self._operation_lock:
            self._ensure_open()
            yield

    def __enter__(self):
        self._ensure_open()
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            self.unload()
        except BaseException:
            if exc is None:
                raise
            if hasattr(exc, "add_note"):
                exc.add_note("Model cleanup also failed; retry unload() before deleting its assets.")
        return False
