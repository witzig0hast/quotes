import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

const start = (opts = {}) => {
  const server = createApp({ db: openDb(':memory:'), secureCookies: false, ...opts }).listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
};
const noStore = (res) => {
  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.equal(res.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(res.headers.get('cloudflare-cdn-cache-control'), 'no-store');
  assert.equal(res.headers.get('x-accel-expires'), '0');
};
const assetUrls = (html) => [...html.matchAll(/(?:href|src)="(\/assets\/([0-9a-f]{12})\/(?:app\.js|style\.css))"/g)];

test('HTML wird nie gecacht und verweist auf versionierte Assets', async () => {
  const { server, base } = start();
  for (const path of ['/', '/index.html', '/s/irgendeintoken']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    noStore(res);
    const html = await res.text();
    const urls = assetUrls(html);
    assert.equal(urls.length, 2, path);
    const version = urls[0][2];
    assert.ok(html.includes(`<meta name="app-version" content="${version}">`));
    assert.equal(res.headers.get('x-app-version'), version);
    assert.ok(!html.includes('href="/style.css"') && !html.includes('src="/app.js"'));
  }
  assert.match((await fetch(`${base}/s/x`)).headers.get('x-robots-tag'), /noindex/);
  server.close();
});

test('Versionierte Assets: immutable; veraltete Version: aktueller Inhalt, aber nicht cachebar', async () => {
  const { server, base } = start();
  const html = await (await fetch(base + '/')).text();
  for (const [, url, version] of assetUrls(html)) {
    const res = await fetch(base + url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const file = url.endsWith('.js') ? 'app.js' : 'style.css';
    assert.match(res.headers.get('content-type'), file === 'app.js' ? /javascript/ : /text\/css/);
    assert.equal(await res.text(), readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'));
    const stale = await fetch(base + url.replace(version, 'aaaaaaaaaaaa'));
    assert.equal(stale.status, 200);
    noStore(stale);
  }
  assert.equal((await fetch(`${base}/assets/abc/index.html`)).status, 404);
  assert.equal((await fetch(`${base}/assets/abc/..%2Fsrc%2Fapp.js`)).status, 404);
  assert.equal((await fetch(`${base}/assets/abc/hasOwnProperty`)).status, 404);
  server.close();
});

test('Unversionierte Dateien und API werden nie gecacht; API meldet die Version', async () => {
  const { server, base } = start();
  for (const path of ['/app.js', '/style.css']) noStore(await fetch(base + path));
  const version = assetUrls(await (await fetch(base + '/')).text())[0][2];
  const api = await fetch(base + '/api/config');
  noStore(api);
  assert.equal(api.headers.get('x-app-version'), version);
  server.close();
});

test('Neue Dateiinhalte -> neue Version und neue URLs (alte können nicht mehr ausgeliefert werden)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quotes-assets-'));
  cpSync(new URL('../public', import.meta.url), dir, { recursive: true });
  // Entwicklung: jede Anfrage sieht den aktuellen Stand
  const dev = start({ publicDir: dir, cacheAssets: false });
  const v1 = (await fetch(dev.base + '/api/config')).headers.get('x-app-version');
  appendFileSync(join(dir, 'app.js'), '\n// geändert\n');
  const html = await (await fetch(dev.base + '/')).text();
  const v2 = assetUrls(html)[0][2];
  assert.notEqual(v1, v2);
  assert.ok((await (await fetch(`${dev.base}/assets/${v2}/app.js`)).text()).endsWith('// geändert\n'));
  dev.server.close();
  // Produktion: Version fest ab Start (Deploy = Neustart)
  const prod = start({ publicDir: dir, cacheAssets: true });
  const p1 = (await fetch(prod.base + '/api/config')).headers.get('x-app-version');
  appendFileSync(join(dir, 'style.css'), '\n/* x */\n');
  assert.equal((await fetch(prod.base + '/api/config')).headers.get('x-app-version'), p1);
  prod.server.close();
  const restarted = start({ publicDir: dir, cacheAssets: true });
  assert.notEqual((await fetch(restarted.base + '/api/config')).headers.get('x-app-version'), p1);
  restarted.server.close();
});
