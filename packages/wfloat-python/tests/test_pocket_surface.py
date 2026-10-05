import ctypes as c
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
import tempfile
from threading import Event
from unittest.mock import patch
import warnings

import numpy as np

from wfloat import Audio, SpeechSegment, TextToSpeechModel, OperationCancelledError
from wfloat import _core, _pocket
from wfloat._model import Model
from wfloat._speech import load_text_to_speech


class FakePocket:
    family = 'pocket'
    sample_rate = 24000
    num_speakers = 1

    def __init__(self):
        self.calls = []
        self.closed = False

    def generate_pocket(self, text, segment):
        self.calls.append((text, segment))
        return SimpleNamespace(samples=np.ones(240, np.float32), sample_rate=24000)

    def close(self):
        self.closed = True


class PocketTests(unittest.TestCase):
    def setUp(self):
        self.native = FakePocket()
        self.model = TextToSpeechModel(Model(_pocket.MODEL_ID, self.native))
        self.ref = Audio(np.ones(1600, np.float32), 16000)

    def tearDown(self):
        self.model.unload()

    def test_defaults_and_no_warning(self):
        with warnings.catch_warnings(record=True) as caught:
            self.model.generate('Hello.')
        self.assertEqual(caught, [])
        segment = self.native.calls[0][1]
        self.assertEqual(segment.voice_id, 'alba')
        self.assertIsNone(segment.reference_audio)
        self.assertIsNone(segment.seed)
        self.assertAlmostEqual(segment.temperature, .7)
        self.assertEqual(segment.inference_steps, 5)

    def test_controls_and_voice_inheritance(self):
        self.model.generate_dialogue([
            {'text': 'a'}, {'text': 'b', 'voice_id': 'alba', 'seed': 0},
            SpeechSegment('c', temperature=0, inference_steps=1),
        ], reference_audio=self.ref, temperature=.3, seed=42, inference_steps=8)
        a, b, d = [call[1] for call in self.native.calls]
        self.assertEqual(a.reference_audio.sample_rate, 24000)
        self.assertEqual(len(a.reference_audio.samples), 2400)
        self.assertIsNone(b.reference_audio)
        self.assertEqual(b.voice_id, 'alba')
        self.assertEqual((b.seed, d.seed, d.inference_steps, d.temperature), (0, 42, 1, 0))
        self.native.calls.clear()
        self.model.generate_dialogue([SpeechSegment('x', reference_audio=self.ref)], voice_id='alba')
        self.assertIsNone(self.native.calls[0][1].voice_id)

    def test_same_segment_voice_conflict(self):
        for segments, options in [([{'text': 'x'}], dict(voice_id='alba', reference_audio=self.ref)),
                                  ([SpeechSegment('x', voice_id='alba', reference_audio=self.ref)], {})]:
            with self.assertRaisesRegex(ValueError, 'cannot both'):
                self.model.generate_dialogue_stream(segments, **options)
        self.assertEqual(self.native.calls, [])

    def test_validation_before_synthesis(self):
        for name, values in {
            'temperature': [True, '1', -1, float('nan'), float('inf'), 1e39, 1e-100, 1e-40, np.nextafter(2**-126, 0)],
            'seed': [True, 1.5, -1, 2**31],
            'inference_steps': [True, 1.5, 0, -1, 2**31],
            'voice_id': [0, 'other'],
        }.items():
            for value in values:
                with self.subTest(name=name, value=value):
                    with self.assertRaises((ValueError, TypeError)):
                        self.model.generate_stream('x', **{name: value})
                    with self.assertRaises((ValueError, TypeError)):
                        self.model.generate_dialogue_stream([{'text': 'x', name: value}])
        self.assertEqual(self.native.calls, [])

    def test_temperature_normal_boundary(self):
        for value in (0, 2**-126):
            self.model.generate('x', temperature=value)
            self.assertEqual(self.native.calls[-1][1].temperature, value)
            self.model.generate_dialogue([SpeechSegment('x', temperature=value)])
            self.assertEqual(self.native.calls[-1][1].temperature, value)

    def test_reference_normalization_limits_and_snapshot(self):
        pcm = np.ones((800, 2), np.float32)
        stream = self.model.generate_stream('x', reference_audio=pcm, sample_rate=8000)
        pcm[:] = 0
        next(stream)
        self.assertTrue(np.all(self.native.calls[-1][1].reference_audio.samples > .9))
        stream.close()
        for ref in [Audio(np.ones(240001, np.float32), 24000), Audio(np.empty(0, np.float32), 24000)]:
            with self.assertRaises(ValueError):
                self.model.generate_stream('x', reference_audio=ref)
        self.model.generate('x', reference_audio=Audio(np.ones(240000, np.float32), 24000))
        with self.assertRaisesRegex(ValueError, 'sample_rate'):
            self.model.generate_stream('x', reference_audio=np.ones(100, np.float32))

    def test_explicit_unsupported_options_warn(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter('always')
            self.model.generate('x', emotion='happy', intensity=.8, speed=2)
        self.assertEqual(len(caught), 3)
        with self.assertWarnsRegex(UserWarning, 'speed'):
            self.model.generate_dialogue([SpeechSegment('x', speed=1)])

    def test_offsets_bounded_units_and_demand(self):
        text = '  Hello café 👩\u200d💻! ' * 35 + '尾' * 230 + 'e\u0301' * 150
        stream = self.model.generate_stream(text)
        self.assertEqual(self.native.calls, [])
        chunks = list(stream)
        self.assertGreater(len(chunks), 1)
        self.assertEqual(''.join(c.timeline[0].text for c in chunks), text)
        cursor = 0
        for chunk in chunks:
            timing = chunk.timeline[0]
            self.assertEqual(timing.text_start, cursor)
            self.assertEqual(text[timing.text_start:timing.text_end], timing.text)
            cursor = timing.text_end
        self.assertTrue(all(len(text) <= 200 for text, _ in self.native.calls))
        for text in [' ' * 1000 + 'Hi', 'Hi' + ' ' * 1000, 'x' * 199 + 'e\u0301hello', 'e' + '\u0301' * 1000]:
            prepared = _pocket.prepare_text(text)
            self.assertEqual(''.join(prepared.text), text)
            self.assertTrue(all(prepared.text_clean))
            self.assertTrue(all(len(unit) <= 200 for unit in prepared.text_clean))

    def test_pause_and_unload(self):
        result = self.model.generate_dialogue(
            [{'text': 'a'}, {'text': 'b'}], pause_between_segments_ms=100)
        self.assertEqual(len(result.timeline), 2)
        self.assertEqual(result.timeline[1].start_ms, 110)
        stream = self.model.generate_stream('x')
        self.model.unload()
        self.assertTrue(self.native.closed)
        self.assertEqual(list(stream), [])

    def test_wfloat_sampling_validates_then_warns_and_reference_rejects(self):
        native = SimpleNamespace(sample_rate=24000, num_speakers=20,
            prepare_wfloat_text=lambda text, *args: SimpleNamespace(text=[text], text_clean=[text]),
            generate=lambda *args: SimpleNamespace(samples=np.ones(240, np.float32), sample_rate=24000),
            close=lambda: None)
        with TextToSpeechModel(Model('wfloat/wfloat-tts', native)) as model:
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter('always')
                result = model.generate_dialogue([SpeechSegment('a', seed=0), {'text': 'b', 'temperature': 0}],
                    temperature=.7, seed=42, inference_steps=5)
            self.assertEqual(len(caught), 3)
            self.assertTrue(all('ignored' in str(item.message) for item in caught))
            self.assertEqual(len(result.timeline), 2)
            for name, value in [('temperature', float('nan')), ('temperature', 1e39), ('temperature', 1e-40),
                                ('seed', -1), ('seed', True), ('inference_steps', 0),
                                ('inference_steps', 2**31)]:
                with self.subTest(name=name, value=value):
                    with self.assertRaises((TypeError, ValueError)):
                        model.generate_stream('a', **{name: value})
                    with self.assertRaises((TypeError, ValueError)):
                        model.generate_dialogue_stream([{'text': 'a', name: value}])
            for options in [dict(reference_audio=self.ref), dict(sample_rate=24000)]:
                with self.assertRaisesRegex(ValueError, 'require a Pocket'):
                    model.generate_stream('a', **options)
                with self.assertRaisesRegex(ValueError, 'require a Pocket'):
                    model.generate_dialogue_stream([{'text': 'a', **options}])

    def test_cancellation_between_units(self):
        cancel = Event()
        stream = self.model.generate_stream('Hello world. ' * 100, cancel_event=cancel)
        next(stream)
        cancel.set()
        with self.assertRaises(OperationCancelledError):
            next(stream)
        self.assertEqual(len(self.native.calls), 1)
        self.assertEqual(list(stream), [])

    def test_loader_uses_existing_lifecycle(self):
        lease = SimpleNamespace(release=lambda: None)
        legacy = Model(_pocket.MODEL_ID, self.native)
        with patch('wfloat._speech.load_with_lifecycle', side_effect=lambda name, initialize, **kwargs: initialize(lease)) as lifecycle, \
             patch('wfloat._pocket.load_cached', return_value=legacy) as cached:
            model = load_text_to_speech(_pocket.MODEL_ID, cache_dir='/tmp/pocket-test')
            cached.assert_called_once_with('/tmp/pocket-test')
            self.assertEqual(lifecycle.call_args.args[0], _pocket.MODEL_ID)
            model.unload()

    def test_ctypes_options_and_owned_output(self):
        native = object.__new__(_pocket.PocketTts)
        native._model = c.c_void_p(1)
        native.sample_rate = 24000
        native.default_reference = _pocket.reference(self.ref)
        pcm = (c.c_float * 2)(.2, .4)
        output = _core._WfloatTtsSynthesisResult(audio=_core._WfloatAudioResult(pcm, 2, 24000, 0))
        seen = []
        def synth(model, options, callback, context, result):
            opts = c.cast(options, c.POINTER(_core._WfloatTtsSynthesizeOptions)).contents
            extra = {opts.extra_entries[i].key: opts.extra_entries[i].value for i in range(opts.extra_entry_count)}
            seen.append((opts.num_steps, extra, opts.reference_audio_sample_rate, opts.reference_audio_sample_count))
            c.cast(result, c.POINTER(c.POINTER(_core._WfloatTtsSynthesisResult)))[0] = c.pointer(output)
            return 0
        def destroy(result):
            pcm[0] = -1
        native._lib = SimpleNamespace(wfloat_tts_model_synthesize=synth,
            wfloat_tts_synthesis_result_destroy=destroy, wfloat_tts_model_destroy=lambda model: None)
        segment = SpeechSegment('x', temperature=.7, inference_steps=5)
        audio = native.generate_pocket('x', segment)
        self.assertAlmostEqual(audio.samples[0], .2)
        self.assertNotIn(b'seed', seen[0][1])
        segment.seed = 2147483647
        native.generate_pocket('x', segment)
        self.assertEqual(seen[1], (5, {b'temperature': b'0.7', b'seed': b'2147483647'}, 24000, 2400))
        # Native errors must still destroy any result allocated before failure.
        with patch.object(native._lib, 'wfloat_tts_model_synthesize', side_effect=lambda *args: (synth(*args), 3)[1]), \
             patch.object(native._lib, 'wfloat_tts_synthesis_result_destroy', wraps=destroy) as freed:
            with self.assertRaisesRegex(RuntimeError, 'status 3'):
                native.generate_pocket('x', segment)
            freed.assert_called_once()
        native.close()


@unittest.skipUnless(os.environ.get('WFLOAT_POCKET_ASSET_DIR'), 'requires staged Pocket assets and native library')
class PocketNativeTests(unittest.TestCase):
    def test_real_synthesis(self):
        root = Path(os.environ['WFLOAT_POCKET_ASSET_DIR'])
        with tempfile.TemporaryDirectory(prefix='wfloat-pocket-test-') as cache:
            directory = Path(cache) / 'models' / 'kyutai--pocket-tts'
            directory.mkdir(parents=True)
            for key in _pocket.ASSET_FIELDS:
                name = Path(_pocket.MODEL_ASSETS[_pocket.MODEL_ID][key]['path']).name
                (directory / name).symlink_to(root / name)
            with load_text_to_speech(_pocket.MODEL_ID, cache_dir=cache) as model:
                result = model.generate('Hello from Pocket.', seed=42, inference_steps=1)
                self.assertEqual(result.audio.sample_rate, 24000)
                self.assertTrue(result.audio.samples.size)
                self.assertTrue(np.isfinite(result.audio.samples).all())
                self.assertEqual(result.timeline[0].text, 'Hello from Pocket.')
                repeated = model.generate('Hello from Pocket.', seed=42, inference_steps=1)
                np.testing.assert_array_equal(result.audio.samples, repeated.audio.samples)
                custom = model.generate('Hello from Pocket.', seed=42, inference_steps=1,
                    reference_audio=root / 'alba-reference-24khz.wav')
                np.testing.assert_array_equal(result.audio.samples, custom.audio.samples)
                with self.assertRaisesRegex(ValueError, r'2\*\*-126'):
                    model.generate('Hello from Pocket.', temperature=1e-40)
                for temperature in (0, 2**-126):
                    boundary = model.generate('Hello from Pocket.', seed=42,
                        inference_steps=1, temperature=temperature)
                    self.assertTrue(boundary.audio.samples.size)
                    self.assertTrue(np.isfinite(boundary.audio.samples).all())
                    self.assertFalse(np.array_equal(result.audio.samples, boundary.audio.samples))


if __name__ == '__main__':
    unittest.main()
