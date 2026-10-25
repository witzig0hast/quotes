// Auslieferung des Frontends mit Cache-Busting:
// - HTML wird NIE gecacht (Browser, nginx, Cloudflare) und verweist auf versionierte Asset-URLs.
// - CSS/JS liegen unter /assets/<inhalts-hash>/…: ändert sich der Inhalt, ändert sich die URL.
//   Diese URLs dürfen deshalb "für immer" gecacht werden – eine alte Version kann nie ausgeliefert werden.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
// Nicht versioniert: der Service Worker muss unter fester URL im Wurzelpfad liegen
const UNVERSIONED = new Set(['sw.js']);

// Gilt für HTML, API und alles Unversionierte: nirgends zwischenspeichern.
export const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'CDN-Cache-Control': 'no-store', // Cloudflare und andere CDNs
  'Cloudflare-CDN-Cache-Control': 'no-store',
  'X-Accel-Expires': '0', // nginx proxy_cache
  Pragma: 'no-cache',
  Expires: '0',
};
const IMMUTABLE = { 'Cache-Control': 'public, max-age=31536000, immutable' };

function build(dir) {
  const files = {};
  const hash = createHash('sha256');
  // Alle JS/CSS-Dateien im Wurzelordner (Module importieren sich relativ: ./core.js -> /assets/<v>/core.js)
  const names = readdirSync(dir).filter((n) => /^[\w.-]+\.(js|css)$/.test(n) && !UNVERSIONED.has(n)).sort();
  for (const name of names) {
    const type = TYPES[name.slice(name.lastIndexOf('.'))];
    const body = readFileSync(join(dir, name));
    files[name] = { body, type };
    hash.update(name).update(body);
  }
  const template = readFileSync(join(dir, 'index.html'), 'utf8');
  hash.update(template);
  const version = hash.digest('hex').slice(0, 12);
  const html = template
    .replace('href="/style.css"', `href="/assets/${version}/style.css"`)
    .replace('src="/app.js"', `src="/assets/${version}/app.js"`)
    .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta name="app-version" content="${version}">`);
  if (!html.includes(`/assets/${version}/app.js`) || !html.includes(`/assets/${version}/style.css`)) {
    throw new Error('index.html muss <link href="/style.css"> und <script src="/app.js"> enthalten.');
  }
  return { version, files, html };
}

/**
 * In Produktion einmal beim Start berechnet; in der Entwicklung bei jeder Anfrage neu,
 * damit Änderungen an public/ sofort sichtbar sind.
 */
export function createAssets(dir, { cache = process.env.NODE_ENV === 'production' } = {}) {
  let built = null;
  const get = () => (cache ? (built ??= build(dir)) : build(dir));
  get(); // Fehler früh melden

  return {
    version: () => get().version,

    sendHtml(res, extraHeaders = {}) {
      const { html, version } = get();
      res.set({ ...NO_STORE, ...extraHeaders, 'Content-Type': 'text/html; charset=utf-8', 'X-App-Version': version });
      res.send(html);
    },

    /** GET /assets/:version/:file */
    sendAsset(req, res, next) {
      const { files, version } = get();
      const file = files[req.params.file];
      if (!Object.hasOwn(files, req.params.file) || !file) return next();
      // Passende Version: für immer cachebar. Veraltete Version (alte HTML-Seite irgendwo im Umlauf):
      // aktuellen Inhalt liefern, aber nicht cachen – sonst landet neuer Inhalt unter alter URL im Cache.
      res.set({ ...(req.params.version === version ? IMMUTABLE : NO_STORE), 'Content-Type': file.type, 'X-App-Version': version });
      res.send(file.body);
    },
  };
}
