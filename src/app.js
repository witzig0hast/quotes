import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  hashPassword, verifyPassword, DUMMY_HASH, createSession, getSession,
  destroySession, cookieOptions, safeEqual, COOKIE,
} from './auth.js';
import { OidcError } from './oidc.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PAGE_SIZE = 20;
const VISIBILITIES = ['private', 'shared', 'public'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

const clean = (v, max) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '').slice(0, max + 1);

function validateQuote(body) {
  const text = clean(body.text, 1000);
  const person = clean(body.person, 100);
  const source = clean(body.source, 150);
  const visibility = body.visibility;
  if (!text) throw bad('Das Zitat darf nicht leer sein.');
  if (text.length > 1000) throw bad('Das Zitat ist zu lang (max. 1000 Zeichen).');
  if (!person) throw bad('Bitte eine Person angeben.');
  if (person.length > 100) throw bad('Der Name ist zu lang (max. 100 Zeichen).');
  if (source.length > 150) throw bad('Die Quelle ist zu lang (max. 150 Zeichen).');
  if (!VISIBILITIES.includes(visibility)) throw bad('Ungültige Sichtbarkeit.');
  let shareWith = [];
  if (visibility === 'shared') {
    if (!Array.isArray(body.shareWith)) throw bad('Ungültige Empfängerliste.');
    shareWith = [...new Set(body.shareWith.map((n) => clean(n, 30).toLowerCase()).filter(Boolean))].slice(0, 50);
  }
  return { text, person, source, visibility, shareWith };
}

const BIND_COOKIE = 'oidc_bind';
const UNUSABLE_HASH = '!'; // SSO-Konten haben kein Passwort; verifyPassword() lehnt das immer ab.

const getCookie = (req, name) => {
  const raw = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  if (!raw) return null;
  try { return decodeURIComponent(raw.slice(name.length + 1)); } catch { return null; }
};

function usernameBase(claims) {
  const src = claims.preferredUsername || claims.email.split('@')[0] || claims.name || 'user';
  let u = src.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 26);
  return u.length >= 3 ? u : `user_${u}`.slice(0, 26);
}

export function createApp({ db, oidc = null, secureCookies = process.env.NODE_ENV === 'production' } = {}) {
  const passwordLogin = !oidc || oidc.passwordLogin;
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        upgradeInsecureRequests: secureCookies ? [] : null,
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: secureCookies,
  }));

  app.use(express.json({ limit: '20kb' }));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // --- Session laden + CSRF-Schutz ---
  app.use('/api', (req, res, next) => {
    const token = getCookie(req, COOKIE);
    const s = getSession(db, token);
    req.sessionToken = token;
    req.session = s;
    req.user = s?.user ?? null;
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (unsafe) {
      if (!req.is('application/json') && req.method !== 'DELETE') return next(new HttpError(415, 'Nur JSON erlaubt.'));
      if (s && !safeEqual(req.get('x-csrf-token') || '', s.csrf)) return next(new HttpError(403, 'Ungültiges CSRF-Token.'));
    }
    next();
  });

  const requireAuth = (req, res, next) => (req.user ? next() : next(new HttpError(401, 'Bitte anmelden.')));
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Zu viele Versuche. Bitte später erneut versuchen.' },
  });
  const writeLimiter = rateLimit({
    windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Zu viele Anfragen. Bitte kurz warten.' },
  });

  const sendSession = (res, user, sess) => {
    res.cookie(COOKIE, sess.token, cookieOptions(secureCookies));
    res.json({ user, csrf: sess.csrf });
  };

  // --- Auth ---
  const needPasswordLogin = (req, res, next) =>
    (passwordLogin ? next() : next(new HttpError(403, 'Anmeldung mit Passwort ist deaktiviert. Bitte SSO verwenden.')));

  app.get('/api/config', (req, res) => {
    res.json({ sso: oidc ? { name: oidc.name } : null, passwordLogin });
  });

  app.post('/api/register', needPasswordLogin, authLimiter, async (req, res, next) => {
    try {
      const username = clean(req.body.username, 30);
      const password = typeof req.body.password === 'string' ? req.body.password : '';
      if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) throw bad('Benutzername: 3–30 Zeichen (Buchstaben, Zahlen, _ . -).');
      if (password.length < 10) throw bad('Das Passwort muss mindestens 10 Zeichen lang sein.');
      if (password.length > 200) throw bad('Das Passwort ist zu lang.');
      const hash = await hashPassword(password);
      let id;
      try {
        id = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)')
          .run(username, hash, Date.now()).lastInsertRowid;
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Dieser Benutzername ist bereits vergeben.');
        throw e;
      }
      sendSession(res.status(201), { id: Number(id), username }, createSession(db, Number(id)));
    } catch (e) { next(e); }
  });

  app.post('/api/login', needPasswordLogin, authLimiter, async (req, res, next) => {
    try {
      const username = clean(req.body.username, 30);
      const password = typeof req.body.password === 'string' ? req.body.password.slice(0, 200) : '';
      const row = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
      const ok = await verifyPassword(password, row ? row.password_hash : DUMMY_HASH);
      if (!row || !ok) throw new HttpError(401, 'Benutzername oder Passwort falsch.');
      if (req.sessionToken) destroySession(db, req.sessionToken);
      sendSession(res, { id: row.id, username: row.username }, createSession(db, row.id));
    } catch (e) { next(e); }
  });

  app.post('/api/logout', (req, res) => {
    if (req.sessionToken) destroySession(db, req.sessionToken);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    if (!req.session) return res.json({ user: null });
    const { password_hash: ph } = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    res.json({ user: { ...req.user, sso: ph === UNUSABLE_HASH }, csrf: req.session.csrf });
  });

  // --- SSO (OpenID Connect) ---
  if (oidc) {
    const bindOpts = { httpOnly: true, sameSite: 'lax', secure: secureCookies, path: '/api/auth/oidc' }; // Lax: Rücksprung vom IdP ist cross-site
    const fail = (res, code) => res.redirect(302, `/?sso_error=${encodeURIComponent(code)}`);

    app.get('/api/auth/oidc/login', authLimiter, async (req, res) => {
      try {
        const { url, bind } = await oidc.begin(db);
        res.cookie(BIND_COOKIE, bind, { ...bindOpts, maxAge: 10 * 60 * 1000 });
        res.redirect(302, url);
      } catch (e) {
        console.error('[oidc] login:', e.message);
        fail(res, 'provider_error');
      }
    });

    app.get('/api/auth/oidc/callback', authLimiter, async (req, res) => {
      const bind = getCookie(req, BIND_COOKIE);
      res.clearCookie(BIND_COOKIE, bindOpts);
      try {
        const q = (k) => (typeof req.query[k] === 'string' ? req.query[k] : undefined);
        const claims = await oidc.complete(db, { state: q('state'), code: q('code'), error: q('error'), bind });
        const user = findOrCreateSsoUser(claims);
        if (req.sessionToken) destroySession(db, req.sessionToken);
        const sess = createSession(db, user.id);
        res.cookie(COOKIE, sess.token, cookieOptions(secureCookies));
        res.redirect(302, '/');
      } catch (e) {
        if (e instanceof OidcError) {
          console.warn(`[oidc] callback abgelehnt (${e.code}): ${e.message}`);
          return fail(res, e.code);
        }
        console.error('[oidc] callback:', e);
        fail(res, 'failed');
      }
    });

    function findOrCreateSsoUser(claims) {
      const existing = db.prepare(`SELECT u.id, u.username FROM identities i JOIN users u ON u.id = i.user_id
                                   WHERE i.issuer = ? AND i.sub = ?`).get(oidc.issuer, claims.sub);
      if (existing) return existing;
      if (!oidc.allowSignup) throw new OidcError('signup_disabled', 'Selbstregistrierung per SSO ist deaktiviert');
      // Bewusst KEINE automatische Verknüpfung mit bestehenden Konten gleichen Namens/gleicher E-Mail (Account-Takeover).
      const base = usernameBase(claims);
      for (let i = 0; i < 8; i++) {
        const username = i === 0 ? base : `${base}${Math.floor(1000 + Math.random() * 9000)}`;
        try {
          return tx(() => {
            const id = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)')
              .run(username, UNUSABLE_HASH, Date.now()).lastInsertRowid);
            db.prepare('INSERT INTO identities (issuer, sub, user_id) VALUES (?,?,?)').run(oidc.issuer, claims.sub, id);
            return { id, username };
          });
        } catch (e) {
          if (!String(e.message).includes('UNIQUE')) throw e;
          // Race: gleiche Identität inzwischen angelegt?
          const again = db.prepare(`SELECT u.id, u.username FROM identities i JOIN users u ON u.id = i.user_id
                                    WHERE i.issuer = ? AND i.sub = ?`).get(oidc.issuer, claims.sub);
          if (again) return again;
        }
      }
      throw new OidcError('failed', 'Kein freier Benutzername gefunden');
    }
  }

  app.delete('/api/me', requireAuth, writeLimiter, async (req, res, next) => {
    try {
      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
      if (row.password_hash === UNUSABLE_HASH) {
        // SSO-Konto ohne Passwort: Bestätigung durch Eintippen des Benutzernamens
        if (req.body?.confirm !== req.user.username) throw new HttpError(403, 'Benutzername stimmt nicht.');
      } else {
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        if (!(await verifyPassword(password, row.password_hash))) throw new HttpError(403, 'Passwort falsch.');
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
      res.clearCookie(COOKIE, { path: '/' });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // --- Zitate ---
  const BASE = `
    SELECT q.id, q.text, q.person, q.source, q.visibility, q.created_at AS createdAt,
           u.username AS author, (q.user_id = @me) AS mine,
           (SELECT COUNT(*) FROM likes l WHERE l.quote_id = q.id) AS likes,
           EXISTS(SELECT 1 FROM likes l WHERE l.quote_id = q.id AND l.user_id = @me) AS liked
    FROM quotes q JOIN users u ON u.id = q.user_id`;
  const ACCESS = `(q.user_id = @me OR q.visibility = 'public'
                   OR (q.visibility = 'shared' AND EXISTS(SELECT 1 FROM quote_shares s WHERE s.quote_id = q.id AND s.user_id = @me)))`;
  const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');

  const sharedWithMap = (ids) => {
    if (!ids.length) return new Map();
    const rows = db.prepare(`SELECT s.quote_id, u.username FROM quote_shares s JOIN users u ON u.id = s.user_id
                             WHERE s.quote_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    const m = new Map();
    for (const r of rows) (m.get(r.quote_id) ?? m.set(r.quote_id, []).get(r.quote_id)).push(r.username);
    return m;
  };

  const shape = (rows) => {
    const shares = sharedWithMap(rows.filter((r) => r.mine && r.visibility === 'shared').map((r) => r.id));
    return rows.map((r) => ({
      id: r.id, text: r.text, person: r.person, source: r.source, visibility: r.mine ? r.visibility : undefined,
      createdAt: r.createdAt, author: r.author, mine: !!r.mine, likes: r.likes, liked: !!r.liked,
      shareWith: r.mine && r.visibility === 'shared' ? shares.get(r.id) ?? [] : undefined,
    }));
  };

  app.get('/api/quotes', requireAuth, (req, res) => {
    const scope = ['mine', 'feed', 'shared', 'liked'].includes(req.query.scope) ? req.query.scope : 'feed';
    const q = clean(String(req.query.q ?? ''), 100).slice(0, 100);
    const page = Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1));
    const where = [];
    const params = { me: req.user.id, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE };
    if (scope === 'mine') where.push('q.user_id = @me');
    else if (scope === 'shared') where.push(`q.user_id != @me AND q.visibility = 'shared' AND EXISTS(SELECT 1 FROM quote_shares s WHERE s.quote_id = q.id AND s.user_id = @me)`);
    else if (scope === 'liked') where.push(`${ACCESS} AND EXISTS(SELECT 1 FROM likes l WHERE l.quote_id = q.id AND l.user_id = @me)`);
    else where.push(`q.visibility = 'public'`);
    if (q) {
      where.push(`(q.text LIKE @q ESCAPE '\\' OR q.person LIKE @q ESCAPE '\\' OR q.source LIKE @q ESCAPE '\\')`);
      params.q = `%${escapeLike(q)}%`;
    }
    const rows = db.prepare(`${BASE} WHERE ${where.join(' AND ')} ORDER BY q.created_at DESC, q.id DESC LIMIT @limit OFFSET @offset`).all(params);
    const hasMore = rows.length > PAGE_SIZE;
    res.json({ quotes: shape(rows.slice(0, PAGE_SIZE)), hasMore });
  });

  function resolveRecipients(usernames, ownerId) {
    if (!usernames.length) return [];
    const rows = db.prepare(`SELECT id, username FROM users WHERE username IN (${usernames.map(() => '?').join(',')})`).all(...usernames);
    const found = new Set(rows.map((r) => r.username.toLowerCase()));
    const missing = usernames.filter((n) => !found.has(n));
    if (missing.length) throw bad(`Unbekannte Nutzer: ${missing.slice(0, 5).join(', ')}`);
    return rows.filter((r) => r.id !== ownerId);
  }

  function saveShares(quoteId, visibility, recipients) {
    db.prepare('DELETE FROM quote_shares WHERE quote_id = ?').run(quoteId);
    if (visibility !== 'shared') return;
    const ins = db.prepare('INSERT INTO quote_shares (quote_id, user_id) VALUES (?,?)');
    for (const r of recipients) ins.run(quoteId, r.id);
  }

  const tx = (fn) => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  const getOne = (id, me) => shape(db.prepare(`${BASE} WHERE q.id = @id AND ${ACCESS}`).all({ id, me }))[0];
  const idParam = (req) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(404, 'Nicht gefunden.');
    return id;
  };

  app.post('/api/quotes', requireAuth, writeLimiter, (req, res, next) => {
    try {
      const v = validateQuote(req.body);
      const recipients = resolveRecipients(v.shareWith, req.user.id);
      const id = tx(() => {
        const now = Date.now();
        const id = Number(db.prepare('INSERT INTO quotes (user_id,text,person,source,visibility,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
          .run(req.user.id, v.text, v.person, v.source, v.visibility, now, now).lastInsertRowid);
        saveShares(id, v.visibility, recipients);
        return id;
      });
      res.status(201).json(getOne(id, req.user.id));
    } catch (e) { next(e); }
  });

  app.put('/api/quotes/:id', requireAuth, writeLimiter, (req, res, next) => {
    try {
      const id = idParam(req);
      const owner = db.prepare('SELECT user_id FROM quotes WHERE id = ?').get(id);
      if (!owner || owner.user_id !== req.user.id) throw new HttpError(404, 'Nicht gefunden.');
      const v = validateQuote(req.body);
      const recipients = resolveRecipients(v.shareWith, req.user.id);
      tx(() => {
        db.prepare('UPDATE quotes SET text=?, person=?, source=?, visibility=?, updated_at=? WHERE id=?')
          .run(v.text, v.person, v.source, v.visibility, Date.now(), id);
        saveShares(id, v.visibility, recipients);
      });
      res.json(getOne(id, req.user.id));
    } catch (e) { next(e); }
  });

  app.delete('/api/quotes/:id', requireAuth, writeLimiter, (req, res, next) => {
    try {
      const r = db.prepare('DELETE FROM quotes WHERE id = ? AND user_id = ?').run(idParam(req), req.user.id);
      if (!r.changes) throw new HttpError(404, 'Nicht gefunden.');
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.post('/api/quotes/:id/like', requireAuth, writeLimiter, (req, res, next) => {
    try {
      const id = idParam(req);
      if (!getOne(id, req.user.id)) throw new HttpError(404, 'Nicht gefunden.');
      const del = db.prepare('DELETE FROM likes WHERE quote_id = ? AND user_id = ?').run(id, req.user.id);
      if (!del.changes) db.prepare('INSERT INTO likes (quote_id, user_id) VALUES (?,?)').run(id, req.user.id);
      const { likes } = db.prepare('SELECT COUNT(*) AS likes FROM likes WHERE quote_id = ?').get(id);
      res.json({ liked: !del.changes, likes });
    } catch (e) { next(e); }
  });

  app.use('/api', (req, res, next) => next(new HttpError(404, 'Nicht gefunden.')));

  app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: 'index.html' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') err = new HttpError(413, 'Anfrage zu groß.');
    else if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Ungültiges JSON.');
    const status = err.status && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Interner Serverfehler.' : err.message });
  });

  return app;
}
