// Shared helpers for the end-to-end tests. They load the extension from the repo root into a
// real Chromium/Chrome (set CHROME=/path/to/browser if it is not on your PATH).
import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      return execSync(`command -v ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      /* try next */
    }
  }
  throw new Error('No Chrome/Chromium found. Set CHROME=/path/to/browser');
}

export async function launch({ width = 1300, height = 800 } = {}) {
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: 'new',
    args: ['--no-sandbox', `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
    enableExtensions: true,
    defaultViewport: { width, height },
  });
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 20000 });
  const extId = new URL(swTarget.url()).host;
  const sw = await swTarget.worker();
  await sleep(800);
  for (const p of await browser.pages()) if (p.url().includes('stash.html')) await p.close();
  const errors = [];
  const watch = (page, label) => {
    page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/ERR_|Failed to load resource|favicon/i.test(m.text())) errors.push(`${label} console: ${m.text()}`);
    });
  };
  const stashPage = async (hash = '') => {
    const page = await browser.newPage();
    watch(page, 'stash');
    page.on('dialog', (d) => d.accept());
    await page.goto(`chrome-extension://${extId}/stash.html${hash}`);
    await sleep(500);
    return page;
  };
  return { browser, sw, extId, errors, stashPage, watch, close: () => browser.close() };
}

// Static server for test pages / images (serves files from tests/site).
export function serve(port) {
  const dir = path.join(ROOT, 'tests', 'site');
  const types = { '.png': 'image/png', '.html': 'text/html' };
  const srv = http.createServer((req, res) => {
    const f = path.join(dir, req.url.split('?')[0].replace(/^\//, ''));
    if (f.startsWith(dir) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.setHeader('content-type', types[path.extname(f)] || 'text/plain');
      res.setHeader('access-control-allow-origin', '*');
      res.end(fs.readFileSync(f));
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  return new Promise((resolve) => srv.listen(port, () => resolve(srv)));
}

// Tiny assertion collector so one failure does not hide the others.
export function checker(name) {
  const results = [];
  const check = (label, ok, detail = '') => {
    results.push({ label, ok: !!ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  -> ${detail}` : ''}`);
  };
  check.failed = () => results.filter((r) => !r.ok).length;
  check.suite = name;
  return check;
}

// Writes a few coloured PNGs used as fake thumbnails (no dependencies: tiny valid PNG encoder).
import zlib from 'node:zlib';
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function solidPng(w, h, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export function writeSite() {
  const dir = path.join(ROOT, 'tests', 'site');
  fs.mkdirSync(dir, { recursive: true });
  [[200, 60, 60], [60, 120, 200], [60, 170, 90]].forEach((c, i) => fs.writeFileSync(path.join(dir, `img${i}.png`), solidPng(1280, 720, c)));
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(dir, `o${i}.html`), `<!doctype html><html><head><title>OG page ${i}</title><meta name="description" content="Description for og page ${i}"><meta property="og:image" content="/img${i}.png"></head><body style="background:#223;color:#fff;font:40px sans-serif">OG page ${i}</body></html>`);
  }
  fs.writeFileSync(path.join(dir, 'plain.html'), '<!doctype html><title>Plain page</title><body>plain, no preview image</body>');
  fs.writeFileSync(path.join(dir, 'ok.html'), '<!doctype html><title>OK page</title><body>fine</body>');
}
