// Run a development fixture exposed by example/src/NextSmoke.tsx over Hermes CDP.
// Usage: node scripts/run-next-smoke.mjs gemma ios|android
const [action = 'gemma', platform = 'ios'] = process.argv.slice(2);
if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(action) || !['ios', 'android'].includes(platform)) throw Error('Usage: run-next-smoke.mjs fixture ios|android');
let target;
for (let attempt = 0; attempt < 30 && !target; attempt++) {
  const targets = await (await fetch('http://127.0.0.1:8081/json/list')).json();
  target = targets.find(t => t.description === 'wfloat.example' && (platform === 'ios' ? t.deviceName.includes('iPhone') : t.deviceName.includes('sdk_gphone')));
  if (!target) await new Promise(resolve => setTimeout(resolve, 1000));
}
if (!target) throw Error(`No ${platform} example Hermes target; launch the app with Metro on port 8081.`);
const ws = new WebSocket(target.webSocketDebuggerUrl.replace('0.0.0.0', '127.0.0.1'));
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let serial = 0;
const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP evaluation timed out')); }, 30000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
}
try {
  const start = await evaluate(`globalThis.__gemmaSmokeResult={state:'running'};globalThis.__wfloatSmoke.${action}().then(value=>globalThis.__gemmaSmokeResult={state:'PASS',value},error=>globalThis.__gemmaSmokeResult={state:'FAIL',message:String(error),stack:error.stack});'started'`);
  if (start.error || start.result?.exceptionDetails) throw Error(JSON.stringify(start));
  const timeoutMinutes = Number(process.env.WFLOAT_SMOKE_TIMEOUT_MINUTES ?? 15);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0 || timeoutMinutes > 60) throw Error('Invalid smoke timeout');
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;
  let done = false;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const result = await evaluate('globalThis.__gemmaSmokeResult');
    const value = result.result?.result?.value;
    if (value?.state === 'running') continue;
    console.log(JSON.stringify(value ?? result, null, 2));
    process.exitCode = value?.state === 'PASS' ? 0 : 1;
    done = true; break;
  }
  if (!done) throw Error('Fixture timed out; it may still be running in the app.');
} finally { ws.close(); }
