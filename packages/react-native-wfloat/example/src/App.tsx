import { useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  SPEAKER_IDS,
  VALID_EMOTIONS,
  loadSttModel,
  loadTtsModel,
  type LoadModelProgressEvent,
  type StreamingTranscriptionResult,
  type SttModel,
  type SttSession,
  type TtsEmotion,
  type TtsModel,
  type TtsProgressEvent,
} from '@wfloat/react-native-wfloat';

type ExampleStatus = 'idle' | 'loading' | 'ready' | 'running';
type LogLevel = 'info' | 'success' | 'error';

type LogEntry = {
  id: number;
  level: LogLevel;
  message: string;
};

const DEFAULT_TTS_MODEL_ID = 'wfloat/wfloat-tts';
const DEFAULT_OFFLINE_STT_MODEL_ID = 'openai/whisper-tiny-en';
const DEFAULT_STREAMING_STT_MODEL_ID = 'k2-fsa/streaming-zipformer-en';
const DEFAULT_TEXT =
  'Wfloat on React Native is now generating speech directly on device.';
const DEFAULT_VOICE_ID = 'narrator_woman';
const DEFAULT_EMOTION: TtsEmotion = 'neutral';
const DEFAULT_INTENSITY = '0.5';
const DEFAULT_SPEED = '1';
const DEFAULT_SILENCE_PADDING = '0.1';
const DEFAULT_SAMPLE_RATE = '16000';
const DEFAULT_SILENCE_MS = '1200';
const MAX_LOGS = 24;

function clampUnit(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(value, 0), 1);
}

function parsePositiveNumber(input: string, fallback: number): number {
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseNonNegativeNumber(input: string, fallback: number): number {
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function normalizeVoiceIdInput(input: string): string | number {
  const trimmed = input.trim();
  if (!trimmed) {
    return '';
  }

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  return trimmed;
}

function renderHighlightedText(progressEvent: TtsProgressEvent | null): string {
  if (!progressEvent) {
    return 'No progress event received yet.';
  }

  const { text, textHighlightStart, textHighlightEnd } = progressEvent;
  if (!text) {
    return 'Current chunk is empty.';
  }

  const start = Math.min(Math.max(textHighlightStart, 0), text.length);
  const end = Math.min(Math.max(textHighlightEnd, start), text.length);
  return `${text.slice(0, start)}[${text.slice(start, end)}]${text.slice(end)}`;
}

function buildSilenceSamples(sampleRate: number, durationMs: number): Float32Array {
  const frameCount = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  return new Float32Array(frameCount);
}

export default function App() {
  const [assetHost, setAssetHost] = useState('');

  const [ttsModelId, setTtsModelId] = useState(DEFAULT_TTS_MODEL_ID);
  const [ttsModel, setTtsModel] = useState<TtsModel | null>(null);
  const [ttsStatus, setTtsStatus] = useState<ExampleStatus>('idle');
  const [text, setText] = useState(DEFAULT_TEXT);
  const [voiceId, setVoiceId] = useState(DEFAULT_VOICE_ID);
  const [emotion, setEmotion] = useState<TtsEmotion>(DEFAULT_EMOTION);
  const [intensity, setIntensity] = useState(DEFAULT_INTENSITY);
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const [silencePaddingSec, setSilencePaddingSec] =
    useState(DEFAULT_SILENCE_PADDING);
  const [ttsLoadProgress, setTtsLoadProgress] =
    useState<LoadModelProgressEvent | null>(null);
  const [ttsProgressEvent, setTtsProgressEvent] =
    useState<TtsProgressEvent | null>(null);

  const [offlineSttModelId, setOfflineSttModelId] = useState(
    DEFAULT_OFFLINE_STT_MODEL_ID
  );
  const [offlineSttModel, setOfflineSttModel] = useState<SttModel | null>(null);
  const [offlineSttStatus, setOfflineSttStatus] = useState<ExampleStatus>('idle');
  const [offlineSttLoadProgress, setOfflineSttLoadProgress] =
    useState<LoadModelProgressEvent | null>(null);
  const [offlineTranscript, setOfflineTranscript] = useState('');

  const [streamingSttModelId, setStreamingSttModelId] = useState(
    DEFAULT_STREAMING_STT_MODEL_ID
  );
  const [streamingSttModel, setStreamingSttModel] = useState<SttModel | null>(
    null
  );
  const [streamingSttStatus, setStreamingSttStatus] =
    useState<ExampleStatus>('idle');
  const [streamingSttLoadProgress, setStreamingSttLoadProgress] =
    useState<LoadModelProgressEvent | null>(null);
  const [streamingResult, setStreamingResult] =
    useState<StreamingTranscriptionResult | null>(null);
  const [streamingSampleRate, setStreamingSampleRate] =
    useState(DEFAULT_SAMPLE_RATE);
  const [streamingChunkMs, setStreamingChunkMs] = useState(DEFAULT_SILENCE_MS);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const streamingSessionRef = useRef<SttSession | null>(null);

  const addLog = (message: string, level: LogLevel = 'info') => {
    setLogs((currentLogs) => {
      const nextLogs = [
        { id: Date.now() + currentLogs.length, level, message },
        ...currentLogs,
      ];
      return nextLogs.slice(0, MAX_LOGS);
    });
  };

  const selectedVoiceName = useMemo(() => {
    const normalizedVoiceId = normalizeVoiceIdInput(voiceId);
    if (typeof normalizedVoiceId === 'number') {
      const matchedVoice = Object.entries(SPEAKER_IDS).find(
        ([, sid]) => sid === normalizedVoiceId
      );
      return matchedVoice?.[0] ?? `sid ${normalizedVoiceId}`;
    }

    return normalizedVoiceId || 'default';
  }, [voiceId]);

  const highlightedTextPreview = useMemo(
    () => renderHighlightedText(ttsProgressEvent),
    [ttsProgressEvent]
  );

  const normalizedAssetHost = assetHost.trim() || undefined;

  const handleLoadTtsModel = async () => {
    setTtsStatus('loading');
    setTtsLoadProgress(null);
    addLog(`Loading TTS model ${ttsModelId}`);

    try {
      const model = await loadTtsModel(ttsModelId, {
        modelAssetHost: normalizedAssetHost,
        onProgress: (event) => setTtsLoadProgress(event),
      });
      setTtsModel(model);
      setTtsStatus('ready');
      addLog('TTS model loaded successfully.', 'success');
    } catch (error) {
      setTtsStatus('idle');
      addLog(
        error instanceof Error ? error.message : 'Failed to load TTS model.',
        'error'
      );
    }
  };

  const handleGenerate = async () => {
    if (!ttsModel) {
      addLog('Load a TTS model first.', 'error');
      return;
    }

    const normalizedIntensity = clampUnit(Number(intensity), 0.5);
    const normalizedSpeed = parsePositiveNumber(speed, 1);
    const normalizedSilencePadding = parseNonNegativeNumber(
      silencePaddingSec,
      0.1
    );
    const normalizedVoiceId = normalizeVoiceIdInput(voiceId);

    setTtsStatus('running');
    setTtsProgressEvent(null);
    addLog(
      `Generating with ${selectedVoiceName}, ${emotion}, speed ${normalizedSpeed.toFixed(
        2
      )}`
    );

    try {
      await ttsModel.synthesize({
        text,
        voice: normalizedVoiceId,
        emotion,
        intensity: normalizedIntensity,
        speed: normalizedSpeed,
        silencePaddingSec: normalizedSilencePadding,
        onProgress: (event) => {
          setTtsProgressEvent(event);
        },
        onFinishedPlaying: () => {
          setTtsStatus('ready');
          addLog('TTS playback finished.', 'success');
        },
      });

      setTtsStatus('ready');
      addLog('TTS generation promise resolved.', 'success');
    } catch (error) {
      setTtsStatus(ttsModel ? 'ready' : 'idle');
      addLog(
        error instanceof Error ? error.message : 'Failed to generate speech.',
        'error'
      );
    }
  };

  const handleGenerateDialogue = async () => {
    if (!ttsModel) {
      addLog('Load a TTS model first.', 'error');
      return;
    }

    const normalizedIntensity = clampUnit(Number(intensity), 0.5);
    const normalizedSpeed = parsePositiveNumber(speed, 1);
    const normalizedSilencePadding = parseNonNegativeNumber(
      silencePaddingSec,
      0.1
    );
    const normalizedVoiceId = normalizeVoiceIdInput(voiceId);

    setTtsStatus('running');
    setTtsProgressEvent(null);
    addLog('Generating dialogue test.');

    try {
      await ttsModel.synthesizeDialogue({
        segments: [
          {
            text,
            voice: normalizedVoiceId,
            emotion,
            intensity: normalizedIntensity,
            speed: normalizedSpeed,
            sentenceSilencePaddingSec: normalizedSilencePadding,
          },
          {
            text: 'This is a second dialogue segment using a different voice.',
            voice:
              selectedVoiceName === 'narrator_man'
                ? 'narrator_woman'
                : 'narrator_man',
            emotion: 'joy',
            intensity: 0.55,
            speed: normalizedSpeed,
            sentenceSilencePaddingSec: normalizedSilencePadding,
          },
        ],
        speed: normalizedSpeed,
        silenceBetweenSegmentsSec: 0.2,
        onProgress: (event) => {
          setTtsProgressEvent(event);
        },
        onFinishedPlaying: () => {
          setTtsStatus('ready');
          addLog('Dialogue playback finished.', 'success');
        },
      });

      setTtsStatus('ready');
      addLog('Dialogue generation promise resolved.', 'success');
    } catch (error) {
      setTtsStatus(ttsModel ? 'ready' : 'idle');
      addLog(
        error instanceof Error ? error.message : 'Failed to generate dialogue.',
        'error'
      );
    }
  };

  const handlePlay = async () => {
    if (!ttsModel) {
      addLog('Load a TTS model first.', 'error');
      return;
    }

    try {
      await ttsModel.play();
      addLog('Play requested.');
    } catch (error) {
      addLog(error instanceof Error ? error.message : 'Play failed.', 'error');
    }
  };

  const handlePause = async () => {
    if (!ttsModel) {
      addLog('Load a TTS model first.', 'error');
      return;
    }

    try {
      await ttsModel.pause();
      addLog('Pause requested.');
    } catch (error) {
      addLog(error instanceof Error ? error.message : 'Pause failed.', 'error');
    }
  };

  const handleLoadOfflineStt = async () => {
    setOfflineSttStatus('loading');
    setOfflineSttLoadProgress(null);
    setOfflineTranscript('');
    addLog(`Loading offline STT model ${offlineSttModelId}`);

    try {
      const model = await loadSttModel(offlineSttModelId, {
        modelAssetHost: normalizedAssetHost,
        language: 'en',
        onProgress: (event) => setOfflineSttLoadProgress(event),
      });
      setOfflineSttModel(model);
      setOfflineSttStatus('ready');
      addLog('Offline STT model loaded successfully.', 'success');
    } catch (error) {
      setOfflineSttStatus('idle');
      addLog(
        error instanceof Error ? error.message : 'Failed to load offline STT model.',
        'error'
      );
    }
  };

  const handleOfflineTranscribe = async () => {
    if (!offlineSttModel) {
      addLog('Load the offline STT model first.', 'error');
      return;
    }

    const sampleRate = parsePositiveNumber(streamingSampleRate, 16000);
    const silenceMs = parsePositiveNumber(streamingChunkMs, 1200);
    const samples = buildSilenceSamples(sampleRate, silenceMs);

    setOfflineSttStatus('running');
    addLog(
      `Running offline STT over ${samples.length} silent samples at ${sampleRate} Hz`
    );

    try {
      const result = await offlineSttModel.transcribe({
        audio: samples,
        sampleRate,
      });
      setOfflineTranscript(result.text);
      setOfflineSttStatus('ready');
      addLog(`Offline STT result: "${result.text}"`, 'success');
    } catch (error) {
      setOfflineSttStatus('ready');
      addLog(
        error instanceof Error ? error.message : 'Offline transcription failed.',
        'error'
      );
    }
  };

  const handleLoadStreamingStt = async () => {
    setStreamingSttStatus('loading');
    setStreamingSttLoadProgress(null);
    setStreamingResult(null);
    addLog(`Loading streaming STT model ${streamingSttModelId}`);

    try {
      const model = await loadSttModel(streamingSttModelId, {
        modelAssetHost: normalizedAssetHost,
        onProgress: (event) => setStreamingSttLoadProgress(event),
      });
      setStreamingSttModel(model);
      setStreamingSttStatus('ready');
      addLog('Streaming STT model loaded successfully.', 'success');
    } catch (error) {
      setStreamingSttStatus('idle');
      addLog(
        error instanceof Error ? error.message : 'Failed to load streaming STT model.',
        'error'
      );
    }
  };

  const handleStartStreaming = async () => {
    if (!streamingSttModel) {
      addLog('Load the streaming STT model first.', 'error');
      return;
    }

    try {
      if (streamingSessionRef.current) {
        await streamingSessionRef.current.close();
      }
      const session = await streamingSttModel.createSession();
      streamingSessionRef.current = session;
      setStreamingResult(null);
      setStreamingSttStatus('running');
      addLog('Streaming STT session created.', 'success');
    } catch (error) {
      addLog(
        error instanceof Error ? error.message : 'Failed to create streaming session.',
        'error'
      );
    }
  };

  const handlePushStreamingChunk = async () => {
    if (!streamingSessionRef.current) {
      addLog('Create a streaming session first.', 'error');
      return;
    }

    const sampleRate = parsePositiveNumber(streamingSampleRate, 16000);
    const silenceMs = parsePositiveNumber(streamingChunkMs, 1200);
    const samples = buildSilenceSamples(sampleRate, silenceMs);

    try {
      await streamingSessionRef.current.push({
        audio: samples,
        sampleRate,
      });
      const partial = await streamingSessionRef.current.getResult();
      setStreamingResult(partial);
      addLog(
        `Pushed streaming chunk (${samples.length} samples). Partial: "${partial.text}"`,
        'success'
      );
    } catch (error) {
      addLog(
        error instanceof Error ? error.message : 'Failed to push streaming chunk.',
        'error'
      );
    }
  };

  const handleFinishStreaming = async () => {
    if (!streamingSessionRef.current) {
      addLog('Create a streaming session first.', 'error');
      return;
    }

    try {
      const finalResult = await streamingSessionRef.current.finish();
      setStreamingResult(finalResult);
      setStreamingSttStatus('ready');
      addLog(`Streaming STT final: "${finalResult.text}"`, 'success');
    } catch (error) {
      addLog(
        error instanceof Error ? error.message : 'Failed to finish streaming session.',
        'error'
      );
    }
  };

  const handleResetStreaming = async () => {
    if (!streamingSessionRef.current) {
      addLog('Create a streaming session first.', 'error');
      return;
    }

    try {
      await streamingSessionRef.current.reset();
      setStreamingResult(null);
      addLog('Streaming STT session reset.', 'success');
    } catch (error) {
      addLog(
        error instanceof Error ? error.message : 'Failed to reset streaming session.',
        'error'
      );
    }
  };

  const handleCloseStreaming = async () => {
    if (!streamingSessionRef.current) {
      addLog('No streaming session is open.', 'error');
      return;
    }

    try {
      await streamingSessionRef.current.close();
      streamingSessionRef.current = null;
      setStreamingResult(null);
      setStreamingSttStatus(streamingSttModel ? 'ready' : 'idle');
      addLog('Streaming STT session closed.', 'success');
    } catch (error) {
      addLog(
        error instanceof Error ? error.message : 'Failed to close streaming session.',
        'error'
      );
    }
  };

  const handleClearLogs = () => {
    setLogs([]);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Text style={styles.title}>Wfloat RN Example</Text>
            <Text style={styles.subtitle}>
              Manual smoke test for TTS, offline STT, and streaming STT on
              React Native.
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Asset API</Text>
            <InputField
              label="Model Asset Host"
              value={assetHost}
              onChangeText={setAssetHost}
            />
            <Text style={styles.helpText}>
              Leave blank for production. Set this to your local asset API host
              when testing against a dev server.
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>TTS</Text>
            <InputField
              label="TTS Model ID"
              value={ttsModelId}
              onChangeText={setTtsModelId}
            />
            <View style={styles.metricsRow}>
              <Metric label="Status" value={ttsStatus} />
              <Metric
                label="Load"
                value={
                  ttsLoadProgress?.status === 'downloading'
                    ? `${Math.round(ttsLoadProgress.progress * 100)}%`
                    : (ttsLoadProgress?.status ?? 'idle')
                }
              />
              <Metric
                label="Speech"
                value={
                  ttsProgressEvent
                    ? `${Math.round(ttsProgressEvent.progress * 100)}%`
                    : 'idle'
                }
              />
            </View>
            <View style={styles.metricsRow}>
              <Metric
                label="Playing"
                value={ttsProgressEvent?.isPlaying ? 'yes' : 'no'}
              />
              <Metric label="Voice" value={selectedVoiceName} />
              <Metric label="Emotion" value={emotion} />
            </View>
            <View style={styles.buttonRow}>
              <ActionButton title="Load TTS" onPress={handleLoadTtsModel} />
              <ActionButton title="Generate" onPress={handleGenerate} />
              <ActionButton title="Dialogue" onPress={handleGenerateDialogue} />
            </View>
            <View style={styles.buttonRow}>
              <ActionButton title="Play" onPress={handlePlay} secondary />
              <ActionButton title="Pause" onPress={handlePause} secondary />
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>TTS Options</Text>
            <InputField
              label="Voice ID or SID"
              value={voiceId}
              onChangeText={setVoiceId}
            />
            <Text style={styles.helpText}>
              String voices work too, for example `narrator_woman` or
              `skilled_hero_man`.
            </Text>
            <Text style={styles.label}>Emotion</Text>
            <View style={styles.chipWrap}>
              {VALID_EMOTIONS.map((emotionOption) => (
                <Pressable
                  key={emotionOption}
                  onPress={() => setEmotion(emotionOption)}
                  style={[
                    styles.chip,
                    emotionOption === emotion && styles.chipSelected,
                  ]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      emotionOption === emotion && styles.chipTextSelected,
                    ]}
                  >
                    {emotionOption}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.inlineInputs}>
              <InputField
                label="Intensity"
                value={intensity}
                onChangeText={setIntensity}
                keyboardType="decimal-pad"
                compact
              />
              <InputField
                label="Speed"
                value={speed}
                onChangeText={setSpeed}
                keyboardType="decimal-pad"
                compact
              />
              <InputField
                label="Silence Pad"
                value={silencePaddingSec}
                onChangeText={setSilencePaddingSec}
                keyboardType="decimal-pad"
                compact
              />
            </View>
            <InputField
              label="Text"
              value={text}
              onChangeText={setText}
              multiline
              tall
            />
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Offline STT</Text>
            <InputField
              label="Offline STT Model ID"
              value={offlineSttModelId}
              onChangeText={setOfflineSttModelId}
            />
            <View style={styles.metricsRow}>
              <Metric label="Status" value={offlineSttStatus} />
              <Metric
                label="Load"
                value={
                  offlineSttLoadProgress?.status === 'downloading'
                    ? `${Math.round(offlineSttLoadProgress.progress * 100)}%`
                    : (offlineSttLoadProgress?.status ?? 'idle')
                }
              />
              <Metric label="Text" value={offlineTranscript || 'empty'} />
            </View>
            <View style={styles.inlineInputs}>
              <InputField
                label="Sample Rate"
                value={streamingSampleRate}
                onChangeText={setStreamingSampleRate}
                keyboardType="decimal-pad"
                compact
              />
              <InputField
                label="Silence ms"
                value={streamingChunkMs}
                onChangeText={setStreamingChunkMs}
                keyboardType="decimal-pad"
                compact
              />
            </View>
            <View style={styles.buttonRow}>
              <ActionButton title="Load Offline STT" onPress={handleLoadOfflineStt} />
              <ActionButton title="Transcribe Silence" onPress={handleOfflineTranscribe} />
            </View>
            <Text style={styles.helpText}>
              This uses a silent PCM clip so you can verify load and transcription
              plumbing even before adding file-picker or mic capture UI.
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Streaming STT</Text>
            <InputField
              label="Streaming STT Model ID"
              value={streamingSttModelId}
              onChangeText={setStreamingSttModelId}
            />
            <View style={styles.metricsRow}>
              <Metric label="Status" value={streamingSttStatus} />
              <Metric
                label="Load"
                value={
                  streamingSttLoadProgress?.status === 'downloading'
                    ? `${Math.round(streamingSttLoadProgress.progress * 100)}%`
                    : (streamingSttLoadProgress?.status ?? 'idle')
                }
              />
              <Metric
                label="Endpoint"
                value={streamingResult?.isEndpoint ? 'yes' : 'no'}
              />
            </View>
            <Text style={styles.label}>Latest partial/final text</Text>
            <Text style={styles.previewText}>
              {streamingResult?.text || 'No streaming result yet.'}
            </Text>
            <View style={styles.buttonRow}>
              <ActionButton title="Load Streaming STT" onPress={handleLoadStreamingStt} />
              <ActionButton title="Start Session" onPress={handleStartStreaming} />
            </View>
            <View style={styles.buttonRow}>
              <ActionButton title="Push Silence" onPress={handlePushStreamingChunk} secondary />
              <ActionButton title="Finish" onPress={handleFinishStreaming} secondary />
            </View>
            <View style={styles.buttonRow}>
              <ActionButton title="Reset" onPress={handleResetStreaming} secondary />
              <ActionButton title="Close" onPress={handleCloseStreaming} secondary />
            </View>
            <Text style={styles.helpText}>
              This also uses silent PCM chunks. It is meant to verify session
              lifecycle and partial/final result calls before wiring microphone
              capture.
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>TTS Progress Preview</Text>
            <Text style={styles.label}>Latest chunk</Text>
            <Text style={styles.previewText}>{highlightedTextPreview}</Text>
            <Text style={styles.helpText}>
              Highlight markers are shown with square brackets so you can spot
              the chunk boundaries quickly.
            </Text>
          </View>

          <View style={styles.card}>
            <View style={styles.logHeader}>
              <Text style={styles.cardTitle}>Event Log</Text>
              <Pressable onPress={handleClearLogs}>
                <Text style={styles.clearText}>Clear</Text>
              </Pressable>
            </View>
            {logs.length === 0 ? (
              <Text style={styles.emptyState}>No events yet.</Text>
            ) : (
              logs.map((entry) => (
                <Text
                  key={entry.id}
                  style={[
                    styles.logEntry,
                    entry.level === 'error' && styles.logError,
                    entry.level === 'success' && styles.logSuccess,
                  ]}
                >
                  {entry.message}
                </Text>
              ))
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function ActionButton({
  title,
  onPress,
  secondary = false,
}: {
  title: string;
  onPress: () => void;
  secondary?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.button, secondary && styles.buttonSecondary]}
    >
      <Text
        style={[styles.buttonText, secondary && styles.buttonTextSecondary]}
      >
        {title}
      </Text>
    </Pressable>
  );
}

function InputField({
  label,
  value,
  onChangeText,
  keyboardType,
  multiline = false,
  tall = false,
  compact = false,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  keyboardType?: 'default' | 'decimal-pad';
  multiline?: boolean;
  tall?: boolean;
  compact?: boolean;
}) {
  return (
    <View style={[styles.inputGroup, compact && styles.inputGroupCompact]}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        multiline={multiline}
        onChangeText={onChangeText}
        style={[
          styles.input,
          multiline && styles.inputMultiline,
          tall && styles.inputTall,
        ]}
        value={value}
        keyboardType={keyboardType}
        textAlignVertical={multiline ? 'top' : 'center'}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f4efe3',
  },
  flex: {
    flex: 1,
  },
  content: {
    padding: 16,
    gap: 16,
  },
  header: {
    gap: 6,
    paddingTop: 4,
  },
  title: {
    color: '#1f2a1f',
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: -0.8,
  },
  subtitle: {
    color: '#4c5d4c',
    fontSize: 14,
    lineHeight: 20,
  },
  card: {
    backgroundColor: '#fffaf1',
    borderColor: '#d7c9ab',
    borderRadius: 20,
    borderWidth: 1,
    gap: 12,
    padding: 16,
    shadowColor: '#8b6f3d',
    shadowOffset: {
      width: 0,
      height: 8,
    },
    shadowOpacity: 0.08,
    shadowRadius: 18,
  },
  cardTitle: {
    color: '#1f2a1f',
    fontSize: 18,
    fontWeight: '700',
  },
  label: {
    color: '#556455',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  metricsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  metric: {
    flex: 1,
    backgroundColor: '#eef2e5',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  metricLabel: {
    color: '#627062',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  metricValue: {
    color: '#182218',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 4,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  button: {
    alignItems: 'center',
    backgroundColor: '#244f3d',
    borderRadius: 14,
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  buttonSecondary: {
    backgroundColor: '#ecf0e2',
  },
  buttonText: {
    color: '#f9f5ec',
    fontSize: 15,
    fontWeight: '700',
  },
  buttonTextSecondary: {
    color: '#244f3d',
  },
  helpText: {
    color: '#6d776d',
    fontSize: 12,
    lineHeight: 18,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    backgroundColor: '#edf1ea',
    borderColor: '#cad6c4',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipSelected: {
    backgroundColor: '#244f3d',
    borderColor: '#244f3d',
  },
  chipText: {
    color: '#3f4e3f',
    fontSize: 13,
    fontWeight: '600',
  },
  chipTextSelected: {
    color: '#fffaf1',
  },
  inlineInputs: {
    flexDirection: 'row',
    gap: 10,
  },
  inputGroup: {
    gap: 6,
  },
  inputGroupCompact: {
    flex: 1,
  },
  input: {
    backgroundColor: '#f5f1e8',
    borderColor: '#d8ceb9',
    borderRadius: 12,
    borderWidth: 1,
    color: '#1f2a1f',
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  inputMultiline: {
    minHeight: 80,
  },
  inputTall: {
    minHeight: 120,
  },
  previewText: {
    color: '#203020',
    fontSize: 15,
    lineHeight: 24,
  },
  logHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  clearText: {
    color: '#244f3d',
    fontSize: 14,
    fontWeight: '700',
  },
  emptyState: {
    color: '#708070',
    fontSize: 14,
  },
  logEntry: {
    color: '#344434',
    fontSize: 13,
    lineHeight: 18,
  },
  logError: {
    color: '#9a3622',
  },
  logSuccess: {
    color: '#22654b',
  },
});
