import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
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

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,30}$/;
const MAX_MENTIONS = 20;

const usernameList = (v, what) => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw bad(`Ungültige Liste: ${what}.`);
  return [...new Set(v.map((n) => clean(n, 31).replace(/^@/, '').toLowerCase()).filter(Boolean))];
};

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
  const mentions = usernameList(body.mentions, 'Markierungen');
  if (mentions.length > MAX_MENTIONS) throw bad(`Höchstens ${MAX_MENTIONS} Personen markieren.`);
  let shareWith = [], shareGroups = [];
  if (visibility === 'shared') {
    shareWith = usernameList(body.shareWith ?? [], 'Empfänger').slice(0, 50);
    if (body.shareGroups !== undefined && !Array.isArray(body.shareGroups)) throw bad('Ungültige Gruppenliste.');
    shareGroups = [...new Set((body.shareGroups ?? []).map(Number))];
    if (shareGroups.length > 20 || shareGroups.some((g) => !Number.isSafeInteger(g) || g < 1)) throw bad('Ungültige Gruppenliste.');
  }
  return { text, person, source, visibility, shareWith, shareGroups, mentions };
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

  const tx = (fn) => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  const requireAuth = (req, res, next) => (req.user ? next() : next(new HttpError(401, 'Bitte anmelden.')));
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Zu viele Versuche. Bitte später erneut versuchen.' },
  });
  const writeLimiter = rateLimit({
    windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Zu viele Anfragen. Bitte kurz warten.' },
  });
  const readLimiter = rateLimit({
    windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false,
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
      if (!USERNAME_RE.test(username)) throw bad('Benutzername: 3–30 Zeichen (Buchstaben, Zahlen, _ . -).');
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
    const row = db.prepare('SELECT password_hash, username_set FROM users WHERE id = ?').get(req.user.id);
    res.json({ user: { ...req.user, sso: row.password_hash === UNUSABLE_HASH, usernameSet: !!row.username_set }, csrf: req.session.csrf });
  });

  // Benutzernamen ändern (bzw. beim ersten SSO-Login festlegen). Markierungen/Freigaben hängen an der ID, nicht am Namen.
  app.put('/api/me/username', requireAuth, writeLimiter, (req, res, next) => {
    try {
      const username = clean(req.body.username, 30);
      if (!USERNAME_RE.test(username)) throw bad('Benutzername: 3–30 Zeichen (Buchstaben, Zahlen, _ . -).');
      try {
        db.prepare('UPDATE users SET username = ?, username_set = 1 WHERE id = ?').run(username, req.user.id);
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Dieser Benutzername ist bereits vergeben.');
        throw e;
      }
      res.json({ user: { id: req.user.id, username } });
    } catch (e) { next(e); }
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
            // username_set = 0: Name ist nur ein Vorschlag aus dem SSO, der Nutzer wählt beim ersten Login selbst
            const id = Number(db.prepare('INSERT INTO users (username, password_hash, created_at, username_set) VALUES (?,?,?,0)')
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

  // --- Zugriffsregeln ---
  // "Für mich": markiert ODER (geteilt UND (direkt ODER über eine Gruppe, in der ich Mitglied bin))
  const FOR_ME = `(EXISTS(SELECT 1 FROM quote_mentions m WHERE m.quote_id = q.id AND m.user_id = @me)
    OR (q.visibility = 'shared' AND (
         EXISTS(SELECT 1 FROM quote_shares s WHERE s.quote_id = q.id AND s.user_id = @me)
      OR EXISTS(SELECT 1 FROM quote_groups qg JOIN group_members gm ON gm.group_id = qg.group_id
                WHERE qg.quote_id = q.id AND gm.user_id = @me))))`;
  const ACCESS = `(q.user_id = @me OR q.visibility = 'public' OR ${FOR_ME})`;
  const BASE = `
    SELECT q.id, q.text, q.person, q.source, q.visibility, q.share_token AS shareToken, q.created_at AS createdAt,
           u.username AS author, (q.user_id = @me) AS mine,
           (SELECT COUNT(*) FROM likes l WHERE l.quote_id = q.id) AS likes,
           EXISTS(SELECT 1 FROM likes l WHERE l.quote_id = q.id AND l.user_id = @me) AS liked
    FROM quotes q JOIN users u ON u.id = q.user_id`;
  const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');
  const placeholders = (arr) => arr.map(() => '?').join(',');

  const groupBy = (rows, key, val) => {
    const m = new Map();
    for (const r of rows) (m.get(r[key]) ?? m.set(r[key], []).get(r[key])).push(val(r));
    return m;
  };

  const shape = (rows) => {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const own = rows.filter((r) => r.mine).map((r) => r.id);
    const mentions = groupBy(db.prepare(`SELECT m.quote_id, u.username FROM quote_mentions m JOIN users u ON u.id = m.user_id
      WHERE m.quote_id IN (${placeholders(ids)}) ORDER BY u.username`).all(...ids), 'quote_id', (r) => r.username);
    const shares = own.length ? groupBy(db.prepare(`SELECT s.quote_id, u.username FROM quote_shares s JOIN users u ON u.id = s.user_id
      WHERE s.quote_id IN (${placeholders(own)}) ORDER BY u.username`).all(...own), 'quote_id', (r) => r.username) : new Map();
    const groups = own.length ? groupBy(db.prepare(`SELECT qg.quote_id, g.id, g.name FROM quote_groups qg JOIN user_groups g ON g.id = qg.group_id
      WHERE qg.quote_id IN (${placeholders(own)}) ORDER BY g.name`).all(...own), 'quote_id', (r) => ({ id: r.id, name: r.name })) : new Map();
    return rows.map((r) => ({
      id: r.id, text: r.text, person: r.person, source: r.source, createdAt: r.createdAt, author: r.author,
      mine: !!r.mine, likes: r.likes, liked: !!r.liked, mentions: mentions.get(r.id) ?? [],
      // Nur für den Eigentümer: Sichtbarkeit, Empfänger, Gruppen, Freigabe-Link
      ...(r.mine ? {
        visibility: r.visibility,
        shareWith: r.visibility === 'shared' ? shares.get(r.id) ?? [] : [],
        shareGroups: r.visibility === 'shared' ? groups.get(r.id) ?? [] : [],
        link: r.shareToken ? `/s/${r.shareToken}` : null,
      } : {}),
    }));
  };

  const idParam = (req, name = 'id') => {
    const id = Number(req.params[name]);
    if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(404, 'Nicht gefunden.');
    return id;
  };
  const getOne = (id, me) => shape(db.prepare(`${BASE} WHERE q.id = @id AND ${ACCESS}`).all({ id, me }))[0];
  const memberRole = (groupId, userId) =>
    db.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId)?.role ?? null;

  // --- Benachrichtigungen ---
  const notifyStmt = db.prepare('INSERT INTO notifications (user_id, type, actor_id, quote_id, group_id, created_at) VALUES (?,?,?,?,?,?)');
  const notify = (userIds, type, actorId, { quoteId = null, groupId = null } = {}) => {
    const now = Date.now();
    for (const uid of userIds) if (uid !== actorId) notifyStmt.run(uid, type, actorId, quoteId, groupId, now);
  };

  // --- Nutzersuche (für Markieren/Teilen/Gruppen) ---
  app.get('/api/users', requireAuth, readLimiter, (req, res) => {
    const q = clean(String(req.query.q ?? ''), 30).replace(/^@/, '').slice(0, 30);
    if (!q) return res.json({ users: [] });
    const rows = db.prepare(`SELECT username FROM users WHERE username LIKE ? ESCAPE '\\' AND id != ?
                             ORDER BY length(username), username LIMIT 8`).all(`${escapeLike(q)}%`, req.user.id);
    res.json({ users: rows.map((r) => r.username) });
  });

  // --- Zitate ---
  app.get('/api/quotes', requireAuth, (req, res, next) => {
    try {
      const scope = ['mine', 'feed', 'shared', 'liked', 'group'].includes(req.query.scope) ? req.query.scope : 'feed';
      const q = clean(String(req.query.q ?? ''), 100).slice(0, 100);
      const page = Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1));
      const where = [];
      const params = { me: req.user.id, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE };
      if (scope === 'mine') where.push('q.user_id = @me');
      else if (scope === 'shared') where.push(`q.user_id != @me AND ${FOR_ME}`);
      else if (scope === 'liked') where.push(`${ACCESS} AND EXISTS(SELECT 1 FROM likes l WHERE l.quote_id = q.id AND l.user_id = @me)`);
      else if (scope === 'group') {
        const gid = Number(req.query.group);
        if (!Number.isSafeInteger(gid) || !memberRole(gid, req.user.id)) throw new HttpError(404, 'Gruppe nicht gefunden.');
        params.gid = gid;
        where.push(`q.visibility = 'shared' AND EXISTS(SELECT 1 FROM quote_groups qg WHERE qg.quote_id = q.id AND qg.group_id = @gid)`);
      } else where.push(`q.visibility = 'public'`);
      if (q) {
        where.push(`(q.text LIKE @q ESCAPE '\\' OR q.person LIKE @q ESCAPE '\\' OR q.source LIKE @q ESCAPE '\\')`);
        params.q = `%${escapeLike(q)}%`;
      }
      const rows = db.prepare(`${BASE} WHERE ${where.join(' AND ')} ORDER BY q.created_at DESC, q.id DESC LIMIT @limit OFFSET @offset`).all(params);
      res.json({ quotes: shape(rows.slice(0, PAGE_SIZE)), hasMore: rows.length > PAGE_SIZE });
    } catch (e) { next(e); }
  });

  app.get('/api/quotes/:id', requireAuth, (req, res, next) => {
    try {
      const quote = getOne(idParam(req), req.user.id);
      if (!quote) throw new HttpError(404, 'Nicht gefunden.');
      res.json(quote);
    } catch (e) { next(e); }
  });

  function resolveUsers(usernames, what) {
    if (!usernames.length) return [];
    const rows = db.prepare(`SELECT id, username FROM users WHERE username IN (${placeholders(usernames)})`).all(...usernames);
    const found = new Set(rows.map((r) => r.username.toLowerCase()));
    const missing = usernames.filter((n) => !found.has(n));
    if (missing.length) throw bad(`Unbekannte Nutzer (${what}): ${missing.slice(0, 5).join(', ')}`);
    return rows;
  }

  function resolveGroups(groupIds, userId) {
    if (!groupIds.length) return [];
    const rows = db.prepare(`SELECT group_id FROM group_members WHERE user_id = ? AND group_id IN (${placeholders(groupIds)})`)
      .all(userId, ...groupIds);
    if (rows.length !== groupIds.length) throw bad('Du kannst nur mit Gruppen teilen, in denen du Mitglied bist.');
    return groupIds;
  }

  /** Speichert Freigaben/Gruppen/Markierungen und benachrichtigt nur NEU hinzugekommene Personen. */
  function saveRelations(quoteId, ownerId, v) {
    const ids = (sql) => new Set(db.prepare(sql).all(quoteId).map((r) => r.user_id));
    const prevMentions = ids('SELECT user_id FROM quote_mentions WHERE quote_id = ?');
    const prevShares = ids('SELECT user_id FROM quote_shares WHERE quote_id = ?');

    const mentioned = resolveUsers(v.mentions, 'Markierungen').map((r) => r.id).filter((id) => id !== ownerId);
    const shared = v.visibility === 'shared' ? resolveUsers(v.shareWith, 'Teilen').map((r) => r.id).filter((id) => id !== ownerId) : [];
    const groups = v.visibility === 'shared' ? resolveGroups(v.shareGroups, ownerId) : [];

    for (const t of ['quote_mentions', 'quote_shares', 'quote_groups']) db.prepare(`DELETE FROM ${t} WHERE quote_id = ?`).run(quoteId);
    const insM = db.prepare('INSERT INTO quote_mentions (quote_id, user_id) VALUES (?,?)');
    const insS = db.prepare('INSERT INTO quote_shares (quote_id, user_id) VALUES (?,?)');
    const insG = db.prepare('INSERT INTO quote_groups (quote_id, group_id) VALUES (?,?)');
    for (const id of mentioned) insM.run(quoteId, id);
    for (const id of shared) insS.run(quoteId, id);
    for (const id of groups) insG.run(quoteId, id);

    const newMentions = mentioned.filter((id) => !prevMentions.has(id));
    notify(newMentions, 'mention', ownerId, { quoteId });
    // Wer markiert wurde, bekommt keine zusätzliche "geteilt"-Nachricht
    notify(shared.filter((id) => !prevShares.has(id) && !mentioned.includes(id)), 'share', ownerId, { quoteId });
  }

  app.post('/api/quotes', requireAuth, writeLimiter, (req, res, next) => {
    try {
      const v = validateQuote(req.body);
      const id = tx(() => {
        const now = Date.now();
        const id = Number(db.prepare('INSERT INTO quotes (user_id,text,person,source,visibility,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
          .run(req.user.id, v.text, v.person, v.source, v.visibility, now, now).lastInsertRowid);
        saveRelations(id, req.user.id, v);
        return id;
      });
      res.status(201).json(getOne(id, req.user.id));
    } catch (e) { next(e); }
  });

  const requireOwnQuote = (req) => {
    const id = idParam(req);
    const row = db.prepare('SELECT user_id FROM quotes WHERE id = ?').get(id);
    if (!row || row.user_id !== req.user.id) throw new HttpError(404, 'Nicht gefunden.');
    return id;
  };

  app.put('/api/quotes/:id', requireAuth, writeLimiter, (req, res, next) => {
    try {
      const id = requireOwnQuote(req);
      const v = validateQuote(req.body);
      tx(() => {
        db.prepare('UPDATE quotes SET text=?, person=?, source=?, visibility=?, updated_at=? WHERE id=?')
          .run(v.text, v.person, v.source, v.visibility, Date.now(), id);
        saveRelations(id, req.user.id, v);
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

  // --- Freigabe-Links: geheimes Token (192 Bit), jederzeit widerrufbar ---
  app.post('/api/quotes/:id/link', requireAuth, writeLimiter, (req, res, next) => {
    try {
      const id = requireOwnQuote(req);
      let { share_token: token } = db.prepare('SELECT share_token FROM quotes WHERE id = ?').get(id);
      if (!token) {
        token = randomBytes(24).toString('base64url');
        db.prepare('UPDATE quotes SET share_token = ? WHERE id = ?').run(token, id);
      }
      res.json({ link: `/s/${token}` });
    } catch (e) { next(e); }
  });

  app.delete('/api/quotes/:id/link', requireAuth, writeLimiter, (req, res, next) => {
    try {
      const id = requireOwnQuote(req);
      db.prepare('UPDATE quotes SET share_token = NULL WHERE id = ?').run(id);
      res.json({ link: null });
    } catch (e) { next(e); }
  });

  // Öffentlich, ohne Login: nur Inhalt + Autor, keine Markierungen/Empfänger/Likes
  app.get('/api/public/quotes/:token', readLimiter, (req, res, next) => {
    try {
      const token = req.params.token;
      if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new HttpError(404, 'Dieser Link ist ungültig oder wurde deaktiviert.');
      const row = db.prepare(`SELECT q.text, q.person, q.source, q.created_at AS createdAt, u.username AS author
                              FROM quotes q JOIN users u ON u.id = q.user_id WHERE q.share_token = ?`).get(token);
      if (!row) throw new HttpError(404, 'Dieser Link ist ungültig oder wurde deaktiviert.');
      res.set('X-Robots-Tag', 'noindex');
      res.json(row);
    } catch (e) { next(e); }
  });

  // --- Gruppen ---
  const groupName = (v) => {
    const name = clean(v, 50);
    if (!name) throw bad('Bitte einen Gruppennamen angeben.');
    if (name.length > 50) throw bad('Der Gruppenname ist zu lang (max. 50 Zeichen).');
    return name;
  };
  const MAX_MEMBERS = 200;
  const groupGid = (req) => {
    const gid = idParam(req, 'gid');
    const role = memberRole(gid, req.user.id);
    if (!role) throw new HttpError(404, 'Gruppe nicht gefunden.');
    return { gid, role };
  };
  const groupDetails = (gid, me) => {
    const g = db.prepare('SELECT id, name, owner_id, created_at AS createdAt FROM user_groups WHERE id = ?').get(gid);
    const members = db.prepare(`SELECT u.id, u.username, gm.role FROM group_members gm JOIN users u ON u.id = gm.user_id
                                WHERE gm.group_id = ? ORDER BY gm.role = 'owner' DESC, u.username`).all(gid);
    return { id: g.id, name: g.name, createdAt: g.createdAt, isOwner: g.owner_id === me, members };
  };

  app.get('/api/groups', requireAuth, (req, res) => {
    const groups = db.prepare(`SELECT g.id, g.name, gm.role,
                                 (SELECT COUNT(*) FROM group_members x WHERE x.group_id = g.id) AS memberCount
                               FROM group_members gm JOIN user_groups g ON g.id = gm.group_id
                               WHERE gm.user_id = ? ORDER BY g.name COLLATE NOCASE`).all(req.user.id);
    res.json({ groups: groups.map((g) => ({ ...g, isOwner: g.role === 'owner' })) });
  });

  app.post('/api/groups', requireAuth, writeLimiter, (req, res, next) => {
    try {
      const name = groupName(req.body.name);
      const members = resolveUsers(usernameList(req.body.members, 'Mitglieder').slice(0, MAX_MEMBERS), 'Mitglieder')
        .filter((u) => u.id !== req.user.id);
      const { n } = db.prepare("SELECT COUNT(*) n FROM user_groups WHERE owner_id = ?").get(req.user.id);
      if (n >= 50) throw bad('Du kannst höchstens 50 Gruppen besitzen.');
      const gid = tx(() => {
        const now = Date.now();
        const gid = Number(db.prepare('INSERT INTO user_groups (name, owner_id, created_at) VALUES (?,?,?)').run(name, req.user.id, now).lastInsertRowid);
        const ins = db.prepare('INSERT INTO group_members (group_id, user_id, role, added_at) VALUES (?,?,?,?)');
        ins.run(gid, req.user.id, 'owner', now);
        for (const m of members) ins.run(gid, m.id, 'member', now);
        notify(members.map((m) => m.id), 'group_add', req.user.id, { groupId: gid });
        return gid;
      });
      res.status(201).json(groupDetails(gid, req.user.id));
    } catch (e) { next(e); }
  });

  app.get('/api/groups/:gid', requireAuth, (req, res, next) => {
    try { res.json(groupDetails(groupGid(req).gid, req.user.id)); } catch (e) { next(e); }
  });

  app.patch('/api/groups/:gid', requireAuth, writeLimiter, (req, res, next) => {
    try {
      const { gid, role } = groupGid(req);
      if (role !== 'owner') throw new HttpError(403, 'Nur der Besitzer kann die Gruppe umbenennen.');
      db.prepare('UPDATE user_groups SET name = ? WHERE id = ?').run(groupName(req.body.name), gid);
      res.json(groupDetails(gid, req.user.id));
    } catch (e) { next(e); }
  });

  app.delete('/api/groups/:gid', requireAuth, writeLimiter, (req, res, next) => {
    try {
      const { gid, role } = groupGid(req);
      if (role !== 'owner') throw new HttpError(403, 'Nur der Besitzer kann die Gruppe löschen.');
      db.prepare('DELETE FROM user_groups WHERE id = ?').run(gid);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.post('/api/groups/:gid/members', requireAuth, writeLimiter, (req, res, next) => {
    try {
      const { gid, role } = groupGid(req);
      if (role !== 'owner') throw new HttpError(403, 'Nur der Besitzer kann Mitglieder hinzufügen.');
      const users = resolveUsers(usernameList(req.body.usernames, 'Mitglieder').slice(0, 50), 'Mitglieder');
      const { n } = db.prepare('SELECT COUNT(*) n FROM group_members WHERE group_id = ?').get(gid);
      if (n + users.length > MAX_MEMBERS) throw bad(`Eine Gruppe hat höchstens ${MAX_MEMBERS} Mitglieder.`);
      tx(() => {
        const ins = db.prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, role, added_at) VALUES (?,?,'member',?)");
        const added = users.filter((u) => ins.run(gid, u.id, Date.now()).changes).map((u) => u.id);
        notify(added, 'group_add', req.user.id, { groupId: gid });
      });
      res.json(groupDetails(gid, req.user.id));
    } catch (e) { next(e); }
  });

  // Besitzer entfernt Mitglieder; Mitglieder können sich selbst entfernen (Gruppe verlassen)
  app.delete('/api/groups/:gid/members/:uid', requireAuth, writeLimiter, (req, res, next) => {
    try {
      const { gid, role } = groupGid(req);
      const uid = idParam(req, 'uid');
      if (uid !== req.user.id && role !== 'owner') throw new HttpError(403, 'Nur der Besitzer kann Mitglieder entfernen.');
      if (memberRole(gid, uid) === 'owner') throw bad('Der Besitzer kann die Gruppe nicht verlassen – lösche sie stattdessen.');
      db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(gid, uid);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // --- Benachrichtigungen ---
  // Nur anzeigen, was der Nutzer (noch) sehen darf: Zitat weiterhin zugänglich bzw. weiterhin Gruppenmitglied
  const VISIBLE_NOTIF = `n.user_id = @me
    AND (n.quote_id IS NULL OR EXISTS(SELECT 1 FROM quotes q WHERE q.id = n.quote_id AND ${ACCESS}))
    AND (n.group_id IS NULL OR EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id = n.group_id AND gm.user_id = @me))`;

  app.get('/api/notifications', requireAuth, (req, res) => {
    const me = req.user.id;
    const items = db.prepare(`
      SELECT n.id, n.type, n.created_at AS createdAt, n.read_at IS NOT NULL AS read, a.username AS actor,
             n.quote_id AS quoteId, q.text AS quoteText, q.person AS quotePerson, n.group_id AS groupId, g.name AS groupName
      FROM notifications n JOIN users a ON a.id = n.actor_id
      LEFT JOIN quotes q ON q.id = n.quote_id LEFT JOIN user_groups g ON g.id = n.group_id
      WHERE ${VISIBLE_NOTIF}
      ORDER BY n.created_at DESC, n.id DESC LIMIT 50`).all({ me });
    const { unread } = db.prepare(`SELECT COUNT(*) AS unread FROM notifications n WHERE ${VISIBLE_NOTIF} AND n.read_at IS NULL`).get({ me });
    res.json({ items: items.map((i) => ({ ...i, read: !!i.read, quoteText: i.quoteText?.slice(0, 140) })), unread });
  });

  app.post('/api/notifications/read', requireAuth, writeLimiter, (req, res) => {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(Date.now(), req.user.id);
    res.json({ ok: true });
  });

  app.use('/api', (req, res, next) => next(new HttpError(404, 'Nicht gefunden.')));

  // Öffentliche Seite für Freigabe-Links: gleiche SPA, nicht indexieren
  app.get('/s/:token', (req, res) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.sendFile(join(PUBLIC_DIR, 'index.html'));
  });

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
