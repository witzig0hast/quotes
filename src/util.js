// Kleine, überall genutzte Helfer (Backend)
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const bad = (msg) => new HttpError(400, msg);
export const notFound = (msg = 'Nicht gefunden.') => new HttpError(404, msg);
export const forbidden = (msg) => new HttpError(403, msg);

/** Trimmt, normalisiert Zeilenumbrüche und schneidet auf max+1 Zeichen (damit "zu lang" erkennbar bleibt). */
export const clean = (v, max) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '').slice(0, max + 1);
export const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');
export const placeholders = (arr) => arr.map(() => '?').join(',');
export const groupBy = (rows, key, val) => {
  const m = new Map();
  for (const r of rows) (m.get(r[key]) ?? m.set(r[key], []).get(r[key])).push(val(r));
  return m;
};
/** Positive Ganzzahl aus Route-Parameter, sonst 404. */
export const intParam = (v) => {
  const id = Number(v);
  if (!Number.isSafeInteger(id) || id < 1) throw notFound();
  return id;
};
/** Fängt Fehler async/sync ab und reicht sie an Express weiter. */
export const handler = (fn) => (req, res, next) => {
  try { const r = fn(req, res, next); if (r?.catch) r.catch(next); } catch (e) { next(e); }
};

/** Für Duplikat-Erkennung und tolerante Suche: klein, ohne Akzente/Umlaut-Punkte, ß->ss, nur Buchstaben/Ziffern. */
export const normText = (s) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/ß/g, 'ss').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Levenshtein-Distanz (für "Meintest du …?"), mit Abbruch ab max. */
export function editDistance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Für HTML-E-Mails: Nutzerinhalte immer escapen. */
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
