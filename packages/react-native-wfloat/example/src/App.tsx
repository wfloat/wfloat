import { useMemo, useState } from 'react';
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
  TtsModel,
  loadTtsModel,
  type LoadModelProgressEvent,
  type TtsEmotion,
  type TtsProgressEvent,
  VALID_EMOTIONS,
} from '@wfloat/react-native-wfloat';
import { LOCAL_CONFIG } from './localConfig';

type ExampleLocalConfig = {
  modelId: string;
  sampleText?: string;
  voiceId?: string | number;
  emotion?: TtsEmotion;
  intensity?: number;
  speed?: number;
  silencePaddingSec?: number;
};

type ExampleStatus = 'off' | 'loading-model' | 'generating' | 'ready';

type LogLevel = 'info' | 'success' | 'error';

type LogEntry = {
  id: number;
  level: LogLevel;
  message: string;
};

const EXAMPLE_CONFIG = LOCAL_CONFIG as ExampleLocalConfig;
const DEFAULT_TEXT =
  EXAMPLE_CONFIG.sampleText ??
  'Wfloat on React Native is now generating speech directly on iOS.';
const DEFAULT_VOICE_ID = String(EXAMPLE_CONFIG.voiceId ?? 'narrator_woman');
const DEFAULT_EMOTION = EXAMPLE_CONFIG.emotion ?? 'neutral';
const DEFAULT_INTENSITY = String(EXAMPLE_CONFIG.intensity ?? 0.5);
const DEFAULT_SPEED = String(EXAMPLE_CONFIG.speed ?? 1);
const DEFAULT_SILENCE_PADDING = String(EXAMPLE_CONFIG.silencePaddingSec ?? 0.1);
const MAX_LOGS = 18;

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

function renderHighlightedText(
  progressEvent: TtsProgressEvent | null
): string {
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

export default function App() {
  const [ttsModel, setTtsModel] = useState<TtsModel | null>(null);
  const [status, setStatus] = useState<ExampleStatus>('off');
  const [text, setText] = useState(DEFAULT_TEXT);
  const [voiceId, setVoiceId] = useState(DEFAULT_VOICE_ID);
  const [emotion, setEmotion] = useState<TtsEmotion>(DEFAULT_EMOTION);
  const [intensity, setIntensity] = useState(DEFAULT_INTENSITY);
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const [silencePaddingSec, setSilencePaddingSec] = useState(
    DEFAULT_SILENCE_PADDING
  );
  const [loadProgress, setLoadProgress] =
    useState<LoadModelProgressEvent | null>(null);
  const [progressEvent, setProgressEvent] =
    useState<TtsProgressEvent | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const addLog = (message: string, level: LogLevel = 'info') => {
    setLogs((currentLogs) => {
      const nextLogs = [
        {
          id: Date.now() + currentLogs.length,
          level,
          message,
        },
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
    () => renderHighlightedText(progressEvent),
    [progressEvent]
  );

  const handleLoadModel = async () => {
    setStatus('loading-model');
    setLoadProgress(null);
    addLog(`Loading model ${EXAMPLE_CONFIG.modelId}`);

    try {
      const model = await loadTtsModel(EXAMPLE_CONFIG.modelId, {
        onProgress: (event) => {
          setLoadProgress(event);
        },
      });
      setTtsModel(model);
      setStatus('ready');
      addLog('Model loaded successfully.', 'success');
    } catch (error) {
      setStatus('off');
      addLog(
        error instanceof Error ? error.message : 'Failed to load model.',
        'error'
      );
    }
  };

  const handleGenerate = async () => {
    if (!ttsModel) {
      addLog('Load a model first.', 'error');
      return;
    }

    const normalizedIntensity = clampUnit(Number(intensity), 0.5);
    const normalizedSpeed = parsePositiveNumber(speed, 1);
    const normalizedSilencePadding = parseNonNegativeNumber(
      silencePaddingSec,
      0.1
    );
    const normalizedVoiceId = normalizeVoiceIdInput(voiceId);

    setStatus('generating');
    setProgressEvent(null);
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
          setProgressEvent(event);
        },
        onFinishedPlaying: () => {
          setStatus('ready');
          addLog('Playback finished.', 'success');
        },
      });

      setStatus('ready');
      addLog('Generation promise resolved.', 'success');
    } catch (error) {
      setStatus(ttsModel ? 'ready' : 'off');
      addLog(
        error instanceof Error ? error.message : 'Failed to generate speech.',
        'error'
      );
    }
  };

  const handleGenerateDialogue = async () => {
    if (!ttsModel) {
      addLog('Load a model first.', 'error');
      return;
    }

    const normalizedIntensity = clampUnit(Number(intensity), 0.5);
    const normalizedSpeed = parsePositiveNumber(speed, 1);
    const normalizedSilencePadding = parseNonNegativeNumber(
      silencePaddingSec,
      0.1
    );
    const normalizedVoiceId = normalizeVoiceIdInput(voiceId);

    setStatus('generating');
    setProgressEvent(null);
    addLog('Generating two-segment dialogue.');

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
          setProgressEvent(event);
        },
        onFinishedPlaying: () => {
          setStatus('ready');
          addLog('Dialogue playback finished.', 'success');
        },
      });

      setStatus('ready');
      addLog('Dialogue generation promise resolved.', 'success');
    } catch (error) {
      setStatus(ttsModel ? 'ready' : 'off');
      addLog(
        error instanceof Error ? error.message : 'Failed to generate dialogue.',
        'error'
      );
    }
  };

  const handlePlay = async () => {
    if (!ttsModel) {
      addLog('Load a model first.', 'error');
      return;
    }

    try {
      await ttsModel.play();
      addLog('Play requested.');
    } catch (error) {
      addLog(error instanceof Error ? error.message : 'Play failed.', 'error');
    } finally {
      setStatus(ttsModel ? 'ready' : 'off');
    }
  };

  const handlePause = async () => {
    if (!ttsModel) {
      addLog('Load a model first.', 'error');
      return;
    }

    try {
      await ttsModel.pause();
      addLog('Pause requested.');
    } catch (error) {
      addLog(error instanceof Error ? error.message : 'Pause failed.', 'error');
    } finally {
      setStatus(ttsModel ? 'ready' : 'off');
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
              Manual test bed for model load, speech generate, progress, and
              playback controls.
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Session</Text>
            <Text style={styles.label}>Model ID</Text>
            <Text style={styles.value}>{EXAMPLE_CONFIG.modelId}</Text>
            <View style={styles.metricsRow}>
              <Metric label="Status" value={status} />
              <Metric
                label="Load"
                value={
                  loadProgress?.status === 'downloading'
                    ? `${Math.round(loadProgress.progress * 100)}%`
                    : (loadProgress?.status ?? 'idle')
                }
              />
              <Metric
                label="Speech"
                value={
                  progressEvent
                    ? `${Math.round(progressEvent.progress * 100)}%`
                    : 'idle'
                }
              />
            </View>
            <View style={styles.metricsRow}>
              <Metric
                label="Playing"
                value={progressEvent?.isPlaying ? 'yes' : 'no'}
              />
              <Metric label="Voice" value={selectedVoiceName} />
              <Metric label="Emotion" value={emotion} />
            </View>
            <View style={styles.buttonRow}>
              <ActionButton title="Load Model" onPress={handleLoadModel} />
              <ActionButton title="Generate" onPress={handleGenerate} />
              <ActionButton title="Dialogue" onPress={handleGenerateDialogue} />
            </View>
            <View style={styles.buttonRow}>
              <ActionButton title="Play" onPress={handlePlay} secondary />
              <ActionButton title="Pause" onPress={handlePause} secondary />
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Speech Options</Text>
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
            <Text style={styles.cardTitle}>Progress Preview</Text>
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
  value: {
    color: '#243224',
    fontSize: 14,
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
