import { SafeAreaView, StyleSheet, Text, View } from 'react-native';
import {
  SPEAKER_IDS,
  VALID_EMOTIONS,
  VALID_SIDS,
  loadLlmModel,
  loadSttModel,
  loadTtsModel,
  loadVadModel,
} from '@wfloat/react-native-wfloat';

const publicApi = {
  loadLlmModel,
  loadSttModel,
  loadTtsModel,
  loadVadModel,
};

export default function App() {
  const summary = [
    `models: ${Object.keys(publicApi).length}`,
    `speakers: ${Object.keys(SPEAKER_IDS).length}`,
    `emotions: ${VALID_EMOTIONS.length}`,
    `voices: ${VALID_SIDS.length}`,
  ].join(' | ');

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.content}>
        <Text style={styles.title}>Wfloat consumer fixture</Text>
        <Text style={styles.summary}>{summary}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
  },
  summary: {
    marginTop: 12,
    fontSize: 14,
  },
});
