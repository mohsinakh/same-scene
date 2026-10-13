// Focused player checks: synthetic movie only; no devices or live signaling.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium, firefox } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
await mkdir('test-results', { recursive: true });
for (const engine of ['chromium', 'firefox']) {
  const browser = await (engine === 'chromium' ? chromium : firefox).launch({ headless: true,
    executablePath: engine === 'chromium' ? process.env.CHROMIUM_PATH : undefined });
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: engine === 'chromium',
    ...(engine === 'chromium' ? { isMobile: true } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.orientationCalls = [];
    Object.defineProperty(screen.orientation, 'lock', { configurable: true, value: async value => {
      window.orientationCalls.push(value);
      if (window.rejectOrientation) throw new DOMException('Unsupported', 'NotSupportedError');
    } });
    Object.defineProperty(screen.orientation, 'unlock', { configurable: true, value: () => window.orientationCalls.push('unlock') });
  });
  try {
    await page.goto(process.env.APP_URL || 'http://127.0.0.1:4173/');
    await page.evaluate(async () => {
      document.getElementById('lobby').hidden = true;
      document.getElementById('room').hidden = false;
      document.getElementById('room').dataset.role = 'guest';
      document.getElementById('stage-empty').hidden = true;
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#181725'; ctx.fillRect(0, 0, 1280, 720);
      ctx.fillStyle = '#b5a7ff'; ctx.font = '40px sans-serif'; ctx.fillText('Fullscreen movie test', 410, 360);
      const movie = document.getElementById('remote-movie'); movie.hidden = false; movie.muted = true;
      movie.srcObject = canvas.captureStream(5); await movie.play();
    });
    await page.locator('#fullscreen').click();
    await page.waitForFunction(() => document.fullscreenElement?.id === 'movie-player' && document.getElementById('fullscreen').getAttribute('aria-label') === 'Exit fullscreen');
    assert.equal(await page.locator('#fullscreen').getAttribute('aria-label'), 'Exit fullscreen');
    assert.equal(await page.locator('#fullscreen-voice-volume').isVisible(), true);
    const dimensions = await page.locator('#stage').evaluate(e => ({ w: e.clientWidth, h: e.clientHeight, iw: innerWidth, ih: innerHeight }));
    assert.equal(dimensions.w, dimensions.iw); assert.equal(dimensions.h, dimensions.ih);
    if (engine === 'chromium') assert.deepEqual(await page.evaluate(() => window.orientationCalls), ['landscape']);
    await page.waitForFunction(() => document.getElementById('movie-player').classList.contains('controls-idle'), { timeout: 7000 });
    await page.locator('#fullscreen').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#fullscreen').isVisible(), false);
    assert.equal(await page.locator('.stage-topline').isVisible(), false);
    assert.equal(await page.locator('#remote-movie').evaluate(v => v.paused), false);
    await page.screenshot({ path: `test-results/fullscreen-${engine}-idle.png` });
    await page.locator('#stage').dispatchEvent('pointerdown', { pointerType: 'touch' });
    await page.locator('#fullscreen').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#fullscreen').isVisible(), true);
    await page.locator('#fullscreen-voice-volume').fill('45');
    await page.locator('#fullscreen-voice-volume').dispatchEvent('input');
    assert.equal(await page.locator('#voice-volume').inputValue(), '45');
    assert.equal(await page.locator('#remote-voice').evaluate(v => v.volume), 0.45);
    await page.screenshot({ path: `test-results/fullscreen-${engine}-controls.png` });
    await page.locator('#movie-player').focus();
    await page.keyboard.press('m');
    assert.equal(await page.locator('#remote-movie').evaluate(v => v.volume), 0);
    await page.keyboard.press('m');
    await page.keyboard.press('f');
    await page.waitForFunction(() => !document.fullscreenElement && document.getElementById('fullscreen').getAttribute('aria-label') === 'Enter fullscreen');
    assert.equal(await page.locator('#fullscreen').getAttribute('aria-label'), 'Enter fullscreen');
    assert.equal(await page.locator('#movie-player').evaluate(e => e.classList.contains('controls-idle')), false);
    if (engine === 'chromium') {
      assert.ok((await page.evaluate(() => window.orientationCalls)).includes('unlock'));
      await page.evaluate(() => { window.rejectOrientation = true; });
      await page.locator('#fullscreen').click();
      await page.waitForFunction(() => document.fullscreenElement?.id === 'movie-player' && document.getElementById('fullscreen').getAttribute('aria-label') === 'Exit fullscreen');
      await page.waitForFunction(() => !document.getElementById('fullscreen-tip').hidden);
      await page.locator('#fullscreen').click();
      await page.waitForFunction(() => !document.fullscreenElement && document.getElementById('fullscreen').getAttribute('aria-label') === 'Enter fullscreen');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log(`${engine}: fullscreen fills viewport; idle hides controls while movie plays; tap restores controls; sound and keyboard shortcuts work; exit restores UI.`);
  } finally { await browser.close(); }
}
