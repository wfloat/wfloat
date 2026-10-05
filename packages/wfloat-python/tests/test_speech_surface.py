import ctypes
import os
from pathlib import Path
import threading
import unittest
from types import SimpleNamespace
from typing import Any, Iterable, Mapping, Optional, Union, get_type_hints
from unittest.mock import Mock, patch

import numpy as np

from wfloat._core import CoreTts
from wfloat import _tts_bridge
from wfloat._model import Model
from wfloat._operations import OperationCancelledError
from wfloat._speech import SpeechChunk, SpeechResult, SpeechSegment, SpeechStream, TextToSpeechModel, load_text_to_speech


class UnitNative:
    sample_rate = 10
    num_speakers = 20

    def __init__(self):
        self.calls = []
        self.prepared = []
        self.buffer = np.array([0.25, 0.5], dtype=np.float32)
        self.closed = False
        self.during_generate = None

    def prepare_wfloat_text(self, text, emotion, intensity):
        self.prepared.append((text, emotion, intensity))
        raw = text.split('|')
        raw = [part + '|' if i < len(raw) - 1 else part for i, part in enumerate(raw)]
        return SimpleNamespace(text=raw, text_clean=[part.strip('|') for part in raw])

    def generate(self, text, sid, speed):
        self.calls.append((text, sid, speed))
        if self.during_generate:
            self.during_generate()
        return SimpleNamespace(samples=self.buffer, sample_rate=self.sample_rate)

    def close(self):
        self.closed = True
        self.buffer[:] = -1


class WholeNative:
    sample_rate = 10
    num_speakers = 20

    def __init__(self):
        self.calls = []
        self.closed = False

    def synthesize_result(self, **kwargs):
        self.calls.append(kwargs)
        text = kwargs['text']
        return SimpleNamespace(
            audio=SimpleNamespace(samples=[0.1, 0.2], sample_rate=10),
            timeline=SimpleNamespace(chunks=[SimpleNamespace(text=text,
                highlight_start=0, highlight_end=len(text.encode('utf8')),
                start_sec=0, end_sec=0.2)]))

    def close(self):
        self.closed = True


class SpeechSurfaceTests(unittest.TestCase):
    def model(self, native=None):
        self.native = native if native is not None else UnitNative()
        return TextToSpeechModel(Model('fake', self.native))

    def test_public_type_hints_resolve_and_describe_dialogue_mappings(self):
        for name, result_type in (
            ('generate', SpeechResult), ('generate_dialogue', SpeechResult),
            ('generate_stream', SpeechStream), ('generate_dialogue_stream', SpeechStream),
        ):
            with self.subTest(method=name):
                hints = get_type_hints(getattr(TextToSpeechModel, name))
                self.assertIs(hints['return'], result_type)
                self.assertEqual(hints['cancel_event'], Optional[threading.Event])
                self.assertEqual(hints['voice_id'], Optional[Union[str, int]])
                for option in ('intensity', 'speed', 'pause_between_segments_ms'):
                    self.assertEqual(hints[option], Optional[float])
                self.assertEqual(hints['emotion'], Optional[str])
                if 'dialogue' in name:
                    self.assertEqual(hints['segments'], Iterable[Union[SpeechSegment, Mapping[str, Any]]])
                else:
                    self.assertIs(hints['text'], str)
        self.assertIs(get_type_hints(SpeechStream.__next__)['return'], SpeechChunk)
        self.assertIs(get_type_hints(SpeechStream.__iter__)['return'], SpeechStream)
        self.assertIs(get_type_hints(SpeechStream.__enter__)['return'], SpeechStream)
        self.assertIs(get_type_hints(TextToSpeechModel.__enter__)['return'], TextToSpeechModel)
        self.assertIs(get_type_hints(load_text_to_speech)['return'], TextToSpeechModel)

    def test_lazy_single_pass_no_result_and_no_producer(self):
        model = self.model()
        with model.generate_stream('A|B|C') as stream:
            self.assertFalse(hasattr(stream, 'result'))
            self.assertEqual(self.native.prepared, [])
            self.assertEqual(self.native.calls, [])
            next(stream)
            self.assertEqual(len(self.native.calls), 1)
            self.assertEqual(len(list(stream)), 2)
            self.assertEqual(list(stream), [])
        self.assertEqual(list(stream), [])

    def test_deliberate_exit_does_not_cancel_external_event(self):
        model = self.model()
        cancel = threading.Event()
        with model.generate_stream('A|B', cancel_event=cancel) as stream:
            next(stream)
        self.assertEqual(len(self.native.calls), 1)
        self.assertFalse(cancel.is_set())
        self.assertEqual(list(stream), [])

    def test_external_cancel_before_during_and_after_last_chunk(self):
        for when in ('before', 'during', 'after'):
            with self.subTest(when=when):
                model = self.model()
                cancel = threading.Event()
                with model.generate_stream('A', cancel_event=cancel) as stream:
                    if when == 'before':
                        cancel.set()
                    elif when == 'during':
                        self.native.during_generate = cancel.set
                    else:
                        next(stream)
                        cancel.set()
                    with self.assertRaises(OperationCancelledError):
                        next(stream)
                    self.assertTrue(cancel.is_set())
                    self.assertEqual(list(stream), [])

    def test_blocking_external_cancel(self):
        model = self.model()
        cancel = threading.Event()
        self.native.during_generate = cancel.set
        with self.assertRaises(OperationCancelledError):
            model.generate('A|B', cancel_event=cancel)
        self.assertEqual(len(self.native.calls), 1)
        self.native.during_generate = None
        self.assertGreater(model.generate('C').audio.samples.size, 0)

    def test_dialogue_timing_unicode_overrides_and_final_pause(self):
        model = self.model()
        result = model.generate_dialogue([
            {'text': 'é|🙂', 'voice_id': 'narrator_woman', 'emotion': 'joy', 'speed': 2},
            SpeechSegment('Bye', pause_after_ms=100),
        ], voice_id=2, emotion='sadness', intensity=0.7, pause_between_segments_ms=300)
        self.assertEqual(self.native.calls, [('é', 11, 2), ('🙂', 11, 2), ('Bye', 2, 1)])
        self.assertEqual(self.native.prepared, [('é|🙂', 'joy', 0.7), ('Bye', 'sadness', 0.7)])
        self.assertEqual([(t.segment_index, t.text_start, t.text_end) for t in result.timeline],
                         [(0, 0, 2), (0, 2, 3), (1, 0, 3)])
        self.assertEqual([(t.start_ms, t.end_ms) for t in result.timeline], [(0, 200), (200, 400), (700, 900)])
        np.testing.assert_array_equal(result.audio.samples, [0.25, 0.5, 0.25, 0.5, 0, 0, 0, 0.25, 0.5, 0])

    def test_pause_override_and_zero_default(self):
        model = self.model()
        result = model.generate_dialogue([{'text': 'A', 'pause_after_ms': 0}, {'text': 'B'}], pause_between_segments_ms=900)
        self.assertEqual(result.audio.samples.size, 4)
        self.assertEqual(model.generate('A|B').audio.samples.size, 4)

    def test_long_pause_is_bounded_and_offsets_include_silence(self):
        model = self.model()
        with model.generate_dialogue_stream([{'text': 'A', 'pause_after_ms': 2500}, {'text': 'B'}]) as stream:
            chunks = list(stream)
        self.assertEqual([c.audio.samples.size for c in chunks], [2, 10, 10, 5, 2])
        self.assertEqual([c.start_ms for c in chunks], [0, 200, 1200, 2200, 2700])
        self.assertEqual([c.timeline for c in chunks[1:4]], [[], [], []])

    def test_returned_buffers_survive_reuse_and_unload(self):
        model = self.model()
        with model.generate_stream('A|B') as stream:
            first = next(stream)
            self.native.buffer[:] = 0.75
            second = next(stream)
        result = model.generate('C')
        model.unload()
        np.testing.assert_array_equal(first.audio.samples, [0.25, 0.5])
        np.testing.assert_array_equal(second.audio.samples, [0.75, 0.75])
        np.testing.assert_array_equal(result.audio.samples, [0.75, 0.75])

    def test_validation_before_native_work(self):
        model = self.model()
        options = [dict(speed=0), dict(speed=float('inf')), dict(speed=True), dict(speed=1e100), dict(speed=1e-100),
                   dict(intensity=float('nan')), dict(intensity=2), dict(intensity='0.5'),
                   dict(voice_id=True), dict(voice_id=20), dict(voice_id=''),
                   dict(emotion=''), dict(emotion=42), dict(pause_between_segments_ms=-1),
                   dict(pause_between_segments_ms=1e300), dict(cancel_event=object())]
        for kwargs in options:
            with self.subTest(kwargs=kwargs), self.assertRaises((TypeError, ValueError)):
                model.generate_stream('A', **kwargs)
        for segments in ([], [{'text': 'A'}, {'text': ''}], [{'text': 'A', 'pause_after_ms': float('nan')}],
                         [{'text': 'A', 'typo': 3}], [{'text': 1}], [{'text': 'A\0B'}]):
            with self.subTest(segments=segments), self.assertRaises((TypeError, ValueError)):
                model.generate_dialogue_stream(segments)
        self.assertEqual(self.native.calls, [])
        self.assertEqual(self.native.prepared, [])

    def test_input_snapshot(self):
        model = self.model()
        segment = SpeechSegment('A', voice_id=1)
        stream = model.generate_dialogue_stream([segment])
        segment.text = 'B'
        segment.voice_id = 2
        with stream:
            list(stream)
        self.assertEqual(self.native.calls, [('A', 1, 1)])

    def test_alignment_failure_not_fabricated(self):
        model = self.model()
        self.native.prepare_wfloat_text = lambda *args: SimpleNamespace(text=['different'], text_clean=['A'])
        with self.assertRaisesRegex(RuntimeError, 'alignment'):
            model.generate('A')
        self.assertEqual(self.native.calls, [])

    def test_keyboard_interrupt_and_native_error_propagate_and_release(self):
        model = self.model()
        for error in (KeyboardInterrupt(), RuntimeError('native failed')):
            def fail():
                raise error
            self.native.during_generate = fail
            with self.assertRaises(type(error)) as caught:
                model.generate('A')
            self.assertIs(caught.exception, error)
            self.native.during_generate = None
            model.generate('B')

    def test_unload_closes_paused_streams_and_is_idempotent(self):
        model = self.model()
        stream = model.generate_stream('A|B')
        next(stream)
        model.unload()
        model.unload()
        self.assertTrue(self.native.closed)
        self.assertEqual(list(stream), [])
        with self.assertRaises(RuntimeError):
            model.generate('B')

    def test_failed_native_unload_retains_lease_and_can_retry(self):
        native, lease = UnitNative(), Mock()
        model = TextToSpeechModel(Model('fake', native), asset_lease=lease)
        stream = model.generate_stream('A|B')
        retained = next(stream)
        saved = retained.audio.samples.copy()
        error = RuntimeError('native cleanup failed')
        with patch.object(native, 'close', side_effect=error) as close:
            with self.assertRaises(RuntimeError) as caught:
                model.unload()
            self.assertIs(caught.exception, error)
            close.assert_called_once_with()
        self.assertFalse(model._closed)
        self.assertIs(model._asset_lease, lease)
        lease.release.assert_not_called()
        self.assertEqual(list(stream), [])
        model.unload()
        self.assertTrue(native.closed)
        self.assertTrue(model._closed)
        lease.release.assert_called_once_with()
        model.unload()
        lease.release.assert_called_once_with()
        np.testing.assert_array_equal(retained.audio.samples, saved)

    def test_model_context_preserves_original_exception_when_cleanup_fails(self):
        for original in (RuntimeError('callback failed'), KeyboardInterrupt()):
            with self.subTest(error=type(original).__name__):
                native, lease = UnitNative(), Mock()
                model = TextToSpeechModel(Model('fake', native), asset_lease=lease)
                with patch.object(native, 'close', side_effect=RuntimeError('cleanup failed')):
                    with self.assertRaises(type(original)) as caught:
                        with model:
                            raise original
                self.assertIs(caught.exception, original)
                if hasattr(original, 'add_note'):
                    self.assertTrue(any('retry unload()' in note for note in original.__notes__))
                lease.release.assert_not_called()
                model.unload()
                lease.release.assert_called_once_with()

    def test_model_context_propagates_cleanup_error_without_original_exception(self):
        model = self.model()
        error = RuntimeError('cleanup failed')
        with patch.object(self.native, 'close', side_effect=error):
            with self.assertRaises(RuntimeError) as caught:
                with model:
                    pass
        self.assertIs(caught.exception, error)
        model.unload()

    def test_asset_lease_release_can_retry_without_reclosing_native(self):
        native, lease = UnitNative(), Mock()
        lease.release.side_effect = [RuntimeError('release failed'), None]
        model = TextToSpeechModel(Model('fake', native), asset_lease=lease)
        with patch.object(native, 'close', wraps=native.close) as close:
            with self.assertRaisesRegex(RuntimeError, 'release failed'):
                model.unload()
            self.assertTrue(model._closed)
            self.assertIs(model._asset_lease, lease)
            model.unload()
            close.assert_called_once_with()
        self.assertIsNone(model._asset_lease)
        self.assertEqual(lease.release.call_count, 2)

    def test_reentrant_model_use_rejected_without_freeing_inflight_native(self):
        model = self.model()
        self.native.during_generate = model.unload
        with self.assertRaisesRegex(RuntimeError, 'reentrant'):
            model.generate('A')
        self.assertFalse(self.native.closed)
        self.native.during_generate = None
        model.unload()

    def test_current_native_shape_blocks_streaming_but_supports_blocking(self):
        model = self.model(WholeNative())
        with self.assertRaisesRegex(NotImplementedError, 'unit APIs'):
            model.generate_stream('Hello')
        self.assertEqual(self.native.calls, [])
        result = model.generate_dialogue([{'text': 'é🙂'}, {'text': 'B'}], pause_between_segments_ms=100)
        self.assertEqual(result.timeline[0].text_end, 2)
        self.assertEqual(result.timeline[1].start_ms, 300)
        self.assertEqual(result.audio.samples.size, 5)
        self.assertEqual(self.native.calls[0]['silence_padding_sec'], 0)

    def test_concurrent_next_rejected_without_interrupting_owner(self):
        model = self.model()
        entered, release = threading.Event(), threading.Event()
        def wait():
            entered.set()
            if not release.wait(5):
                raise RuntimeError('test synchronization timed out')
        self.native.during_generate = wait
        stream = model.generate_stream('A|B')
        chunks = []
        worker = threading.Thread(target=lambda: chunks.append(next(stream)))
        worker.start()
        try:
            self.assertTrue(entered.wait(5))
            with self.assertRaisesRegex(RuntimeError, 'Concurrent'):
                next(stream)
            with self.assertRaisesRegex(RuntimeError, 'Concurrent'):
                model.unload()
            self.assertFalse(self.native.closed)
        finally:
            release.set()
            worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(chunks), 1)
        self.native.during_generate = None
        self.assertEqual(len(list(stream)), 1)
        model.unload()

    def test_native_invalid_audio_and_timing_rejected(self):
        model = self.model()
        self.native.buffer = np.array([float('nan')], dtype=np.float32)
        with self.assertRaisesRegex(RuntimeError, 'invalid or empty audio'):
            model.generate('A')
        native = WholeNative()
        original = native.synthesize_result
        def invalid(**kwargs):
            result = original(**kwargs)
            result.timeline.chunks[0].end_sec = float('nan')
            return result
        native.synthesize_result = invalid
        model = self.model(native)
        with self.assertRaisesRegex(RuntimeError, 'invalid timing'):
            model.generate('A')

    def test_loader_uses_legacy_cache_and_model_context(self):
        native = UnitNative()
        legacy = Model('fake', native)
        lease = Mock()
        progress = Mock()
        cancel = threading.Event()
        def initialize(model_id, factory, **kwargs):
            self.assertEqual(model_id, 'fake')
            self.assertIs(kwargs['on_progress'], progress)
            self.assertIs(kwargs['cancel_event'], cancel)
            return factory(lease)
        with patch('wfloat._speech.load_with_lifecycle', side_effect=initialize), patch('wfloat._speech._legacy_load', return_value=legacy) as load:
            with load_text_to_speech('fake', cache_dir='/tmp/speech-test', on_progress=progress, cancel_event=cancel) as model:
                self.assertEqual(model.generate(text='A').audio.sample_rate, 10)
            load.assert_called_once_with('fake', cache_dir='/tmp/speech-test', force_download=False)
        lease.release.assert_called_once_with()
        self.assertTrue(native.closed)


class CtypesTtsBridgeTests(unittest.TestCase):
    def setUp(self):
        self.raw = (ctypes.c_char_p * 2)('é|'.encode(), '🙂'.encode())
        self.clean = (ctypes.c_char_p * 2)(b'normalized-one', b'normalized-two')
        self.prepared = _tts_bridge._PreparedText(self.raw, self.clean, 2)
        self.samples = (ctypes.c_float * 2)(0.25, 0.5)
        self.audio = _tts_bridge._UnitAudio(self.samples, 2, 10, 0.2)
        def prepare(model, text, emotion, intensity, out):
            ctypes.cast(out, ctypes.POINTER(ctypes.POINTER(_tts_bridge._PreparedText)))[0] = ctypes.pointer(self.prepared)
            return 0
        def generate(model, text, sid, speed, out):
            self.samples[:] = [0.25, 0.5]
            ctypes.cast(out, ctypes.POINTER(ctypes.POINTER(_tts_bridge._UnitAudio)))[0] = ctypes.pointer(self.audio)
            return 0
        def free_audio(result):
            self.samples[:] = [-1, -1]
        self.lib = SimpleNamespace(
            wfloat_tts_model_prepare_text=Mock(side_effect=prepare),
            wfloat_tts_prepared_text_destroy=Mock(),
            wfloat_tts_model_generate_unit=Mock(side_effect=generate),
            wfloat_tts_unit_audio_destroy=Mock(side_effect=free_audio),
            wfloat_tts_model_destroy=Mock())
        self.core = CoreTts.__new__(CoreTts)
        self.core._lib = self.lib
        self.core._model = ctypes.c_void_p(1)
        self.core.sample_rate = 10
        self.core.num_speakers = 20

    def tearDown(self):
        self.core.close()

    def test_real_core_class_stream_uses_native_units_and_copies_audio(self):
        model = TextToSpeechModel(Model('fake', self.core))
        with model.generate_stream('é|🙂', emotion='joy', intensity=0.7) as stream:
            self.lib.wfloat_tts_model_prepare_text.assert_not_called()
            first = next(stream)
            self.lib.wfloat_tts_model_generate_unit.assert_called_once()
            self.assertEqual(self.lib.wfloat_tts_model_generate_unit.call_args.args[1], b'normalized-one')
            second = next(stream)
            self.assertEqual(self.lib.wfloat_tts_model_generate_unit.call_args.args[1], b'normalized-two')
            self.assertEqual(list(stream), [])
        model.unload()
        np.testing.assert_array_equal(first.audio.samples, [0.25, 0.5])
        np.testing.assert_array_equal(second.audio.samples, [0.25, 0.5])
        self.assertEqual(second.timeline[0].text_start, 2)
        self.assertEqual(second.timeline[0].text_end, 3)
        self.lib.wfloat_tts_prepared_text_destroy.assert_called_once()
        self.assertEqual(self.lib.wfloat_tts_unit_audio_destroy.call_count, 2)

    def test_native_status_and_conversion_failures_free_results(self):
        self.lib.wfloat_tts_model_prepare_text.return_value = 4
        original = self.lib.wfloat_tts_model_prepare_text.side_effect
        def fail(*args):
            original(*args)
            return 4
        self.lib.wfloat_tts_model_prepare_text.side_effect = fail
        with self.assertRaisesRegex(RuntimeError, 'status 4'):
            self.core.prepare_wfloat_text('é|🙂', 'neutral', 0.5)
        self.lib.wfloat_tts_prepared_text_destroy.assert_called_once()
        self.lib.wfloat_tts_model_prepare_text.side_effect = original
        self.raw[0] = b'\xff'
        with self.assertRaises(UnicodeDecodeError):
            self.core.prepare_wfloat_text('é|🙂', 'neutral', 0.5)
        self.assertEqual(self.lib.wfloat_tts_prepared_text_destroy.call_count, 2)
        self.audio.sample_rate = 0
        with self.assertRaisesRegex(RuntimeError, 'invalid unit audio'):
            self.core.generate('normalized', 0, 1)
        self.lib.wfloat_tts_unit_audio_destroy.assert_called_once()

    def test_native_bridge_rejects_unloaded_nul_and_invalid_numeric_inputs(self):
        for speed in (0, float('nan'), float('inf'), 1e100, 1e-100):
            with self.subTest(speed=speed), self.assertRaises(ValueError):
                self.core.generate('normalized', 0, speed)
        with self.assertRaises(ValueError):
            self.core.prepare_wfloat_text('A\0B', 'neutral', 0.5)
        self.lib.wfloat_tts_model_generate_unit.assert_not_called()
        self.lib.wfloat_tts_model_prepare_text.assert_not_called()
        self.core.close()
        with self.assertRaisesRegex(RuntimeError, 'unloaded'):
            self.core.generate('normalized', 0, 1)


@unittest.skipUnless(os.environ.get('WFLOAT_TEST_TTS_CACHE'), 'set WFLOAT_TEST_TTS_CACHE and WFLOAT_CORE_LIBRARY for real synthesis')
class NativeSpeechSurfaceTests(unittest.TestCase):
    def setUp(self):
        root = Path(os.environ['WFLOAT_TEST_TTS_CACHE'])
        espeak = next((root / 'espeak').glob('*/espeak-ng-data'))
        self.native = CoreTts('wfloat/wfloat-tts',
            root / 'models/wfloat--wfloat-tts/model.onnx',
            root / 'models/wfloat--wfloat-tts/tokens.txt', espeak)
        self.model = TextToSpeechModel(Model('wfloat/wfloat-tts', self.native))

    def tearDown(self):
        self.model.unload()

    def test_lazy_unicode_units_and_deliberate_exit(self):
        text = 'Hello. Café is open!'
        prepared = self.native.prepare_wfloat_text(text, 'neutral', 0.5)
        self.assertEqual(''.join(prepared.text), text)
        self.assertGreater(len(prepared.text), 1)
        with patch.object(self.native, 'generate', wraps=self.native.generate) as generate:
            with self.model.generate_stream(text) as stream:
                generate.assert_not_called()
                first = next(stream)
                self.assertEqual(generate.call_count, 1)
                self.assertEqual(first.timeline[0].text, prepared.text[0])
                self.assertEqual(first.start_ms, 0)
            self.assertEqual(generate.call_count, 1)
            self.assertEqual(list(stream), [])
        # A fresh complete stream yields precisely the native prepared units.
        with self.model.generate_stream(text) as stream:
            chunks = list(stream)
        self.assertEqual(len(chunks), len(prepared.text))
        cursor = 0
        sample_count = 0
        for chunk, raw in zip(chunks, prepared.text):
            self.assertEqual(chunk.start_ms, sample_count / self.model.sample_rate * 1000)
            self.assertEqual(chunk.timeline[0].text_start, cursor)
            cursor += len(raw)
            sample_count += chunk.audio.samples.size
            self.assertEqual(chunk.timeline[0].text_end, cursor)
            self.assertTrue(np.isfinite(chunk.audio.samples).all())
        self.assertEqual(cursor, len(text))

    def test_external_cancel_before_and_between_units(self):
        cancel = threading.Event()
        cancel.set()
        with patch.object(self.native, 'generate', wraps=self.native.generate) as generate:
            with self.assertRaises(OperationCancelledError):
                self.model.generate('Hello.', cancel_event=cancel)
            generate.assert_not_called()
        cancel.clear()  # Caller-owned event; only this test clears it.
        with patch.object(self.native, 'generate', wraps=self.native.generate) as generate:
            with self.model.generate_stream('Hello. Goodbye.', cancel_event=cancel) as stream:
                first = next(stream)
                saved = first.audio.samples.copy()
                cancel.set()
                with self.assertRaises(OperationCancelledError):
                    next(stream)
            self.assertEqual(generate.call_count, 1)
            self.assertTrue(cancel.is_set())
            np.testing.assert_array_equal(first.audio.samples, saved)

    def test_external_cancel_while_native_call_is_active(self):
        for blocking in (False, True):
            with self.subTest(blocking=blocking):
                cancel = threading.Event()
                entered, completed = threading.Event(), threading.Event()
                observed_active = []
                generate = self.native.generate
                def synthesis(*args):
                    entered.set()
                    try:
                        return generate(*args)
                    finally:
                        completed.set()
                def stop():
                    if entered.wait(10):
                        completed.wait(0.01)
                        observed_active.append(not completed.is_set())
                        cancel.set()
                worker = threading.Thread(target=stop)
                worker.start()
                try:
                    with patch.object(self.native, 'generate', side_effect=synthesis) as call:
                        text = 'This sentence takes enough time to synthesize for cancellation to arrive during native inference.'
                        with self.assertRaises(OperationCancelledError):
                            if blocking:
                                self.model.generate(text, cancel_event=cancel)
                            else:
                                with self.model.generate_stream(text, cancel_event=cancel) as stream:
                                    next(stream)
                        self.assertEqual(call.call_count, 1)
                finally:
                    worker.join(15)
                self.assertFalse(worker.is_alive())
                self.assertEqual(observed_active, [True])
                self.assertTrue(cancel.is_set())
        # Cancellation must release the operation guard without unloading it.
        self.assertGreater(self.model.generate('Ready.').audio.samples.size, 0)

    def test_dialogue_pauses_and_retained_audio_after_unload(self):
        with self.model.generate_dialogue_stream([
            SpeechSegment('Hello.', voice_id=0, emotion='joy', pause_after_ms=1250),
            SpeechSegment('Goodbye.', voice_id=1, emotion='sadness', pause_after_ms=100),
        ]) as stream:
            chunks = list(stream)
        speech = [chunk for chunk in chunks if chunk.timeline]
        silence = [chunk for chunk in chunks if not chunk.timeline]
        self.assertEqual([chunk.timeline[0].segment_index for chunk in speech], [0, 1])
        expected_pause = int(1250 * self.model.sample_rate / 1000 + 0.5)
        self.assertEqual(speech[1].start_ms,
            (speech[0].audio.samples.size + expected_pause) / self.model.sample_rate * 1000)
        self.assertTrue(all(chunk.audio.samples.size <= self.model.sample_rate for chunk in silence))
        self.assertTrue(all(np.all(chunk.audio.samples == 0) for chunk in silence))
        snapshots = [chunk.audio.samples.copy() for chunk in chunks]
        result = self.model.generate('Still here.')
        saved_result = result.audio.samples.copy()
        self.model.unload()
        for chunk, expected in zip(chunks, snapshots):
            np.testing.assert_array_equal(chunk.audio.samples, expected)
        np.testing.assert_array_equal(result.audio.samples, saved_result)


if __name__ == '__main__':
    unittest.main()
