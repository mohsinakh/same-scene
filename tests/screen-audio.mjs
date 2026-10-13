// Optional integration check: install Playwright or pass PLAYWRIGHT_PATH.
// Uses synthetic mic/camera and a generated movie; never captures real devices.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium, firefox } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const engine = process.env.TEST_FIREFOX === '1' ? firefox : chromium;
const browser = await engine.launch({ headless: true, executablePath: process.env.TEST_FIREFOX === '1' ? undefined : process.env.CHROMIUM_PATH || undefined,
  firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true, 'media.autoplay.default': 0 },
  args: process.env.TEST_FIREFOX === '1' ? [] : ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const guestBrowser = process.env.TEST_FIREFOX === '1' ? await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] }) : browser;
const errors = [];
const base = process.env.APP_URL || 'http://127.0.0.1:4173/';
await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
try {
  const permissions = process.env.TEST_FIREFOX === '1' ? [] : ['camera', 'microphone'];
  const hostContext = await browser.newContext({ permissions, viewport: { width: 1440, height: 1000 } });
  const guestContext = await guestBrowser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 900 } });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  for (const page of [host, guest]) page.on('pageerror', e => errors.push(e.message));
  await host.goto(base);
  await host.screenshot({ path: fileURLToPath(new URL('../test-results/lobby.png', import.meta.url)), fullPage: true });
  await host.locator('#create-room').click();
  await host.waitForFunction(() => !document.getElementById('toggle-mic').disabled, { timeout: 45000 });
  console.log('Host signaling ready; permissions start off.');
  assert.equal(await host.locator('#toggle-mic').getAttribute('aria-pressed'), 'false');
  const invite = await host.evaluate(() => { const u = new URL(location.href); const p = new URLSearchParams(u.hash.slice(1)); p.set('as', 'guest'); u.hash = p.toString(); return u.href; });
  await guest.goto(invite);
  await guest.locator('#accept-invite').click();
  await guest.waitForFunction(() => !document.getElementById('toggle-mic').disabled, { timeout: 45000 });
  await host.waitForFunction(() => document.getElementById('connection-status').classList.contains('live'), { timeout: 45000 });
  await guest.waitForFunction(() => document.getElementById('connection-status').classList.contains('live'), { timeout: 45000 });
  assert.equal(await guest.locator('#host-tools').isVisible(), false);
  assert.equal(await guest.locator('#screen-audio-panel').isVisible(), false);
  assert.equal(await guest.locator('#copy-invite').isVisible(), false);
  assert.equal(await host.locator('#role-label').textContent(), 'HOST ROOM');
  assert.equal(await guest.locator('#role-label').textContent(), 'GUEST ROOM');
  assert.equal(await guest.locator('#voice-input').isVisible(), true);
  console.log('Two independent peers connected; role-specific controls verified.');
  const measureRms = async () => guest.evaluate(async () => {
    const context = new AudioContext(); await context.resume();
    const analyzer = context.createAnalyser(); analyzer.fftSize = 2048;
    context.createMediaStreamSource(document.getElementById('remote-movie').srcObject).connect(analyzer);
    const data = new Float32Array(analyzer.fftSize);
    await new Promise(r => setTimeout(r, 500));
    let total = 0;
    for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 50)); analyzer.getFloatTimeDomainData(data); total += Math.sqrt(data.reduce((sum, v) => sum + v * v, 0) / data.length); }
    await context.close(); return total / 20;
  });
  await host.evaluate(() => {
    const enumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => (await enumerate()).filter(d => !/blackhole|same scene movie/i.test(d.label));
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#222'; ctx.fillRect(0, 0, 640, 360);
      const ac = new AudioContext(); const dest = ac.createMediaStreamDestination();
      const osc = ac.createOscillator(); const gain = ac.createGain(); gain.gain.value = 0.1;
      osc.connect(gain).connect(dest); osc.start(); await ac.resume();
      const picture = canvas.captureStream(5);
      const timer = setInterval(() => { ctx.fillStyle = '#222'; ctx.fillRect(0, 0, 640, 360); }, 100);
      picture.getVideoTracks()[0].addEventListener('ended', () => { clearInterval(timer); osc.stop(); void ac.close(); });
      return new MediaStream([...picture.getTracks(), ...dest.stream.getTracks()]);
    };
    document.getElementById('movie-audio-input').value = '';
  });
  await host.locator('#refresh-call-devices').click();
  await host.waitForFunction(() => !document.getElementById('refresh-call-devices').disabled);
  await host.locator('#share-screen').click();
  await guest.waitForFunction(() => document.getElementById('movie-label').textContent === 'Shared movie window' && document.getElementById('remote-movie').srcObject?.getAudioTracks().length && document.getElementById('remote-movie').videoWidth > 0, { timeout: 45000 });
  await host.waitForFunction(() => document.getElementById('movie-signal').value > 0);
  let screenRms = 0;
  for (let attempt = 0; attempt < 5 && screenRms <= 0.05; attempt++) screenRms = await measureRms();
  console.log('Decoded screen RMS:', screenRms, 'Host meter:', await host.locator('#movie-signal').evaluate(m => m.value));
  assert.ok(screenRms > 0.05, 'Screen audio should pass through the outgoing gain graph');
  await host.locator('#stop-sharing').click();
  await host.waitForFunction(() => document.getElementById('stop-sharing').hidden);
  assert.equal(await host.locator('#movie-signal').evaluate(m => m.value), 0);
  console.log('Synthetic screen soundtrack is amplified and delivered; stopping releases its capture and meter.');
  assert.deepEqual(errors, []);
} finally { await browser.close(); if (guestBrowser !== browser) await guestBrowser.close(); }
