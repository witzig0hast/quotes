// Integrationen: API-Schlüssel (/api/v1, z. B. für Skripte, Home Assistant, Kurzbefehle) und Webhooks
// (signierte POST-Anfragen bei Ereignissen, auch im Slack-/Discord-Format).
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import https from 'node:https';
import http from 'node:http';
import rateLimit from 'express-rate-limit';
import { bad, clean, notFound, handler, intParam, escapeLike } from '../util.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const EVENTS = { 'quote.created': 'Neues eigenes Zitat', notification: 'Neue Benachrichtigung (Markierung, Kommentar, …)' };
const MAX_KEYS = 10, MAX_HOOKS = 10;

// ---------- SSRF-Schutz für Webhooks ----------
/** Private, lokale und Metadaten-Adressen (IPv4/IPv6) */
export function isPrivateIp(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7)); // IPv4-mapped
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6) || v6.startsWith('64:ff9b:') || v6.startsWith('2001:db8');
}

/** DNS-Auflösung beim Verbindungsaufbau prüfen (schützt auch vor DNS-Rebinding) */
export const safeLookup = (allowPrivate) => (hostname, options, cb) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: options.family || 4 }];
    if (!allowPrivate && list.some((a) => isPrivateIp(a.address))) return cb(Object.assign(new Error('Ziel-Adresse ist intern/privat und nicht erlaubt'), { code: 'EPRIVATE' }));
    if (options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
};

export function validateWebhookUrl(raw, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(raw); } catch { throw bad('Ungültige URL.'); }
  if (u.username || u.password) throw bad('Bitte keine Zugangsdaten in der URL.');
  if (!['https:', ...(allowPrivate ? ['http:'] : [])].includes(u.protocol)) throw bad('Webhook-URLs müssen https:// verwenden.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || (isIP(host) && isPrivateIp(host)))) {
    throw bad('Interne Adressen sind nicht erlaubt.');
  }
  return u;
}

/** POST mit Timeout, ohne Weiterleitungen, mit SSRF-sicherer Auflösung */
function postJson(url, body, headers, { allowPrivate }) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'POST', lookup: safeLookup(allowPrivate), timeout: 5000,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Quotes-Webhook/1.0', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, (res) => { res.resume(); res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: String(res.statusCode) })); });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
    req.on('error', (e) => resolve({ ok: false, status: e.code === 'EPRIVATE' ? 'blockiert (interne Adresse)' : e.message.slice(0, 80) }));
    req.end(body);
  });
}

export function registerIntegrations(app, ctx) {
  const { db, requireAuth, writeLimiter, ACCESS, BASE, shape, getOne, tx, validateQuote, insertQuote, confirmIdentity, onNotify, onQuoteCreated, PAGE_SIZE } = ctx;
  const allowPrivate = process.env.WEBHOOK_ALLOW_PRIVATE === '1';
  const sender = ctx.webhookSender ?? ((url, body, headers) => postJson(url, body, headers, { allowPrivate }));

  // ---------- API-Schlüssel verwalten (Sitzung) ----------
  app.get('/api/me/keys', requireAuth, (req, res) => {
    res.json({ keys: db.prepare('SELECT id, name, prefix, scope, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_keys WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id) });
  });
  app.post('/api/me/keys', requireAuth, writeLimiter, handler(async (req, res) => {
    await confirmIdentity(req);
    const name = clean(req.body?.name, 40) || 'API-Schlüssel';
    if (name.length > 40) throw bad('Name zu lang (max. 40 Zeichen).');
    const scope = req.body?.scope === 'write' ? 'write' : 'read';
    if (db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?').get(req.user.id).n >= MAX_KEYS) throw bad(`Höchstens ${MAX_KEYS} Schlüssel.`);
    const token = `qk_${randomBytes(32).toString('base64url')}`;
    const id = Number(db.prepare('INSERT INTO api_keys (user_id, name, token_hash, prefix, scope, created_at) VALUES (?,?,?,?,?,?)')
      .run(req.user.id, name, sha256(token), token.slice(0, 10), scope, Date.now()).lastInsertRowid);
    res.status(201).json({ id, name, scope, token }); // Klartext nur jetzt
  }));
  app.delete('/api/me/keys/:id', requireAuth, writeLimiter, handler((req, res) => {
    const r = db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(intParam(req.params.id), req.user.id);
    if (!r.changes) throw notFound();
    res.json({ ok: true });
  }));

  // ---------- Öffentliche API /api/v1 (nur per Bearer-Schlüssel, ohne Cookies) ----------
  const v1 = (scope) => (req, res, next) => {
    const m = /^Bearer (qk_[A-Za-z0-9_-]{43})$/.exec(req.get('authorization') ?? '');
    const key = m && db.prepare(`SELECT k.id, k.scope, u.id AS uid, u.username FROM api_keys k JOIN users u ON u.id = k.user_id
                                 WHERE k.token_hash = ? AND u.disabled = 0`).get(sha256(m[1]));
    if (!key) return res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'Gültiger API-Schlüssel nötig (Authorization: Bearer qk_…).' });
    if (scope === 'write' && key.scope !== 'write') return res.status(403).json({ error: 'Dieser Schlüssel darf nur lesen.' });
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), key.id);
    req.apiUser = { id: key.uid, username: key.username }; req.apiKeyId = key.id;
    next();
  };
  const keyLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: (req) => `key:${req.apiKeyId}`, message: { error: 'Zu viele Anfragen (max. 120/Minute pro Schlüssel).' } });
  const plain = (q) => `„${q.text}“ — ${q.person}${q.source ? `, ${q.source}` : ''}`;

  app.get('/api/v1', (req, res) => res.json({
    name: 'Quotes API', version: 1, auth: 'Authorization: Bearer <API-Schlüssel aus Konto → Integrationen>',
    endpoints: ['GET /api/v1/me', 'GET /api/v1/quotes?scope=mine|feed|shared|liked&q=&tag=&page=', 'GET /api/v1/quotes/:id',
      'GET /api/v1/random?scope=feed|mine|liked[&format=text]', 'GET /api/v1/daily[?format=text]', 'POST /api/v1/quotes (Schlüssel mit Schreibrecht)'],
  }));
  app.get('/api/v1/me', v1('read'), keyLimiter, (req, res) => res.json({ id: req.apiUser.id, username: req.apiUser.username }));
  app.get('/api/v1/quotes', v1('read'), keyLimiter, handler((req, res) => {
    const me = req.apiUser.id;
    const scope = req.query.scope;
    const where = [{ mine: 'q.user_id = @me', liked: `${ACCESS} AND EXISTS(SELECT 1 FROM likes l WHERE l.quote_id = q.id AND l.user_id = @me)`,
      shared: `q.user_id != @me AND ${ACCESS} AND q.visibility != 'public'` }[scope] ?? "q.visibility = 'public'"];
    const params = { me, limit: PAGE_SIZE + 1, offset: (Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1)) - 1) * PAGE_SIZE };
    const q = clean(String(req.query.q ?? ''), 100).slice(0, 100);
    if (q) { where.push("(q.text LIKE @q ESCAPE '\\' OR q.person LIKE @q ESCAPE '\\')"); params.q = `%${escapeLike(q)}%`; }
    if (req.query.tag) { where.push('EXISTS(SELECT 1 FROM quote_tags t WHERE t.quote_id = q.id AND t.tag = @tag)'); params.tag = String(req.query.tag).toLowerCase().replace(/^#/, '').slice(0, 30); }
    const rows = db.prepare(`${BASE} WHERE ${where.join(' AND ')} ORDER BY q.created_at DESC, q.id DESC LIMIT @limit OFFSET @offset`).all(params);
    res.json({ quotes: shape(rows.slice(0, PAGE_SIZE)), hasMore: rows.length > PAGE_SIZE });
  }));
  app.get('/api/v1/quotes/:id', v1('read'), keyLimiter, handler((req, res) => {
    const q = getOne(intParam(req.params.id), req.apiUser.id);
    if (!q) throw notFound();
    res.json(q);
  }));
  const sendQuote = (req, res, q) => {
    if (req.query.format === 'text') return res.type('text/plain; charset=utf-8').send(q ? plain(q) : '');
    res.json({ quote: q ?? null });
  };
  app.get('/api/v1/random', v1('read'), keyLimiter, handler((req, res) => {
    const me = req.apiUser.id;
    const where = { mine: 'q.user_id = @me', liked: `${ACCESS} AND EXISTS(SELECT 1 FROM likes l WHERE l.quote_id = q.id AND l.user_id = @me)` }[req.query.scope] ?? ACCESS;
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM quotes q WHERE ${where}`).get({ me });
    const row = n ? db.prepare(`${BASE} WHERE ${where} ORDER BY q.id LIMIT 1 OFFSET @off`).get({ me, off: Math.floor(Math.random() * n) }) : null;
    sendQuote(req, res, row ? shape([row])[0] : null);
  }));
  app.get('/api/v1/daily', v1('read'), keyLimiter, handler((req, res) => {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM quotes WHERE visibility = 'public'").get();
    if (!n) return sendQuote(req, res, null);
    const offset = parseInt(createHash('sha256').update(new Date().toISOString().slice(0, 10)).digest('hex').slice(0, 8), 16) % n;
    const { id } = db.prepare("SELECT id FROM quotes WHERE visibility = 'public' ORDER BY id LIMIT 1 OFFSET ?").get(offset);
    sendQuote(req, res, getOne(id, req.apiUser.id));
  }));
  app.post('/api/v1/quotes', v1('write'), keyLimiter, handler((req, res) => {
    // Über die API nur eigene Zitate ohne Markieren/Teilen (das bleibt der App vorbehalten)
    const v = validateQuote({ ...req.body, visibility: req.body?.visibility === 'public' ? 'public' : 'private', mentions: [], shareWith: [], shareGroups: [] });
    const id = tx(() => insertQuote(req.apiUser.id, v));
    res.status(201).json(getOne(id, req.apiUser.id));
  }));

  // ---------- Webhooks ----------
  const shapeHook = (w) => ({ id: w.id, url: w.url, events: w.events.split(','), format: w.format, active: !!w.active,
    failures: w.failures, lastStatus: w.last_status, lastAt: w.last_at, createdAt: w.created_at });

  app.get('/api/me/webhooks', requireAuth, (req, res) => {
    res.json({ webhooks: db.prepare('SELECT * FROM webhooks WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id).map(shapeHook), events: EVENTS, allowPrivate });
  });
  app.post('/api/me/webhooks', requireAuth, writeLimiter, handler(async (req, res) => {
    await confirmIdentity(req);
    const url = validateWebhookUrl(String(req.body?.url ?? '').slice(0, 500), { allowPrivate }).toString();
    const events = [...new Set((Array.isArray(req.body?.events) ? req.body.events : []).filter((e) => EVENTS[e]))];
    if (!events.length) throw bad('Bitte mindestens ein Ereignis wählen.');
    const format = ['json', 'slack', 'discord'].includes(req.body?.format) ? req.body.format : 'json';
    if (db.prepare('SELECT COUNT(*) AS n FROM webhooks WHERE user_id = ?').get(req.user.id).n >= MAX_HOOKS) throw bad(`Höchstens ${MAX_HOOKS} Webhooks.`);
    const secret = randomBytes(24).toString('base64url');
    const id = Number(db.prepare('INSERT INTO webhooks (user_id, url, secret, events, format, created_at) VALUES (?,?,?,?,?,?)')
      .run(req.user.id, url, secret, events.join(','), format, Date.now()).lastInsertRowid);
    res.status(201).json({ ...shapeHook(db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id)), secret }); // Secret nur jetzt
  }));
  app.delete('/api/me/webhooks/:id', requireAuth, writeLimiter, handler((req, res) => {
    const r = db.prepare('DELETE FROM webhooks WHERE id = ? AND user_id = ?').run(intParam(req.params.id), req.user.id);
    if (!r.changes) throw notFound();
    res.json({ ok: true });
  }));
  app.post('/api/me/webhooks/:id/test', requireAuth, writeLimiter, handler(async (req, res) => {
    const w = db.prepare('SELECT * FROM webhooks WHERE id = ? AND user_id = ?').get(intParam(req.params.id), req.user.id);
    if (!w) throw notFound();
    const r = await deliver(w, 'test', { message: 'Test-Lieferung von Quotes' }, 'Test von Quotes ✓', { force: true });
    res.json(r);
  }));

  /** Eine Lieferung: JSON signiert (HMAC-SHA256) bzw. Slack/Discord-Format; nach 10 Fehlern in Folge deaktiviert */
  async function deliver(w, event, data, text, { force = false } = {}) {
    if (!w.active && !force) return { ok: false, status: 'deaktiviert' };
    const body = JSON.stringify(w.format === 'slack' ? { text } : w.format === 'discord' ? { content: text.slice(0, 1900) }
      : { event, sentAt: new Date().toISOString(), data });
    const signature = `sha256=${createHmac('sha256', w.secret).update(body).digest('hex')}`;
    let r;
    try {
      // Vor dem Senden erneut prüfen (z. B. falls sich die Einstellung geändert hat)
      validateWebhookUrl(w.url, { allowPrivate });
      r = await sender(w.url, body, { 'X-Quotes-Event': event, 'X-Quotes-Signature': signature });
    } catch (e) { r = { ok: false, status: e.message.slice(0, 80) }; }
    const failures = r.ok ? 0 : w.failures + 1;
    db.prepare('UPDATE webhooks SET last_status = ?, last_at = ?, failures = ?, active = ? WHERE id = ?')
      .run(r.ok ? `ok (${r.status})` : `Fehler: ${r.status}`, Date.now(), failures, failures >= 10 ? 0 : w.active, w.id);
    return r;
  }
  ctx.deliverWebhook = deliver;

  const fire = (userId, event, data, text) => {
    const hooks = db.prepare('SELECT * FROM webhooks WHERE user_id = ? AND active = 1').all(userId).filter((w) => w.events.split(',').includes(event));
    for (const w of hooks) deliver(w, event, data, text).catch((e) => console.warn('[webhook]', e.message));
  };

  onQuoteCreated((userId, quoteId) => {
    const q = getOne(quoteId, userId);
    if (q) fire(userId, 'quote.created', { quote: q }, `Neues Zitat: ${plain(q)}`);
  });
  onNotify((uid, type, actorId, { quoteId }) => {
    const actor = db.prepare('SELECT username FROM users WHERE id = ?').get(actorId)?.username;
    const q = quoteId ? getOne(quoteId, uid) : null; // nur, was der Empfänger sehen darf
    fire(uid, 'notification', { type, actor, quote: q ?? null }, `@${actor}: ${type}${q ? ` – ${plain(q)}` : ''}`);
  });

}
