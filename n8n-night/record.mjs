// Renders dashboard.html?capture to a silent mp4.
// Usage: node record.mjs [out.mp4]   (needs Chrome and ffmpeg on PATH)
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || join(ROOT, 'n8n-night-demo.mp4');
const URL_ = pathToFileURL(join(ROOT, 'dashboard.html')).href + '?capture';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const W = 1080, H = 1350, FPS = 30, T = 20, PORT = 9378;

const work = join(tmpdir(), 'n8n-night-rec');
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'frames'), { recursive: true });

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(work, 'profile')}`,
  `--window-size=${W},${H}`, '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === 'page'); } catch {}
}
if (!target) { chrome.kill(); throw new Error('Chrome did not start'); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => {
  pending.set(++id, m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result));
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

try {
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 50 && !(await evaluate('typeof window.__renderAt === "function"')); i++) await sleep(200);
  await evaluate('document.fonts.ready.then(() => true)');

  const total = T * FPS;
  for (let f = 0; f < total; f++) {
    await evaluate(`window.__renderAt(${f / FPS})`);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(work, 'frames', `f${String(f).padStart(4, '0')}.png`), Buffer.from(data, 'base64'));
    if (f % 90 === 0) console.log(`frame ${f}/${total}`);
  }
} finally {
  ws.close(); chrome.kill();
}

const ff = spawnSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', join(work, 'frames', 'f%04d.png'),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'slow', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
rmSync(work, { recursive: true, force: true });
process.exit(ff.status ?? 1);
