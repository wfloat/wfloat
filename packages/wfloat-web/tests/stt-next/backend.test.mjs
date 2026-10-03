import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from '../../node_modules/esbuild/lib/main.js';
const load = async path => {
  const result = await build({ entryPoints: [new URL(path, import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
};
const { SherpaSpeechToTextBackend } = await load('../../src/stt-next/backend.ts');
const { NativeDiagnostics, SherpaRecognizer, recognizerConfig, transcriptFromNative, zipformerVocabulary } = await load('../../src/stt-next/sherpa.ts');
const { validateRecognitionOptions, normalizeZipformerHotwords, sttCapabilities } = await load('../../src/stt-next/capabilities.ts');
const ZIPFORMER_TOKENS = "<blk> 0\n<sos/eos> 1\n<unk> 2\nS 3\n▁THE 4\n▁A 5\nT 6\n▁AND 7\nED 8\n▁OF 9\n▁TO 10\nE 11\nD 12\nN 13\nING 14\n▁IN 15\nY 16\nM 17\nC 18\n▁I 19\nA 20\nP 21\n▁HE 22\nR 23\nO 24\nL 25\nRE 26\nI 27\nU 28\nER 29\n▁IT 30\nLY 31\n▁THAT 32\n▁WAS 33\n▁ 34\n▁S 35\nAR 36\n▁BE 37\nF 38\n▁C 39\nIN 40\nB 41\n▁FOR 42\nOR 43\nLE 44\n' 45\n▁HIS 46\n▁YOU 47\nAL 48\n▁RE 49\nV 50\n▁B 51\nG 52\nRI 53\n▁E 54\n▁WITH 55\n▁T 56\n▁AS 57\nLL 58\n▁P 59\n▁HER 60\nST 61\n▁HAD 62\n▁SO 63\n▁F 64\nW 65\nCE 66\n▁IS 67\nND 68\n▁NOT 69\nTH 70\n▁BUT 71\nEN 72\n▁SHE 73\n▁ON 74\nVE 75\nON 76\nSE 77\n▁DE 78\nUR 79\n▁G 80\nCH 81\nK 82\nTER 83\n▁AT 84\nIT 85\n▁ME 86\nRO 87\nNE 88\nRA 89\nES 90\nIL 91\nNG 92\nIC 93\n▁NO 94\n▁HIM 95\nENT 96\nIR 97\n▁WE 98\nH 99\n▁DO 100\n▁ALL 101\n▁HAVE 102\nLO 103\n▁BY 104\n▁MY 105\n▁MO 106\n▁THIS 107\nLA 108\n▁ST 109\n▁WHICH 110\n▁CON 111\n▁THEY 112\nCK 113\nTE 114\n▁SAID 115\n▁FROM 116\n▁GO 117\n▁WHO 118\n▁TH 119\n▁OR 120\n▁D 121\n▁W 122\nVER 123\nLI 124\n▁SE 125\n▁ONE 126\n▁CA 127\n▁AN 128\n▁LA 129\n▁WERE 130\nEL 131\n▁HA 132\n▁MAN 133\n▁FA 134\n▁EX 135\nAD 136\n▁SU 137\nRY 138\n▁MI 139\nAT 140\n▁BO 141\n▁WHEN 142\nAN 143\nTHER 144\nPP 145\nATION 146\n▁FI 147\n▁WOULD 148\n▁PRO 149\nOW 150\nET 151\n▁O 152\n▁THERE 153\n▁HO 154\nION 155\n▁WHAT 156\n▁FE 157\n▁PA 158\nUS 159\nMENT 160\n▁MA 161\nUT 162\n▁OUT 163\n▁THEIR 164\n▁IF 165\n▁LI 166\n▁K 167\n▁WILL 168\n▁ARE 169\nID 170\n▁RO 171\nDE 172\nTION 173\n▁WA 174\nPE 175\n▁UP 176\n▁SP 177\n▁PO 178\nIGHT 179\n▁UN 180\nRU 181\n▁LO 182\nAS 183\nOL 184\n▁LE 185\n▁BEEN 186\n▁SH 187\n▁RA 188\n▁SEE 189\nKE 190\nUL 191\nTED 192\n▁SA 193\nUN 194\nUND 195\nANT 196\n▁NE 197\nIS 198\n▁THEM 199\nCI 200\nGE 201\n▁COULD 202\n▁DIS 203\nOM 204\nISH 205\nHE 206\nEST 207\n▁SOME 208\nENCE 209\nITY 210\nIVE 211\n▁US 212\n▁MORE 213\n▁EN 214\nARD 215\nATE 216\n▁YOUR 217\n▁INTO 218\n▁KNOW 219\n▁CO 220\nANCE 221\n▁TIME 222\n▁WI 223\n▁YE 224\nAGE 225\n▁NOW 226\nTI 227\nFF 228\nABLE 229\n▁VERY 230\n▁LIKE 231\nAM 232\nHI 233\nZ 234\n▁OTHER 235\n▁THAN 236\n▁LITTLE 237\n▁DID 238\n▁LOOK 239\nTY 240\nERS 241\n▁CAN 242\n▁CHA 243\n▁AR 244\nX 245\nFUL 246\nUGH 247\n▁BA 248\n▁DAY 249\n▁ABOUT 250\nTEN 251\nIM 252\n▁ANY 253\n▁PRE 254\n▁OVER 255\nIES 256\nNESS 257\nME 258\nBLE 259\n▁M 260\nROW 261\n▁HAS 262\n▁GREAT 263\n▁VI 264\nTA 265\n▁AFTER 266\nPER 267\n▁AGAIN 268\nHO 269\nSH 270\n▁UPON 271\n▁DI 272\n▁HAND 273\n▁COM 274\nIST 275\nTURE 276\n▁STA 277\n▁THEN 278\n▁SHOULD 279\n▁GA 280\nOUS 281\nOUR 282\n▁WELL 283\n▁ONLY 284\nMAN 285\n▁GOOD 286\n▁TWO 287\n▁MAR 288\n▁SAY 289\n▁HU 290\nTING 291\n▁OUR 292\nRESS 293\n▁DOWN 294\nIOUS 295\n▁BEFORE 296\n▁DA 297\n▁NA 298\nQUI 299\n▁MADE 300\n▁EVERY 301\n▁OLD 302\n▁EVEN 303\nIG 304\n▁COME 305\n▁GRA 306\n▁RI 307\n▁LONG 308\nOT 309\nSIDE 310\nWARD 311\n▁FO 312\n▁WHERE 313\nMO 314\nLESS 315\n▁SC 316\n▁MUST 317\n▁NEVER 318\n▁HOW 319\n▁CAME 320\n▁SUCH 321\n▁RU 322\n▁TAKE 323\n▁WO 324\n▁CAR 325\nUM 326\nAK 327\n▁THINK 328\n▁MUCH 329\n▁MISTER 330\n▁MAY 331\n▁JO 332\n▁WAY 333\n▁COMP 334\n▁THOUGHT 335\n▁STO 336\n▁MEN 337\n▁BACK 338\n▁DON 339\nJ 340\n▁LET 341\n▁TRA 342\n▁FIRST 343\n▁JUST 344\n▁VA 345\n▁OWN 346\n▁PLA 347\n▁MAKE 348\nATED 349\n▁HIMSELF 350\n▁WENT 351\n▁PI 352\nGG 353\nRING 354\n▁DU 355\n▁MIGHT 356\n▁PART 357\n▁GIVE 358\n▁IMP 359\n▁BU 360\n▁PER 361\n▁PLACE 362\n▁HOUSE 363\n▁THROUGH 364\nIAN 365\n▁SW 366\n▁UNDER 367\nQUE 368\n▁AWAY 369\n▁LOVE 370\nQUA 371\n▁LIFE 372\n▁GET 373\n▁WITHOUT 374\n▁PASS 375\n▁TURN 376\nIGN 377\n▁HEAD 378\n▁MOST 379\n▁THOSE 380\n▁SHALL 381\n▁EYES 382\n▁COL 383\n▁STILL 384\n▁NIGHT 385\n▁NOTHING 386\nITION 387\nHA 388\n▁TELL 389\n▁WORK 390\n▁LAST 391\n▁NEW 392\n▁FACE 393\n▁HI 394\n▁WORD 395\n▁FOUND 396\n▁COUNT 397\n▁OB 398\n▁WHILE 399\n▁SHA 400\n▁MEAN 401\n▁SAW 402\n▁PEOPLE 403\n▁FRIEND 404\n▁THREE 405\n▁ROOM 406\n▁SAME 407\n▁THOUGH 408\n▁RIGHT 409\n▁CHILD 410\n▁FATHER 411\n▁ANOTHER 412\n▁HEART 413\n▁WANT 414\n▁TOOK 415\nOOK 416\n▁LIGHT 417\n▁MISSUS 418\n▁OPEN 419\n▁JU 420\n▁ASKED 421\nPORT 422\n▁LEFT 423\n▁JA 424\n▁WORLD 425\n▁HOME 426\n▁WHY 427\n▁ALWAYS 428\n▁ANSWER 429\n▁SEEMED 430\n▁SOMETHING 431\n▁GIRL 432\n▁BECAUSE 433\n▁NAME 434\n▁TOLD 435\n▁NI 436\n▁HIGH 437\nIZE 438\n▁WOMAN 439\n▁FOLLOW 440\n▁RETURN 441\n▁KNEW 442\n▁EACH 443\n▁KIND 444\n▁JE 445\n▁ACT 446\n▁LU 447\n▁CERTAIN 448\n▁YEARS 449\n▁QUITE 450\n▁APPEAR 451\n▁BETTER 452\n▁HALF 453\n▁PRESENT 454\n▁PRINCE 455\nSHIP 456\n▁ALSO 457\n▁BEGAN 458\n▁HAVING 459\n▁ENOUGH 460\n▁PERSON 461\n▁LADY 462\n▁WHITE 463\n▁COURSE 464\n▁VOICE 465\n▁SPEAK 466\n▁POWER 467\n▁MORNING 468\n▁BETWEEN 469\n▁AMONG 470\n▁KEEP 471\n▁WALK 472\n▁MATTER 473\n▁TEA 474\n▁BELIEVE 475\n▁SMALL 476\n▁TALK 477\n▁FELT 478\n▁HORSE 479\n▁MYSELF 480\n▁SIX 481\n▁HOWEVER 482\n▁FULL 483\n▁HERSELF 484\n▁POINT 485\n▁STOOD 486\n▁HUNDRED 487\n▁ALMOST 488\n▁SINCE 489\n▁LARGE 490\n▁LEAVE 491\n▁PERHAPS 492\n▁DARK 493\n▁SUDDEN 494\n▁REPLIED 495\n▁ANYTHING 496\n▁WONDER 497\n▁UNTIL 498\nQ 499\n#0 500\n#1 501\n";
const whisper = 'openai/whisper-tiny-en';
const zipformer = 'k2-fsa/streaming-zipformer-en';
class Worker {
  listeners = new Map(); requests = []; terminated = 0;
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type) { this.listeners.delete(type); }
  postMessage(request, transfer) { this.requests.push(structuredClone(request, { transfer })); }
  terminate() { this.terminated++; }
  reply(value, error, index = this.requests.length - 1) { this.listeners.get('message')?.({ data: { id: this.requests[index].id, value, error } }); }
}
function fixture(modelId = whisper, tokens = ZIPFORMER_TOKENS) {
  const calls = []; const diagnostics = new NativeDiagnostics();
  let result = { text: 'hello' }; let fail = false; let ready = 0;
  const stream = { handle: 2, acceptWaveform: (rate, samples) => { calls.push(['accept', rate, samples.length]); ready++; }, free: () => calls.push(['stream-free']), inputFinished: () => calls.push(['finish']) };
  const native = { handle: 1, createStream: () => stream, setConfig: config => calls.push(['config', config]), decode: () => { ready--; if (fail) diagnostics.print('Caught exception: ORT failed. Return an empty result.'); }, getResult: () => result, isReady: () => ready > 0, isEndpoint: () => false, reset: () => calls.push(['reset']), free: () => calls.push(['recognizer-free']) };
  const module = { HEAP8: new Int8Array(1), HEAP32: new Int32Array(1), HEAPF32: new Float32Array(1), FS: { writeFile(path, bytes) { calls.push(['file', path, bytes]); } } };
  const assets = Object.fromEntries(['tokens', 'encoder', 'decoder', 'joiner', 'preprocessor', 'uncached_decoder', 'cached_decoder'].map(key => [key, new Uint8Array([1])]));
  if (modelId === zipformer) assets.tokens = new TextEncoder().encode(tokens);
  const recognizer = new SherpaRecognizer(module, modelId, assets, diagnostics, { offline: () => native, online: config => { calls.push(['online-config', config]); return { ...native }; } });
  calls.length = 0;
  return { recognizer, calls, result: value => result = value, fail: () => fail = true };
}
test('capabilities reject unsupported requests before worker scheduling', () => {
  for (const model of [whisper, zipformer, 'UsefulSensors/moonshine-tiny']) {
    validateRecognitionOptions(model, { language: 'en-US', task: 'transcribe' });
    for (const options of [{ language: 'fr' }, { task: 'translate' }, { timestamps: 'word' }]) assert.throws(() => validateRecognitionOptions(model, options));
  }
  assert.throws(() => validateRecognitionOptions(whisper, { hotwords: ['hello'] }));
  assert.throws(() => validateRecognitionOptions(zipformer, { timestamps: 'segment' }));
  const worker = new Worker(); const backend = new SherpaSpeechToTextBackend(worker, whisper);
  assert.throws(() => backend.configure({ task: 'translate' })); assert.equal(worker.requests.length, 0);
});
test('Whisper configuration applies the coordinated timestamp capability', () => {
  const f = fixture();
  f.recognizer.configure({ language: 'en-GB', task: 'transcribe' });
  assert.equal(f.calls[0][1].modelConfig.whisper.language, 'en');
  assert.equal(f.calls[0][1].modelConfig.whisper.task, 'transcribe');
  assert.equal(f.calls[0][1].modelConfig.whisper.enableSegmentTimestamps, 0);
  assert.equal(sttCapabilities(whisper).segmentTimestamps, true);
  f.recognizer.configure({ timestamps: 'segment' });
  assert.equal(f.calls.at(-1)[1].modelConfig.whisper.enableSegmentTimestamps, 1);
  f.result({ text: 'hello', segment_texts: ['hello'], segment_timestamps: [0.25], segment_durations: [0.5] });
  assert.deepEqual(f.recognizer.decode(new Float32Array(16000).fill(0.1)), { text: 'hello', segments: [{ text: 'hello', timing: { startMs: 250, endMs: 750 } }] });
  f.recognizer.configure({});
  assert.equal(f.calls.at(-1)[1].modelConfig.whisper.enableSegmentTimestamps, 0);
  assert.deepEqual(f.recognizer.decode(new Float32Array(16000).fill(0.1)), { text: 'hello' });
  assert.deepEqual(transcriptFromNative({ text: 'hello', segment_texts: ['hello'], segment_timestamps: [0.25], segment_durations: [0.5] }, { timestamps: 'segment' }, 1000), { text: 'hello', segments: [{ text: 'hello', timing: { startMs: 250, endMs: 750 } }] });
  assert.equal(recognizerConfig(whisper).modelConfig.whisper.enableTokenTimestamps, 0);
});
test('segment timing rejects missing, sentinel-zero and malformed data, but valid silence succeeds', () => {
  for (const raw of [{ text: 'hello' }, { text: 'hello', segment_texts: ['hello'], segment_timestamps: [1], segment_durations: [0] }, { text: 'hello', segment_texts: ['hello'], segment_timestamps: ['1'], segment_durations: [1] }]) assert.throws(() => transcriptFromNative(raw, { timestamps: 'segment' }, 5000));
  assert.deepEqual(transcriptFromNative({ text: '' }, { timestamps: 'segment' }, 1000), { text: '' });
});
test('caught native exceptions fail and free offline stream; oversized windows reject', () => {
  const f = fixture(); f.fail();
  assert.throws(() => f.recognizer.decode(new Float32Array(16000).fill(0.1)), /ORT failed/);
  assert.equal(f.calls.at(-1)[0], 'stream-free');
  assert.throws(() => f.recognizer.decode(new Float32Array(400001)), /25 seconds/);
});
test('online tail is padded, drained and finished exactly once; reset retains open ownership', () => {
  const f = fixture(zipformer); f.recognizer.openStream();
  assert.throws(() => f.recognizer.openStream(), /already/);
  assert.throws(() => f.recognizer.configure({}), /open/);
  assert.deepEqual(f.recognizer.pushStream(new Float32Array(50)), { text: 'hello', isEndpoint: false });
  f.recognizer.resetStream();
  f.recognizer.pushStream(new Float32Array(0), true);
  assert.deepEqual(f.calls.filter(x => x[0] === 'accept'), [['accept', 16000, 50], ['accept', 16000, 16000]]);
  assert.throws(() => f.recognizer.pushStream(new Float32Array(1)), /finished/);
  f.recognizer.closeStream(); f.recognizer.closeStream(); f.recognizer.unload();
  assert.equal(f.calls.filter(x => x[0] === 'stream-free').length, 1);
});
test('request failure preserves worker; PCM cloned; unload waits for native cleanup', async () => {
  const worker = new Worker(); const backend = new SherpaSpeechToTextBackend(worker, whisper);
  const samples = new Float32Array([0.3]); const decode = backend.decode(samples); samples[0] = 0;
  assert.notEqual(worker.requests[0].samples[0], 0); assert.equal(samples.byteLength, 4);
  worker.reply(undefined, { name: 'Error', message: 'bad decode' }); await assert.rejects(decode, /bad decode/); assert.equal(worker.terminated, 0);
  const next = backend.decode(samples); worker.reply({ text: '' }); assert.deepEqual(await next, { text: '' });
  const unload = backend.unload(); assert.equal(worker.terminated, 0); assert.equal(backend.unload(), unload);
  worker.reply(); await unload; assert.equal(worker.terminated, 1);
});
test('fatal worker failure notifies idle session and rejects future requests', async () => {
  const worker = new Worker(); const backend = new SherpaSpeechToTextBackend(worker, whisper); const failures = [];
  backend.setFailureHandler(error => failures.push(error)); worker.listeners.get('error')({ message: 'crashed' });
  assert.equal(failures.length, 1); await assert.rejects(backend.openStream(), /crashed/);
  await backend.unload(); assert.equal(worker.terminated, 1);
});
test('asset transfer deduplicates shared buffers and synchronous postMessage failure rejects', async () => {
  const worker = new Worker(); const backend = new SherpaSpeechToTextBackend(worker, whisper);
  const bytes = new Uint8Array([1,2]); const init = backend.initialize({ wasm: bytes, tokens: bytes, encoder: bytes, decoder: bytes });
  assert.equal(bytes.byteLength, 0); worker.reply(); await init;
  worker.postMessage = () => { throw new Error('clone failure'); };
  await assert.rejects(backend.decode(new Float32Array(1)), /clone failure/);
});
test('fatal error during unload rejects cleanup instead of hanging', async () => {
  const worker = new Worker(); const backend = new SherpaSpeechToTextBackend(worker, whisper);
  const unloading = backend.unload();
  worker.listeners.get('error')({ message: 'aborted during cleanup' });
  await assert.rejects(unloading, /aborted during cleanup/); assert.equal(worker.terminated, 1);
});
test('initialization abort interrupts a worker that never responds and rejects pending requests', async () => {
  const worker = new Worker(); const backend = new SherpaSpeechToTextBackend(worker, whisper);
  const init = backend.initialize({ wasm: new Uint8Array([1]), tokens: new Uint8Array([1]), encoder: new Uint8Array([1]) });
  const configure = backend.configure({});
  backend.abortInitialization(); backend.abortInitialization();
  await assert.rejects(init, { name: 'AbortError' });
  await assert.rejects(configure, { name: 'AbortError' });
  assert.equal(worker.terminated, 1); assert.equal(worker.listeners.size, 0);
  await backend.unload(); assert.equal(worker.terminated, 1);
  await assert.rejects(backend.openStream(), { name: 'AbortError' });
});
test('abort before init and response-before-continuation race cannot revive backend', async () => {
  for (const mode of ['before', 'race']) {
    const worker = new Worker(); const backend = new SherpaSpeechToTextBackend(worker, whisper);
    if (mode === 'before') backend.abortInitialization();
    const init = backend.initialize({ wasm: new Uint8Array([1]), tokens: new Uint8Array([1]), encoder: new Uint8Array([1]) });
    if (mode === 'race') { worker.reply(); backend.abortInitialization(); }
    await assert.rejects(init, { name: 'AbortError' }); assert.equal(worker.terminated, 1);
  }
});
test('loader abort after readiness does not interrupt active native work', async () => {
  const worker = new Worker(); const backend = new SherpaSpeechToTextBackend(worker, whisper);
  const init = backend.initialize({ wasm: new Uint8Array([1]), tokens: new Uint8Array([1]), encoder: new Uint8Array([1]) }); worker.reply(); await init;
  const decode = backend.decode(new Float32Array(1)); backend.abortInitialization(); assert.equal(worker.terminated, 0);
  worker.reply({ text: 'hello' }); assert.deepEqual(await decode, { text: 'hello' });
  const unload = backend.unload(); worker.reply(); await unload;
});
test('bundled scored vocabulary matches the exact registry token IDs and pinned upstream checksum', () => {
  assert.equal(createHash('sha256').update(ZIPFORMER_TOKENS).digest('hex'), '49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb');
  const vocabulary = zipformerVocabulary(ZIPFORMER_TOKENS);
  assert.equal(createHash('sha256').update(vocabulary).digest('hex'), '28c02989b3cd8c2ffa974b1e33f97ec6cded170bda622ca627b7330b41c6c827');
  assert.throws(() => zipformerVocabulary(ZIPFORMER_TOKENS.replace('▁THE 4', '▁THE 5')), /does not match/);
});
test('hotword validation normalizes English and rejects unknown characters and native control syntax', () => {
  assert.deepEqual(normalizeZipformerHotwords(['  hello world ', 'HELLO WORLD', "o'reilly"]), ['HELLO WORLD', "O'REILLY"]);
  for (const hotwords of [[''], ['  '], ['hello:100'], ['a\nb'], ['über'], ['123'], ['foo-bar'], [null], 'hello']) assert.throws(() => validateRecognitionOptions(zipformer, { hotwords }));
  validateRecognitionOptions(zipformer, { hotwords: [] });
});
test('hotwords configure actual beam search, checked vocabulary and native buffer; omission resets', () => {
  const f = fixture(zipformer); const hotwords = ['  Open ai', "o'reilly"];
  f.recognizer.configure({ hotwords }); hotwords[0] = 'changed';
  const config = f.calls.find(x => x[0] === 'online-config')[1];
  assert.equal(config.decodingMethod, 'modified_beam_search');
  assert.equal(config.modelConfig.modelingUnit, 'bpe');
  assert.equal(config.modelConfig.bpeVocab, '/zipformer-bpe.vocab');
  assert.equal(config.hotwordsBuf, "OPEN AI\nO'REILLY");
  assert.equal(config.hotwordsBufSize, new TextEncoder().encode(config.hotwordsBuf).length);
  assert.equal(f.calls.filter(x => x[0] === 'recognizer-free').length, 1);
  f.recognizer.configure({ hotwords: ['OPEN AI', "O'REILLY"] });
  assert.equal(f.calls.filter(x => x[0] === 'online-config').length, 1);
  f.recognizer.configure({});
  assert.equal(f.calls.filter(x => x[0] === 'online-config').at(-1)[1].decodingMethod, 'greedy_search');
});
test('mismatching token asset rejects hotwords without destroying the usable recognizer', () => {
  const f = fixture(zipformer, ZIPFORMER_TOKENS.replace('▁THE 4', 'WRONG 4'));
  assert.throws(() => f.recognizer.configure({ hotwords: ['hello'] }), /does not match/);
  assert.equal(f.calls.filter(x => x[0] === 'recognizer-free').length, 0);
  f.recognizer.openStream(); assert.equal(f.recognizer.pushStream(new Float32Array(1)).text, 'hello');
});
test('RPC configure snapshots and forwards hotwords instead of dropping them', async () => {
  const worker = new Worker(); const backend = new SherpaSpeechToTextBackend(worker, zipformer);
  const hotwords = ['hello']; const configured = backend.configure({ hotwords }); hotwords[0] = 'changed';
  assert.deepEqual(worker.requests[0].options.hotwords, ['hello']); worker.reply(); await configured;
});
test('real ASR JS wrapper packs hotword pointer and byte count at C ABI offsets', async () => {
  const { createOnlineRecognizer } = await load('../../src/wasm/sherpa-onnx-asr.ts');
  const heap = new Uint8Array(65536); const view = new DataView(heap.buffer); let cursor = 16; let captured;
  const readString = ptr => new TextDecoder().decode(heap.subarray(ptr, heap.indexOf(0, ptr)));
  const module = {
    _malloc: size => { const ptr = cursor; cursor += (size + 3) & ~3; return ptr; }, _free() {},
    lengthBytesUTF8: text => new TextEncoder().encode(text).length,
    stringToUTF8: (text, ptr) => { const bytes = new TextEncoder().encode(text); heap.set(bytes, ptr); heap[ptr + bytes.length] = 0; },
    setValue: (ptr, value, type) => type === 'float' ? view.setFloat32(ptr, value, true) : view.setInt32(ptr, value, true),
    _CopyHeap: (source, size, destination) => heap.copyWithin(destination, source, source + size),
    _SherpaOnnxCreateOnlineRecognizer: ptr => {
      // C ABI: feat=8, model=68; hotwords follows decode/endpoints,
      // CTC decoder, rule FST/FAR pointers and blank penalty.
      const hotwordsPtr = view.getInt32(ptr + 128, true);
      const length = view.getInt32(ptr + 132, true);
      captured = { text: new TextDecoder().decode(heap.subarray(hotwordsPtr, hotwordsPtr + length)), length,
        nul: heap[hotwordsPtr + length], unit: readString(view.getInt32(ptr + 52, true)), vocab: readString(view.getInt32(ptr + 56, true)) };
      return 1;
    },
  };
  createOnlineRecognizer(module, recognizerConfig(zipformer, { hotwords: ["o'reilly", 'hello world'] }));
  assert.deepEqual(captured, { text: "O'REILLY\nHELLO WORLD", length: 20, nul: 0, unit: 'bpe', vocab: '/zipformer-bpe.vocab' });
});
test('minified worker retains bundled vocabulary provenance and full Apache notice', async () => {
  const result = await build({ entryPoints: [new URL('../../src/stt-next/worker.ts', import.meta.url).pathname], bundle: true, write: false, minify: true, platform: 'browser', format: 'esm' });
  const output = result.outputFiles.map(file => file.text).join('\n');
  assert.match(output, /62dd423df1d51da5ea06f1c3a046fc04f01b4f39/);
  assert.match(output, /Copyright 2024 Wei Kang/);
  assert.match(output, /END OF TERMS AND CONDITIONS/);
});
test('offline exact digital silence skips native inference, including timestamps; near-zero does not', () => {
  for (const model of [whisper, 'UsefulSensors/moonshine-tiny']) {
    const f = fixture(model); f.result({ text: '[ Silence ]' });
    if (model === whisper) f.recognizer.configure({ timestamps: 'segment' });
    f.calls.length = 0;
    const samples = new Float32Array(16000); samples[3] = -0;
    assert.deepEqual(f.recognizer.decode(samples), { text: '' });
    assert.equal(f.calls.length, 0);
    assert.throws(() => f.recognizer.decode(new Float32Array(0)), /nonempty/);
    assert.throws(() => f.recognizer.decode(new Float32Array(400001)), /25 seconds/);
    assert.throws(() => f.recognizer.decode(new Float32Array([NaN])), /finite/);
    f.recognizer.configure({});
    samples[10] = 1e-40;
    assert.deepEqual(f.recognizer.decode(samples), { text: '[ Silence ]' });
    assert.ok(f.calls.some(call => call[0] === 'accept'));
  }
});
test('online zeros reach native inference and finish still supplies internal tail padding', () => {
  const f = fixture(zipformer); f.recognizer.openStream();
  assert.deepEqual(f.recognizer.pushStream(new Float32Array(16000)), { text: 'hello', isEndpoint: false });
  f.recognizer.pushStream(new Float32Array(50), true);
  assert.deepEqual(f.calls.filter(call => call[0] === 'accept'), [['accept', 16000, 16000], ['accept', 16000, 50], ['accept', 16000, 16000]]);
  assert.equal(f.calls.filter(call => call[0] === 'finish').length, 1);
});
