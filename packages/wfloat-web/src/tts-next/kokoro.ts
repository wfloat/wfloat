import { createOfflineTts, type OfflineTts, type SherpaModule, type OfflineTtsGenerateConfig } from '../wasm/sherpa-onnx-tts.js';
import { kokoroLanguage } from './families.js';
export type SherpaTts = Pick<OfflineTts, 'handle' | 'sampleRate' | 'numSpeakers' | 'generate' | 'free'>;

/** FSTs are engine-wide. Replace one session when a dialogue moves into/out of
 * Chinese, so other voices don't speak Chinese numbers. Never hold two models. */
export class KokoroSession implements SherpaTts {
  private active?: OfflineTts;
  private chinese = false;
  private closed = false;
  readonly sampleRate = 24000;
  readonly numSpeakers = 54;
  get handle() { return this.active?.handle ?? 0; }
  constructor(private module: SherpaModule, private create = createOfflineTts) { this.open(false); }
  private open(chinese: boolean) {
    this.active?.free();
    this.active = undefined;
    const next = this.create(this.module, {
      offlineTtsModelConfig: { offlineTtsKokoroModelConfig: {
        model: '/model_onnx', voices: '/model_voices', tokens: '/model_tokens', dataDir: '/espeak-ng-data',
        lexicon: '/lexicon_zh', lang: 'en-us', lengthScale: 1,
      }, numThreads: 1, debug: 0, provider: 'cpu' },
      ruleFsts: chinese ? '/rule_date_zh,/rule_number_zh,/rule_phone_zh' : '', ruleFars: '', maxNumSentences: 1, silenceScale: 1,
    });
    if (next.sampleRate !== this.sampleRate || next.numSpeakers !== this.numSpeakers) {
      next.free(); throw new Error('Kokoro runtime metadata does not match the pinned 54-speaker export.');
    }
    this.active = next;
    this.chinese = chinese;
  }
  generate(config: OfflineTtsGenerateConfig) {
    if (this.closed) throw new Error('Kokoro session is unloaded.');
    const language = kokoroLanguage(config.sid);
    const chinese = language === 'cmn';
    if (!this.active || this.chinese !== chinese) this.open(chinese);
    // Han uses lexicon-zh; Latin words in Chinese use the model's English voice.
    return this.active!.generate({ ...config, extra: { lang: chinese ? 'en-us' : language } });
  }
  free() { this.closed = true; this.active?.free(); this.active = undefined; }
}
