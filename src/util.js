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
