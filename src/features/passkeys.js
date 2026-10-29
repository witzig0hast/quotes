// Passkeys (WebAuthn): mit Fingerabdruck, Gesicht oder Geräte-PIN anmelden – ohne Passwort.
// Registrieren nur angemeldet und nach Identitätsbestätigung; Anmelden über "auffindbare" Schlüssel.
import { randomBytes, createHash } from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { bad, notFound, handler, HttpError, clean, intParam } from '../util.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const FLOW_TTL = 5 * 60_000;
const MAX_PASSKEYS = 20;

/** Gerätename aus dem User-Agent raten (nur Vorschlag, umbenennbar). */
function guessName(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Gerät';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}

export function registerPasskeys(app, ctx) {
  const { db, requireAuth, authLimiter, writeLimiter, confirmIdentity, sendSession, createSession, destroySession, userInfo, publicUrl } = ctx;

  /** Relying Party: aus PUBLIC_URL, sonst aus der Anfrage (lokale Entwicklung). */
  const relyingParty = (req) => {
    if (publicUrl) { const u = new URL(publicUrl); return { rpID: u.hostname, origin: u.origin }; }
    return { rpID: req.hostname, origin: `${req.protocol}://${req.get('host')}` };
  };

  const newFlow = (kind, userId, challenge, rp) => {
    const flow = randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM webauthn_flows WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO webauthn_flows (flow_hash, user_id, kind, challenge, rp_id, origin, expires_at) VALUES (?,?,?,?,?,?,?)')
      .run(sha256(flow), userId, kind, challenge, rp.rpID, rp.origin, Date.now() + FLOW_TTL);
    return flow;
  };
  /** Ablauf einmalig einlösen (wird immer gelöscht, auch bei Fehlern). */
  const takeFlow = (raw, kind, userId = null) => {
    const flow = String(raw ?? '');
    const row = /^[A-Za-z0-9_-]{43}$/.test(flow) ? db.prepare('SELECT * FROM webauthn_flows WHERE flow_hash = ?').get(sha256(flow)) : null;
    if (row) db.prepare('DELETE FROM webauthn_flows WHERE flow_hash = ?').run(row.flow_hash);
    if (!row || row.kind !== kind || row.expires_at < Date.now() || (kind === 'register' && row.user_id !== userId)) {
      throw bad('Der Vorgang ist abgelaufen. Bitte noch einmal versuchen.');
    }
    return row;
  };
  const webauthnId = (uid) => {
    const row = db.prepare('SELECT webauthn_id FROM users WHERE id = ?').get(uid);
    if (row.webauthn_id) return row.webauthn_id;
    const id = randomBytes(16).toString('base64url'); // nicht die interne Nutzer-ID preisgeben
    db.prepare('UPDATE users SET webauthn_id = ? WHERE id = ?').run(id, uid);
    return id;
  };
  const list = (uid) => db.prepare(`SELECT id, name, backed_up AS synced, created_at AS createdAt, last_used_at AS lastUsedAt
    FROM passkeys WHERE user_id = ? ORDER BY created_at`).all(uid).map((p) => ({ ...p, synced: !!p.synced }));
  const parseTransports = (t) => { try { return JSON.parse(t ?? '[]'); } catch { return []; } };

  ctx.passkeyCount = (uid) => db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(uid).n;

  app.get('/api/me/passkeys', requireAuth, (req, res) => res.json({ items: list(req.user.id) }));

  // Registrierung, Schritt 1: Optionen für navigator.credentials.create()
  app.post('/api/me/passkeys/options', requireAuth, writeLimiter, handler(async (req, res) => {
    await confirmIdentity(req);
    if (ctx.passkeyCount(req.user.id) >= MAX_PASSKEYS) throw bad(`Höchstens ${MAX_PASSKEYS} Passkeys pro Konto.`);
    const rp = relyingParty(req);
    const existing = db.prepare('SELECT credential_id, transports FROM passkeys WHERE user_id = ?').all(req.user.id);
    const options = await generateRegistrationOptions({
      rpName: 'Quotes', rpID: rp.rpID, userName: req.user.username, userDisplayName: req.user.username,
      userID: Buffer.from(webauthnId(req.user.id), 'base64url'), attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: parseTransports(c.transports) })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    res.json({ flow: newFlow('register', req.user.id, options.challenge, rp), options });
  }));

  // Registrierung, Schritt 2: Antwort des Geräts prüfen und speichern
  app.post('/api/me/passkeys', requireAuth, writeLimiter, handler(async (req, res) => {
    const flow = takeFlow(req.body?.flow, 'register', req.user.id);
    let result;
    try {
      result = await verifyRegistrationResponse({
        response: req.body?.response, expectedChallenge: flow.challenge, expectedOrigin: flow.origin, expectedRPID: flow.rp_id,
        requireUserVerification: false,
      });
    } catch { throw bad('Der Passkey konnte nicht geprüft werden.'); }
    if (!result.verified) throw bad('Der Passkey konnte nicht geprüft werden.');
    const { credential, credentialBackedUp } = result.registrationInfo;
    const name = clean(req.body?.name, 60) || guessName(req.get('user-agent'));
    try {
      db.prepare(`INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, name, backed_up, created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(req.user.id, credential.id, Buffer.from(credential.publicKey), credential.counter,
        JSON.stringify(credential.transports ?? []), name, credentialBackedUp ? 1 : 0, Date.now());
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Dieser Passkey ist schon gespeichert.');
      throw e;
    }
    res.status(201).json({ items: list(req.user.id) });
  }));

  app.patch('/api/me/passkeys/:id', requireAuth, writeLimiter, handler((req, res) => {
    const name = clean(req.body?.name, 60);
    if (!name) throw bad('Bitte einen Namen angeben.');
    const r = db.prepare('UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?').run(name, intParam(req.params.id), req.user.id);
    if (!r.changes) throw notFound('Passkey nicht gefunden.');
    res.json({ items: list(req.user.id) });
  }));

  app.delete('/api/me/passkeys/:id', requireAuth, writeLimiter, handler((req, res) => {
    const r = db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(intParam(req.params.id), req.user.id);
    if (!r.changes) throw notFound('Passkey nicht gefunden.');
    res.json({ items: list(req.user.id) });
  }));

  // Anmeldung, Schritt 1: Herausforderung ohne Nutzername (Gerät zeigt passende Passkeys an)
  app.post('/api/login/passkey/options', authLimiter, handler(async (req, res) => {
    const rp = relyingParty(req);
    const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'preferred', allowCredentials: [] });
    res.json({ flow: newFlow('login', null, options.challenge, rp), options });
  }));

  // Anmeldung, Schritt 2
  app.post('/api/login/passkey', authLimiter, handler(async (req, res) => {
    const flow = takeFlow(req.body?.flow, 'login');
    const response = req.body?.response;
    const credId = typeof response?.id === 'string' ? response.id : '';
    const pk = credId ? db.prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(credId) : null;
    const fail = () => new HttpError(401, 'Dieser Passkey ist hier nicht (mehr) hinterlegt oder ungültig.');
    if (!pk) throw fail();
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response, expectedChallenge: flow.challenge, expectedOrigin: flow.origin, expectedRPID: flow.rp_id,
        credential: { id: pk.credential_id, publicKey: new Uint8Array(pk.public_key), counter: pk.counter, transports: parseTransports(pk.transports) },
        requireUserVerification: false,
      });
    } catch { throw fail(); }
    if (!result.verified) throw fail();
    // userHandle muss (falls mitgeschickt) zum Konto passen
    const owner = db.prepare('SELECT webauthn_id, disabled FROM users WHERE id = ?').get(pk.user_id);
    if (response.response?.userHandle && response.response.userHandle !== owner.webauthn_id) throw fail();
    if (owner.disabled) throw new HttpError(403, 'Dieses Konto wurde gesperrt.');
    const info = result.authenticationInfo;
    db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ?, backed_up = ? WHERE id = ?')
      .run(info.newCounter, Date.now(), info.credentialBackedUp ? 1 : 0, pk.id);
    // Ohne Nutzer-Verifizierung (z. B. Sicherheitsschlüssel ohne PIN) zählt der Passkey nur als ein Faktor
    if (!info.userVerified && ctx.twoFactorRequired?.(pk.user_id)) {
      return res.json({ twoFactor: true, ticket: ctx.createLoginTicket(pk.user_id) });
    }
    if (req.sessionToken) destroySession(req.sessionToken);
    sendSession(res, userInfo(pk.user_id), createSession(pk.user_id));
  }));
}
