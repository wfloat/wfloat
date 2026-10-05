import { OfflineRecognizer, createOnlineRecognizer } from '../wasm/sherpa-onnx-asr.js';
import { ensureHeapViews } from '../tts-next/sherpa.js';
import type { SherpaModule } from '../wasm/sherpa-onnx-tts.js';
import type { RecognitionOptions, TranscriptData, TranscriptSegment } from './types.js';
import type { WorkerAssets } from './backend-types.js';
import { sttCapabilities, validateRecognitionOptions, normalizeZipformerHotwords, recognitionLanguage } from './capabilities.js';

/** Caught Ort exceptions are logged and swallowed by vendored offline decoders. */
export class NativeDiagnostics {
  private messages: string[] = [];
  print = (message: unknown) => { this.messages.push(String(message)); if (this.messages.length > 32) this.messages.shift(); };
  run<T>(action: () => T): T {
    this.messages = [];
    const value = action();
    const diagnostics = this.messages.join('\n');
    if (/caught exception|return an empty result|\berror\b|\bfailed\b|discard the remaining|timestamps will not be available/i.test(diagnostics)) throw new Error(`Sherpa STT failed: ${diagnostics}`);
    return value;
  }
}
export function recognizerConfig(modelId: string, options: RecognitionOptions = {}) {
  validateRecognitionOptions(modelId, options);
  const capabilities = sttCapabilities(modelId);
  const { family } = capabilities;
  const base = { tokens: '/tokens.txt', numThreads: 1, provider: 'cpu', debug: 0 };
  if (family === 'whisper') return {
    modelConfig: { ...base, modelType: 'whisper', whisper: { encoder: '/encoder.onnx', decoder: '/decoder.onnx', language: options.language === undefined ? (capabilities.translation ? '' : 'en') : recognitionLanguage(options.language), task: options.task ?? 'transcribe', tailPaddings: -1, enableTokenTimestamps: 0, enableSegmentTimestamps: options.timestamps === 'segment' ? 1 : 0 } },
    decodingMethod: 'greedy_search', maxActivePaths: 4,
  };
  if (family === 'moonshine') return {
    modelConfig: { ...base, moonshine: capabilities.moonshineVersion === 2 ? { encoder: '/encoder.ort', mergedDecoder: '/merged_decoder.ort', preprocessor: '', uncachedDecoder: '', cachedDecoder: '' } : { preprocessor: '/preprocessor.onnx', encoder: '/encoder.onnx', uncachedDecoder: '/uncached_decoder.onnx', cachedDecoder: '/cached_decoder.onnx', mergedDecoder: '' } },
    decodingMethod: 'greedy_search', maxActivePaths: 4,
  };
  if (family === 'parakeet-tdt') return {
    featConfig: { sampleRate: 16000, featureDim: 128 },
    modelConfig: { ...base, modelType: 'nemo_transducer', transducer: { encoder: '/encoder.onnx', decoder: '/decoder.onnx', joiner: '/joiner.onnx' } },
    decodingMethod: 'greedy_search', maxActivePaths: 4,
  };
  const hotwords = normalizeZipformerHotwords(options.hotwords).join('\n');
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { ...base, ...(hotwords ? { modelingUnit: 'bpe', bpeVocab: '/zipformer-bpe.vocab' } : {}), transducer: { encoder: '/encoder.onnx', decoder: '/decoder.onnx', joiner: '/joiner.onnx' } },
    decodingMethod: hotwords ? 'modified_beam_search' : 'greedy_search', maxActivePaths: 4, enableEndpoint: 1,
    rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 1.2, rule3MinUtteranceLength: 20,
    hotwordsFile: '', hotwordsScore: 1.5, ruleFsts: '', ruleFars: '', blankPenalty: 0,
    hotwordsBuf: hotwords, hotwordsBufSize: new TextEncoder().encode(hotwords).byteLength,
    ctcFstDecoderConfig: { graph: '', maxActive: 3000 },
  };
}
export function transcriptFromNative(raw: Record<string, unknown>, options: RecognitionOptions, durationMs: number): TranscriptData {
  if (typeof raw.text !== 'string') throw new Error('Sherpa returned an invalid transcript.');
  if (options.timestamps !== 'segment') return { text: raw.text };
  const texts = raw.segment_texts;
  const starts = raw.segment_timestamps;
  const durations = raw.segment_durations;
  if (!Array.isArray(texts) || !Array.isArray(starts) || !Array.isArray(durations) || texts.length !== starts.length || texts.length !== durations.length) {
    if (!raw.text.trim()) return { text: raw.text };
    throw new Error('Sherpa did not return requested segment timestamps.');
  }
  if (raw.text.trim() && !texts.length) throw new Error('Sherpa did not return requested segment timestamps.');
  const segments: TranscriptSegment[] = texts.map((text, index) => {
    const startMs = starts[index] * 1000;
    const rawEndMs = startMs + durations[index] * 1000;
    // In segment-only mode a native unclosed segment can have zero duration;
    // never relabel that fallback as a measured endpoint.
    if (typeof text !== 'string' || typeof starts[index] !== 'number' || typeof durations[index] !== 'number' || !Number.isFinite(startMs) || !Number.isFinite(rawEndMs) || startMs < 0 || rawEndMs < startMs || (text.trim() && rawEndMs === startMs)) throw new Error('Sherpa returned invalid segment timing (including possible unclosed Whisper segment).');
    // Bound predicted endpoints to this decode window before timeline offsets.
    const endMs = Math.min(rawEndMs, durationMs);
    if (startMs > durationMs || (text.trim() && endMs <= startMs)) throw new Error('Sherpa returned segment timing outside the supplied audio.');
    return { text, timing: { startMs, endMs } };
  });
  return { text: raw.text, segments };
}
function validateSamples(samples: Float32Array) {
  if (!(samples instanceof Float32Array)) throw new TypeError('STT requires Float32Array PCM at 16000 Hz.');
  for (const sample of samples) if (!Number.isFinite(sample)) throw new Error('STT PCM must contain only finite samples.');
}
// Factory seam exercises native ownership and failure behavior without model downloads.
export const nativeFactories = {
  offline: (config: ReturnType<typeof recognizerConfig>, module: SherpaModule) => new OfflineRecognizer(config, module),
  online: (config: ReturnType<typeof recognizerConfig>, module: SherpaModule) => createOnlineRecognizer(module, config),
};
export class SherpaRecognizer {
  readonly kind: 'offline' | 'online';
  private recognizer: any;
  private stream: any;
  private finished = false;
  private options: RecognitionOptions = {};
  private tokenText = '';
  constructor(private module: SherpaModule, readonly modelId: string, assets: WorkerAssets, private diagnostics: NativeDiagnostics, private factories = nativeFactories) {
    this.kind = sttCapabilities(modelId).kind;
    ensureHeapViews(module);
    if (this.kind === 'online') this.tokenText = new TextDecoder().decode(assets.tokens);
    const capabilities = sttCapabilities(modelId);
    const v2 = capabilities.family === 'moonshine' && capabilities.moonshineVersion === 2;
    const required: (keyof WorkerAssets)[] = capabilities.family === 'moonshine'
      ? v2 ? ['tokens', 'encoder', 'merged_decoder'] : ['tokens', 'encoder', 'preprocessor', 'uncached_decoder', 'cached_decoder']
      : (this.kind === 'online' || capabilities.family === 'parakeet-tdt') ? ['tokens', 'encoder', 'decoder', 'joiner'] : ['tokens', 'encoder', 'decoder'];
    const assetPath = (key: keyof WorkerAssets) => key === 'tokens' ? '/tokens.txt' : `/${key}.${v2 ? 'ort' : 'onnx'}`;
    for (const key of required) {
      const bytes = assets[key];
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new Error(`Missing STT asset: ${key}`);
      module.FS.writeFile(assetPath(key), bytes, { canOwn: true });
    }
    try {
      diagnostics.run(() => {
        this.recognizer = factories[this.kind](recognizerConfig(modelId), module);
        if (!this.recognizer.handle) throw new Error('Sherpa failed to create the STT recognizer.');
        // Offline ORT sessions own their weights after load. Online hotword
        // reconfiguration still needs the files, so retain those until unload.
        if (this.kind === 'offline') for (const key of required) module.FS.unlink(assetPath(key));
      });
    } catch (error) {
      if (this.recognizer?.handle) this.recognizer.free();
      this.recognizer = undefined;
      throw error;
    }
  }
  configure(options: RecognitionOptions) {
    validateRecognitionOptions(this.modelId, options);
    if (this.stream) throw new Error('Cannot configure STT while a native stream is open.');
    this.requireRecognizer();
    if (sttCapabilities(this.modelId).family === 'whisper') this.diagnostics.run(() => this.recognizer.setConfig(recognizerConfig(this.modelId, options)));
    if (this.kind === 'online') {
      const hotwords = normalizeZipformerHotwords(options.hotwords);
      if (JSON.stringify(hotwords) !== JSON.stringify(normalizeZipformerHotwords(this.options.hotwords))) {
        if (hotwords.length) this.module.FS.writeFile('/zipformer-bpe.vocab', new TextEncoder().encode(zipformerVocabulary(this.tokenText)));
        let replacement: any;
        try {
          this.diagnostics.run(() => {
            replacement = this.factories.online(recognizerConfig(this.modelId, options), this.module);
            if (!replacement.handle) throw new Error('Sherpa failed to create a hotword recognizer.');
          });
        } catch (error) {
          if (replacement?.handle) replacement.free();
          throw error;
        }
        this.recognizer.free();
        this.recognizer = replacement;
      }
    }
    this.options = { ...options, ...(options.hotwords !== undefined ? { hotwords: [...options.hotwords] } : {}) };
  }
  private requireRecognizer() { if (!this.recognizer) throw new Error('STT recognizer is unloaded.'); }
  decode(samples: Float32Array): TranscriptData {
    this.requireRecognizer(); validateSamples(samples);
    if (this.kind !== 'offline') throw new Error('Online STT requires a stream.');
    if (!samples.length || samples.length > 25 * 16000) throw new Error('Offline STT requires a nonempty window of at most 25 seconds.');
    // Exact digital silence only: no energy threshold, VAD or text filtering.
    // Online streams must still consume zeros for endpoints and right context.
    if (samples.every(sample => sample === 0)) return { text: '' };
    const stream = this.diagnostics.run(() => this.recognizer.createStream());
    if (!stream.handle) throw new Error('Sherpa failed to create an offline stream.');
    try {
      const raw = this.diagnostics.run(() => {
        stream.acceptWaveform(16000, samples);
        this.recognizer.decode(stream);
        return this.recognizer.getResult(stream);
      });
      return transcriptFromNative(raw, this.options, samples.length / 16);
    } finally { stream.free(); }
  }
  openStream() {
    this.requireRecognizer();
    if (this.kind !== 'online') throw new Error('Offline STT requires managed windows.');
    if (this.stream) throw new Error('STT stream is already open.');
    const stream = this.diagnostics.run(() => this.recognizer.createStream());
    if (!stream.handle) throw new Error('Sherpa failed to create an online stream.');
    this.stream = stream; this.finished = false;
  }
  pushStream(samples: Float32Array, finish = false): { text: string; isEndpoint: boolean } {
    validateSamples(samples);
    if (!this.stream || this.finished) throw new Error('STT stream is absent or finished.');
    if (finish) this.finished = true;
    return this.diagnostics.run(() => {
      if (samples.length) this.stream.acceptWaveform(16000, samples);
      if (finish) {
        // InputFinished alone does not satisfy the encoder chunk/right-context
        // requirement. Padding is internal; orchestration retains input duration.
        this.stream.acceptWaveform(16000, new Float32Array(16000));
        this.stream.inputFinished();
      }
      while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream);
      const raw = this.recognizer.getResult(this.stream);
      if (typeof raw.text !== 'string') throw new Error('Sherpa returned an invalid online transcript.');
      return { text: raw.text, isEndpoint: Boolean(this.recognizer.isEndpoint(this.stream)) };
    });
  }
  resetStream() {
    if (!this.stream || this.finished) throw new Error('STT stream is absent or finished.');
    this.diagnostics.run(() => this.recognizer.reset(this.stream));
  }
  closeStream() { if (this.stream) { this.stream.free(); this.stream = undefined; } }
  unload() { this.closeStream(); if (this.recognizer) { this.recognizer.free(); this.recognizer = undefined; } }
}

/** Matching learned unigram scores, NOT scores inferred from token IDs.
 * Copyright 2024 Wei Kang, Apache-2.0.
 * Source: https://github.com/pkufool/simple-sentencepiece/blob/62dd423df1d51da5ea06f1c3a046fc04f01b4f39/ssentencepiece/python/tests/testdata/bpe.vocab
 * SHA-256: 28c02989b3cd8c2ffa974b1e33f97ec6cded170bda622ca627b7330b41c6c827
 * All 500 pieces match registry tokens.txt IDs 0..499; #0/#1 are disambiguators.
 */
const ZIPFORMER_VOCABULARY = "<blk>\t0\n<sos/eos>\t0\n<unk>\t0\nS\t-3.23764\n▁THE\t-3.39114\n▁A\t-3.91235\nT\t-3.9788\n▁AND\t-4.04148\nED\t-4.06805\n▁OF\t-4.11122\n▁TO\t-4.14819\nE\t-4.15925\nD\t-4.19884\nN\t-4.28917\nING\t-4.40123\n▁IN\t-4.45251\nY\t-4.52708\nM\t-4.57919\nC\t-4.62646\n▁I\t-4.68235\nA\t-4.68468\nP\t-4.69613\n▁HE\t-4.71198\nR\t-4.82144\nO\t-4.83893\nL\t-4.88007\nRE\t-4.88603\nI\t-4.90352\nU\t-4.91157\nER\t-4.95434\n▁IT\t-4.99701\nLY\t-5.00155\n▁THAT\t-5.00795\n▁WAS\t-5.04607\n▁\t-5.05486\n▁S\t-5.05888\nAR\t-5.10129\n▁BE\t-5.14569\nF\t-5.18181\n▁C\t-5.18836\nIN\t-5.20029\nB\t-5.20859\n▁FOR\t-5.23485\nOR\t-5.26974\nLE\t-5.2702\n'\t-5.27032\n▁HIS\t-5.28672\n▁YOU\t-5.34529\nAL\t-5.35383\n▁RE\t-5.35863\nV\t-5.36811\n▁B\t-5.36912\nG\t-5.39337\nRI\t-5.41681\n▁E\t-5.41899\n▁WITH\t-5.4268\n▁T\t-5.49151\n▁AS\t-5.50186\nLL\t-5.50605\n▁P\t-5.51409\n▁HER\t-5.52391\nST\t-5.52898\n▁HAD\t-5.53885\n▁SO\t-5.56342\n▁F\t-5.56472\nW\t-5.57126\nCE\t-5.61235\n▁IS\t-5.63341\nND\t-5.63677\n▁NOT\t-5.64685\nTH\t-5.65822\n▁BUT\t-5.65885\nEN\t-5.67118\n▁SHE\t-5.67453\n▁ON\t-5.67506\nVE\t-5.6788\nON\t-5.68108\nSE\t-5.68128\n▁DE\t-5.68499\nUR\t-5.70257\n▁G\t-5.70716\nCH\t-5.71597\nK\t-5.73117\nTER\t-5.73588\n▁AT\t-5.74333\nIT\t-5.75281\n▁ME\t-5.75999\nRO\t-5.78792\nNE\t-5.81237\nRA\t-5.84735\nES\t-5.86915\nIL\t-5.9164\nNG\t-5.95522\nIC\t-5.95622\n▁NO\t-5.95875\n▁HIM\t-5.9632\nENT\t-5.96542\nIR\t-5.98727\n▁WE\t-6.00283\nH\t-6.00505\n▁DO\t-6.01678\n▁ALL\t-6.0215\n▁HAVE\t-6.04155\nLO\t-6.04175\n▁BY\t-6.0754\n▁MY\t-6.07629\n▁MO\t-6.07686\n▁THIS\t-6.07749\nLA\t-6.07936\n▁ST\t-6.10084\n▁WHICH\t-6.10116\n▁CON\t-6.11572\n▁THEY\t-6.13378\nCK\t-6.13419\nTE\t-6.14807\n▁SAID\t-6.15974\n▁FROM\t-6.16115\n▁GO\t-6.16495\n▁WHO\t-6.17239\n▁TH\t-6.18452\n▁OR\t-6.18883\n▁D\t-6.18975\n▁W\t-6.19439\nVER\t-6.20494\nLI\t-6.22095\n▁SE\t-6.2297\n▁ONE\t-6.23026\n▁CA\t-6.23397\n▁AN\t-6.24262\n▁LA\t-6.24786\n▁WERE\t-6.24858\nEL\t-6.271\n▁HA\t-6.28368\n▁MAN\t-6.29896\n▁FA\t-6.31168\n▁EX\t-6.31364\nAD\t-6.31526\n▁SU\t-6.34091\nRY\t-6.35457\n▁MI\t-6.37021\nAT\t-6.39107\n▁BO\t-6.39815\n▁WHEN\t-6.40637\nAN\t-6.41853\nTHER\t-6.42115\nPP\t-6.43792\nATION\t-6.44105\n▁FI\t-6.45761\n▁WOULD\t-6.47257\n▁PRO\t-6.47274\nOW\t-6.48047\nET\t-6.48289\n▁O\t-6.48763\n▁THERE\t-6.48808\n▁HO\t-6.48841\nION\t-6.48846\n▁WHAT\t-6.49159\n▁FE\t-6.49797\n▁PA\t-6.50029\nUS\t-6.50081\nMENT\t-6.50395\n▁MA\t-6.50516\nUT\t-6.53807\n▁OUT\t-6.54596\n▁THEIR\t-6.54897\n▁IF\t-6.55068\n▁LI\t-6.55453\n▁K\t-6.56374\n▁WILL\t-6.5669\n▁ARE\t-6.57477\nID\t-6.57502\n▁RO\t-6.57553\nDE\t-6.58188\nTION\t-6.59518\n▁WA\t-6.59566\nPE\t-6.60184\n▁UP\t-6.60311\n▁SP\t-6.61112\n▁PO\t-6.61409\nIGHT\t-6.63771\n▁UN\t-6.64183\nRU\t-6.64252\n▁LO\t-6.64639\nAS\t-6.64889\nOL\t-6.65442\n▁LE\t-6.66382\n▁BEEN\t-6.67806\n▁SH\t-6.67835\n▁RA\t-6.68003\n▁SEE\t-6.69546\nKE\t-6.70826\nUL\t-6.71612\nTED\t-6.71696\n▁SA\t-6.72967\nUN\t-6.73177\nUND\t-6.73395\nANT\t-6.73423\n▁NE\t-6.743\nIS\t-6.75404\n▁THEM\t-6.75743\nCI\t-6.76993\nGE\t-6.77069\n▁COULD\t-6.77503\n▁DIS\t-6.78135\nOM\t-6.79366\nISH\t-6.80337\nHE\t-6.80705\nEST\t-6.81058\n▁SOME\t-6.81704\nENCE\t-6.82267\nITY\t-6.83585\nIVE\t-6.84022\n▁US\t-6.84091\n▁MORE\t-6.84456\n▁EN\t-6.84947\nARD\t-6.85159\nATE\t-6.86067\n▁YOUR\t-6.86188\n▁INTO\t-6.86252\n▁KNOW\t-6.86753\n▁CO\t-6.86961\nANCE\t-6.8727\n▁TIME\t-6.8751\n▁WI\t-6.88392\n▁YE\t-6.8877\nAGE\t-6.8955\n▁NOW\t-6.90387\nTI\t-6.90402\nFF\t-6.90618\nABLE\t-6.90917\n▁VERY\t-6.92207\n▁LIKE\t-6.92869\nAM\t-6.94687\nHI\t-6.94986\nZ\t-6.9511\n▁OTHER\t-6.96464\n▁THAN\t-6.97308\n▁LITTLE\t-6.97622\n▁DID\t-6.98152\n▁LOOK\t-6.98467\nTY\t-6.99474\nERS\t-6.99918\n▁CAN\t-7.00994\n▁CHA\t-7.01063\n▁AR\t-7.02555\nX\t-7.02668\nFUL\t-7.03465\nUGH\t-7.04608\n▁BA\t-7.04937\n▁DAY\t-7.0543\n▁ABOUT\t-7.05554\nTEN\t-7.05588\nIM\t-7.0583\n▁ANY\t-7.05892\n▁PRE\t-7.06131\n▁OVER\t-7.06494\nIES\t-7.07832\nNESS\t-7.08111\nME\t-7.08369\nBLE\t-7.08645\n▁M\t-7.09032\nROW\t-7.09219\n▁HAS\t-7.0976\n▁GREAT\t-7.10444\n▁VI\t-7.10527\nTA\t-7.10781\n▁AFTER\t-7.10952\nPER\t-7.1132\n▁AGAIN\t-7.11478\nHO\t-7.11545\nSH\t-7.11555\n▁UPON\t-7.12675\n▁DI\t-7.13004\n▁HAND\t-7.13211\n▁COM\t-7.13273\nIST\t-7.13438\nTURE\t-7.13771\n▁STA\t-7.14628\n▁THEN\t-7.15775\n▁SHOULD\t-7.15836\n▁GA\t-7.16774\nOUS\t-7.16944\nOUR\t-7.16965\n▁WELL\t-7.17122\n▁ONLY\t-7.17628\nMAN\t-7.17899\n▁GOOD\t-7.18494\n▁TWO\t-7.18746\n▁MAR\t-7.18755\n▁SAY\t-7.19636\n▁HU\t-7.20214\nTING\t-7.20818\n▁OUR\t-7.21813\nRESS\t-7.22296\n▁DOWN\t-7.22319\nIOUS\t-7.24748\n▁BEFORE\t-7.24835\n▁DA\t-7.2508\n▁NA\t-7.25861\nQUI\t-7.26388\n▁MADE\t-7.26918\n▁EVERY\t-7.26921\n▁OLD\t-7.27794\n▁EVEN\t-7.28005\nIG\t-7.28081\n▁COME\t-7.28172\n▁GRA\t-7.28522\n▁RI\t-7.29145\n▁LONG\t-7.29314\nOT\t-7.29691\nSIDE\t-7.30065\nWARD\t-7.31155\n▁FO\t-7.31391\n▁WHERE\t-7.31479\nMO\t-7.31992\nLESS\t-7.32883\n▁SC\t-7.32891\n▁MUST\t-7.3305\n▁NEVER\t-7.33078\n▁HOW\t-7.34345\n▁CAME\t-7.34599\n▁SUCH\t-7.34721\n▁RU\t-7.35962\n▁TAKE\t-7.35962\n▁WO\t-7.36853\n▁CAR\t-7.37945\nUM\t-7.37964\nAK\t-7.39205\n▁THINK\t-7.40939\n▁MUCH\t-7.40963\n▁MISTER\t-7.4201\n▁MAY\t-7.43389\n▁JO\t-7.44387\n▁WAY\t-7.4456\n▁COMP\t-7.45547\n▁THOUGHT\t-7.45606\n▁STO\t-7.46284\n▁MEN\t-7.46377\n▁BACK\t-7.46526\n▁DON\t-7.46548\nJ\t-7.46605\n▁LET\t-7.48391\n▁TRA\t-7.4958\n▁FIRST\t-7.49608\n▁JUST\t-7.49723\n▁VA\t-7.49963\n▁OWN\t-7.51114\n▁PLA\t-7.51664\n▁MAKE\t-7.5218\nATED\t-7.52921\n▁HIMSELF\t-7.53339\n▁WENT\t-7.54\n▁PI\t-7.55717\nGG\t-7.55994\nRING\t-7.5606\n▁DU\t-7.56341\n▁MIGHT\t-7.56862\n▁PART\t-7.57009\n▁GIVE\t-7.58394\n▁IMP\t-7.58817\n▁BU\t-7.59192\n▁PER\t-7.59583\n▁PLACE\t-7.60502\n▁HOUSE\t-7.60934\n▁THROUGH\t-7.62521\nIAN\t-7.62855\n▁SW\t-7.63782\n▁UNDER\t-7.64373\nQUE\t-7.64402\n▁AWAY\t-7.64512\n▁LOVE\t-7.64681\nQUA\t-7.65031\n▁LIFE\t-7.66029\n▁GET\t-7.66648\n▁WITHOUT\t-7.67412\n▁PASS\t-7.682\n▁TURN\t-7.69236\nIGN\t-7.69649\n▁HEAD\t-7.69697\n▁MOST\t-7.70515\n▁THOSE\t-7.7168\n▁SHALL\t-7.71795\n▁EYES\t-7.71861\n▁COL\t-7.74121\n▁STILL\t-7.74208\n▁NIGHT\t-7.74542\n▁NOTHING\t-7.76816\nITION\t-7.76824\nHA\t-7.76993\n▁TELL\t-7.76996\n▁WORK\t-7.77374\n▁LAST\t-7.77545\n▁NEW\t-7.78277\n▁FACE\t-7.78386\n▁HI\t-7.79126\n▁WORD\t-7.8012\n▁FOUND\t-7.80479\n▁COUNT\t-7.80516\n▁OB\t-7.80527\n▁WHILE\t-7.80765\n▁SHA\t-7.81719\n▁MEAN\t-7.83619\n▁SAW\t-7.83676\n▁PEOPLE\t-7.83766\n▁FRIEND\t-7.8565\n▁THREE\t-7.86814\n▁ROOM\t-7.87585\n▁SAME\t-7.88751\n▁THOUGH\t-7.89248\n▁RIGHT\t-7.89619\n▁CHILD\t-7.89778\n▁FATHER\t-7.90382\n▁ANOTHER\t-7.90587\n▁HEART\t-7.91276\n▁WANT\t-7.92235\n▁TOOK\t-7.94253\nOOK\t-7.94851\n▁LIGHT\t-7.96145\n▁MISSUS\t-7.9786\n▁OPEN\t-7.98527\n▁JU\t-7.9894\n▁ASKED\t-7.99096\nPORT\t-8.0012\n▁LEFT\t-8.00187\n▁JA\t-8.02979\n▁WORLD\t-8.03992\n▁HOME\t-8.04939\n▁WHY\t-8.0618\n▁ALWAYS\t-8.06564\n▁ANSWER\t-8.0739\n▁SEEMED\t-8.088\n▁SOMETHING\t-8.08951\n▁GIRL\t-8.09335\n▁BECAUSE\t-8.10615\n▁NAME\t-8.10768\n▁TOLD\t-8.11746\n▁NI\t-8.12176\n▁HIGH\t-8.12178\nIZE\t-8.13805\n▁WOMAN\t-8.14522\n▁FOLLOW\t-8.15124\n▁RETURN\t-8.17126\n▁KNEW\t-8.17579\n▁EACH\t-8.18032\n▁KIND\t-8.18787\n▁JE\t-8.19007\n▁ACT\t-8.20004\n▁LU\t-8.20535\n▁CERTAIN\t-8.21049\n▁YEARS\t-8.2275\n▁QUITE\t-8.22848\n▁APPEAR\t-8.23444\n▁BETTER\t-8.24887\n▁HALF\t-8.25101\n▁PRESENT\t-8.25108\n▁PRINCE\t-8.263\nSHIP\t-8.26654\n▁ALSO\t-8.27005\n▁BEGAN\t-8.27496\n▁HAVING\t-8.28474\n▁ENOUGH\t-8.28608\n▁PERSON\t-8.28836\n▁LADY\t-8.29498\n▁WHITE\t-8.3115\n▁COURSE\t-8.31653\n▁VOICE\t-8.3193\n▁SPEAK\t-8.32799\n▁POWER\t-8.35211\n▁MORNING\t-8.35582\n▁BETWEEN\t-8.3565\n▁AMONG\t-8.35997\n▁KEEP\t-8.36216\n▁WALK\t-8.3686\n▁MATTER\t-8.37061\n▁TEA\t-8.37863\n▁BELIEVE\t-8.37922\n▁SMALL\t-8.3814\n▁TALK\t-8.38939\n▁FELT\t-8.39477\n▁HORSE\t-8.39834\n▁MYSELF\t-8.40051\n▁SIX\t-8.40069\n▁HOWEVER\t-8.40304\n▁FULL\t-8.40399\n▁HERSELF\t-8.40714\n▁POINT\t-8.41248\n▁STOOD\t-8.41336\n▁HUNDRED\t-8.41404\n▁ALMOST\t-8.42802\n▁SINCE\t-8.43626\n▁LARGE\t-8.44207\n▁LEAVE\t-8.44699\n▁PERHAPS\t-8.4576\n▁DARK\t-8.46885\n▁SUDDEN\t-8.46906\n▁REPLIED\t-8.47536\n▁ANYTHING\t-8.48241\n▁WONDER\t-8.48792\n▁UNTIL\t-8.48926\nQ\t-9.78832\n";
export function zipformerVocabulary(tokenText: string): string {
  const expected = ZIPFORMER_VOCABULARY.trim().split('\n').map(line => line.split(/\s+/)[0]);
  expected.push('#0', '#1');
  const actual = tokenText.trim().split(/\r?\n/);
  if (actual.length !== expected.length || actual.some((line, id) => {
    const fields = line.trim().split(/\s+/);
    return fields.length !== 2 || fields[0] !== expected[id] || fields[1] !== String(id);
  })) throw new Error('Zipformer token asset does not match the bundled hotword vocabulary.');
  return ZIPFORMER_VOCABULARY;
}

/*!
 * Bundled Zipformer vocabulary: simple-sentencepiece test fixture.
 * Copyright 2024 Wei Kang. SPDX-License-Identifier: Apache-2.0
 * Copied without changing vocabulary contents; encoded as a JS string above.
 * Source commit: 62dd423df1d51da5ea06f1c3a046fc04f01b4f39
 * The following license applies to that vocabulary, not the whole Wfloat SDK.

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

*/
