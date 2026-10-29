// Bilder an Zitaten: Upload wird geprüft und IMMER neu kodiert (WebP, max. 1600 px, ohne Metadaten wie GPS).
// So landet nie die Originaldatei auf dem Server – manipulierte/polyglotte Dateien oder eingebettete Skripte fallen weg.
import express from 'express';
import rateLimit from 'express-rate-limit';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { bad, notFound, handler } from '../util.js';

const MAX_UPLOAD = 8 * 1024 * 1024;        // Rohdaten vom Browser
const MAX_SIDE = 1600;                     // gespeicherte Größe
const MAX_IMAGES_PER_USER = 500;
const ORPHAN_TTL = 24 * 60 * 60 * 1000;    // nicht verwendete Uploads nach 24 h löschen
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** Nur echte JPEG/PNG/WebP-Dateien (Signatur prüfen, nicht dem Content-Type glauben). */
export function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Neu kodieren: EXIF-Drehung anwenden, verkleinern, Metadaten verwerfen. */
export async function reencode(buf, { side = MAX_SIDE, format = 'webp' } = {}) {
  const img = sharp(buf, { limitInputPixels: 50_000_000, failOn: 'error', animated: false })
    .rotate()
    .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true });
  const out = format === 'jpeg' ? img.jpeg({ quality: 85, mozjpeg: true }) : img.webp({ quality: 82 });
  return out.toBuffer({ resolveWithObject: true });
}

export function registerImages(app, ctx) {
  const { db, requireAuth, readLimiter, ACCESS } = ctx;
  const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: (req) => `img:${req.user.id}`, message: { error: 'Zu viele Bilder in kurzer Zeit. Bitte später erneut versuchen.' } });

  const send = (res, row) => {
    res.set({
      'Content-Type': 'image/webp',
      'Cache-Control': 'private, max-age=86400', // IDs sind zufällig und unveränderlich
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'CDN-Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store', // nie in nginx/Cloudflare
    });
    res.end(row.data);
  };

  ctx.imageEnabled = true;
  /** Bild an ein Zitat hängen (null = entfernen, undefined = unverändert). Läuft in der Transaktion des Zitats. */
  ctx.attachImage = (quoteId, ownerId, imageId) => {
    if (imageId === undefined) return;
    db.prepare('DELETE FROM images WHERE quote_id = ? AND id IS NOT ?').run(quoteId, imageId);
    if (imageId === null) return;
    const r = db.prepare('UPDATE images SET quote_id = ? WHERE id = ? AND user_id = ? AND (quote_id IS NULL OR quote_id = ?)')
      .run(quoteId, imageId, ownerId, quoteId);
    if (!r.changes) throw bad('Das Bild wurde nicht gefunden. Bitte erneut hochladen.');
  };
  ctx.ownImage = (id, uid) => (ID_RE.test(String(id)) ? db.prepare('SELECT * FROM images WHERE id = ? AND user_id = ?').get(id, uid) : null);

  // Upload: Rohdaten (image/jpeg|png|webp), CSRF-Header wie bei JSON-Anfragen
  app.post('/api/images', requireAuth, uploadLimiter,
    express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_UPLOAD }),
    handler(async (req, res) => {
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || !buf.length) throw bad('Bitte ein Bild (JPEG, PNG oder WebP) senden.');
      if (!sniffImage(buf)) throw bad('Das ist kein gültiges JPEG-, PNG- oder WebP-Bild.');
      // Aufräumen: eigene, nie verwendete Uploads älter als 24 h
      db.prepare('DELETE FROM images WHERE user_id = ? AND quote_id IS NULL AND created_at < ?').run(req.user.id, Date.now() - ORPHAN_TTL);
      if (db.prepare('SELECT COUNT(*) AS n FROM images WHERE user_id = ?').get(req.user.id).n >= MAX_IMAGES_PER_USER) {
        throw bad(`Höchstens ${MAX_IMAGES_PER_USER} Bilder pro Konto.`);
      }
      let out;
      try { out = await reencode(buf); } catch { throw bad('Das Bild konnte nicht gelesen werden.'); }
      const id = randomBytes(16).toString('base64url');
      db.prepare('INSERT INTO images (id, user_id, data, width, height, bytes, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, req.user.id, out.data, out.info.width, out.info.height, out.data.length, Date.now());
      res.status(201).json({ id, url: `/api/images/${id}`, width: out.info.width, height: out.info.height });
    }));

  // Abrufen: nur wer das Zitat sehen darf (oder der Eigentümer eines noch nicht verwendeten Uploads)
  app.get('/api/images/:id', readLimiter, (req, res, next) => {
    const id = req.params.id;
    if (!req.user || !ID_RE.test(id)) return next(notFound());
    const row = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
    if (!row) return next(notFound());
    if (row.quote_id === null) return row.user_id === req.user.id ? send(res, row) : next(notFound());
    const ok = db.prepare(`SELECT 1 FROM quotes q WHERE q.id = @qid AND ${ACCESS}`).get({ qid: row.quote_id, me: req.user.id });
    return ok ? send(res, row) : next(notFound());
  });

  // Öffentlicher Freigabe-Link eines Zitats
  app.get('/api/public/quotes/:token/image', readLimiter, (req, res, next) => {
    const token = req.params.token;
    if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return next(notFound());
    const row = db.prepare('SELECT i.* FROM images i JOIN quotes q ON q.id = i.quote_id WHERE q.share_token = ?').get(token);
    return row ? send(res, row) : next(notFound());
  });

  app.delete('/api/images/:id', requireAuth, handler((req, res) => {
    const r = db.prepare('DELETE FROM images WHERE id = ? AND user_id = ? AND quote_id IS NULL').run(String(req.params.id), req.user.id);
    if (!r.changes) throw notFound();
    res.json({ ok: true });
  }));

}
