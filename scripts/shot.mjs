// Headless (or headful) screenshot harness for the WebGPU views.
//
// Drives the system Google Chrome via puppeteer-core (no Chromium download) with
// WebGPU enabled, loads each view from a running dev/preview server, waits for
// the scene to render, and writes a PNG into screenshots/.
//
// Usage:
//   npm run dev            # in one terminal (or: npm run preview after a build)
//   node scripts/shot.mjs  # in another
//
// Env:
//   BASE_URL=http://localhost:5173   server to hit
//   VIEWS=city,interior              comma-separated views to capture
//   HEADLESS=0                       run headful (visible window) — most reliable for WebGPU
//   WAIT_MS=4000                     settle time after load before the shot

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const VIEWS = (process.env.VIEWS || 'city,interior').split(',').map((v) => v.trim());
const HEADLESS = process.env.HEADLESS === '0' ? false : 'new';
const WAIT_MS = Number(process.env.WAIT_MS || 4000);
const OUT_DIR = resolve(root, 'screenshots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADLESS,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-angle=metal',
      '--ignore-gpu-blocklist',
      '--window-size=1600,1000',
    ],
  });

  try {
    for (const view of VIEWS) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });

      const errors = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      page.on('pageerror', (e) => errors.push(String(e)));

      const url = `${BASE_URL}/?view=${view}`;
      process.stdout.write(`\n● ${view}  →  ${url}\n`);
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

      // bail early if the app reported no WebGPU
      const noGpu = await page.evaluate(() =>
        document.body.innerText.includes('WebGPU is not available')
      );
      if (noGpu) {
        console.error('  ✗ WebGPU not available in this Chrome session.');
        await page.close();
        continue;
      }

      await page.waitForSelector('canvas', { timeout: 15000 });
      await sleep(WAIT_MS); // env bake + a few frames (+ city autorotate / damping)

      const file = resolve(OUT_DIR, `${view}.png`);
      await page.screenshot({ path: file });
      console.log(`  ✓ saved ${file}`);
      if (errors.length) {
        console.log(`  ⚠ ${errors.length} console error(s):`);
        for (const e of errors.slice(0, 8)) console.log(`     ${e}`);
      }

      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
