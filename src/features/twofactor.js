// Zwei-Faktor-Anmeldung (TOTP, RFC 6238) mit Wiederherstellungscodes – für Passwort-Konten.
// SSO-Konten nutzen die Zwei-Faktor-Anmeldung ihres Anbieters (z. B. authentik).
import { randomBytes, createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { bad, handler, HttpError } from '../util.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30, DIGITS = 6, WINDOW = 1;

export const base32 = (buf) => {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
};
const unbase32 = (s) => {
  let bits = 0, value = 0; const out = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
};
/** TOTP-Code für einen Zeitschritt */
export function totp(secretB32, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', unbase32(secretB32)).update(msg).digest();
  const off = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(off) & 0x7fffffff) % 10 ** DIGITS).padStart(DIGITS, '0');
}
const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP);
/** Prüft Code im Fenster ±1 Schritt; gibt den Schritt zurück (für Replay-Schutz) oder null */
function matchStep(secret, code, afterStep) {
  if (!/^\d{6}$/.test(code)) return null;
  const now = currentStep();
  for (let s = now - WINDOW; s <= now + WINDOW; s++) {
    if (s <= afterStep) continue; // schon benutzt -> kein zweites Mal
    const a = Buffer.from(totp(secret, s)), b = Buffer.from(code);
    if (timingSafeEqual(a, b)) return s;
  }
  return null;
}
const newRecoveryCodes = () => Array.from({ length: 10 }, () => {
  const n = () => String(randomInt(0, 10_000)).padStart(4, '0');
  return `${n()}-${n()}-${n()}`;
});

export function registerTwoFactor(app, ctx) {
  const { db, requireAuth, authLimiter, writeLimiter, confirmIdentity, sendSession, createSession, destroySession, userInfo, UNUSABLE_HASH } = ctx;
  const user = (id) => db.prepare('SELECT id, username, password_hash, totp_secret, totp_enabled, totp_last_step, recovery_codes FROM users WHERE id = ?').get(id);

  /** Code prüfen: TOTP (mit Replay-Schutz) oder einmaliger Wiederherstellungscode */
  function checkCode(u, raw) {
    const code = String(raw ?? '').trim().replace(/\s+/g, '');
    const step = matchStep(u.totp_secret, code, u.totp_last_step);
    if (step !== null) { db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, u.id); return 'totp'; }
    if (/^\d{4}-?\d{4}-?\d{4}$/.test(code)) {
      const norm = code.replace(/-/g, '').replace(/(\d{4})(\d{4})(\d{4})/, '$1-$2-$3');
      const list = JSON.parse(u.recovery_codes ?? '[]');
      const i = list.indexOf(sha256(norm));
      if (i >= 0) { list.splice(i, 1); db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(list), u.id); return 'recovery'; }
    }
    return null;
  }

  ctx.twoFactorRequired = (uid) => !!user(uid)?.totp_enabled;
  ctx.createLoginTicket = (uid) => {
    const ticket = randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM login_tickets WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO login_tickets (ticket_hash, user_id, expires_at) VALUES (?,?,?)').run(sha256(ticket), uid, Date.now() + 5 * 60_000);
    return ticket;
  };

  // Zweiter Login-Schritt
  app.post('/api/login/2fa', authLimiter, handler((req, res) => {
    const ticket = String(req.body?.ticket ?? '');
    const t = /^[A-Za-z0-9_-]{43}$/.test(ticket) ? db.prepare('SELECT * FROM login_tickets WHERE ticket_hash = ?').get(sha256(ticket)) : null;
    if (!t || t.expires_at < Date.now() || t.attempts >= 5) {
      if (t) db.prepare('DELETE FROM login_tickets WHERE ticket_hash = ?').run(t.ticket_hash);
      throw new HttpError(401, 'Die Anmeldung ist abgelaufen. Bitte erneut mit Passwort anmelden.');
    }
    const u = user(t.user_id);
    const how = u?.totp_enabled ? checkCode(u, req.body?.code) : null;
    if (!how) {
      db.prepare('UPDATE login_tickets SET attempts = attempts + 1 WHERE ticket_hash = ?').run(t.ticket_hash);
      throw new HttpError(401, 'Code falsch. Bitte den aktuellen Code aus der Authenticator-App eingeben.');
    }
    db.prepare('DELETE FROM login_tickets WHERE ticket_hash = ?').run(t.ticket_hash); // einmalig
    if (db.prepare('SELECT disabled FROM users WHERE id = ?').get(u.id).disabled) throw new HttpError(403, 'Dieses Konto wurde gesperrt.');
    if (req.sessionToken) destroySession(req.sessionToken);
    const left = JSON.parse(user(u.id).recovery_codes ?? '[]').length;
    sendSession(res, { ...userInfo(u.id), ...(how === 'recovery' ? { recoveryCodesLeft: left } : {}) }, createSession(u.id));
  }));

  app.get('/api/me/2fa', requireAuth, (req, res) => {
    const u = user(req.user.id);
    res.json({ available: u.password_hash !== UNUSABLE_HASH, enabled: !!u.totp_enabled, recoveryLeft: u.totp_enabled ? JSON.parse(u.recovery_codes ?? '[]').length : 0 });
  });

  // Einrichtung starten: neues Geheimnis (noch nicht aktiv) + QR-Code
  app.post('/api/me/2fa/setup', requireAuth, writeLimiter, handler(async (req, res) => {
    const u = user(req.user.id);
    if (u.password_hash === UNUSABLE_HASH) throw bad('Für SSO-Konten richtest du die Zwei-Faktor-Anmeldung bei deinem Anbieter ein.');
    if (u.totp_enabled) throw bad('Zwei-Faktor ist bereits aktiv.');
    await confirmIdentity(req);
    const secret = base32(randomBytes(20));
    db.prepare('UPDATE users SET totp_secret = ?, totp_last_step = 0 WHERE id = ?').run(secret, u.id);
    const issuer = 'Quotes';
    const uri = `otpauth://totp/${encodeURIComponent(`${issuer}:${u.username}`)}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
    const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0a0a0a', light: '#ffffff' } });
    res.json({ secret, uri, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` });
  }));

  // Aktivieren mit erstem Code -> Wiederherstellungscodes (nur jetzt im Klartext)
  app.post('/api/me/2fa/enable', requireAuth, writeLimiter, handler((req, res) => {
    const u = user(req.user.id);
    if (!u.totp_secret || u.totp_enabled) throw bad('Bitte die Einrichtung neu starten.');
    const step = matchStep(u.totp_secret, String(req.body?.code ?? '').trim(), 0);
    if (step === null) throw bad('Code stimmt nicht. Uhrzeit des Handys prüfen und den aktuellen Code eingeben.');
    const codes = newRecoveryCodes();
    db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ?, recovery_codes = ? WHERE id = ?').run(step, JSON.stringify(codes.map(sha256)), u.id);
    // Andere Sitzungen abmelden (falls jemand anderes eingeloggt war), aktuelle behalten
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(u.id, sha256(req.sessionToken));
    res.json({ enabled: true, recoveryCodes: codes });
  }));

  app.post('/api/me/2fa/recovery', requireAuth, writeLimiter, handler(async (req, res) => {
    const u = user(req.user.id);
    if (!u.totp_enabled) throw bad('Zwei-Faktor ist nicht aktiv.');
    await confirmIdentity(req);
    const codes = newRecoveryCodes();
    db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(codes.map(sha256)), u.id);
    res.json({ recoveryCodes: codes });
  }));

  // Ausschalten: Passwort + gültiger Code (oder Wiederherstellungscode)
  app.post('/api/me/2fa/disable', requireAuth, writeLimiter, handler(async (req, res) => {
    const u = user(req.user.id);
    if (!u.totp_enabled) throw bad('Zwei-Faktor ist nicht aktiv.');
    await confirmIdentity(req);
    if (!checkCode(u, req.body?.code)) throw bad('Code falsch.');
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL, totp_last_step = 0 WHERE id = ?').run(u.id);
    res.json({ enabled: false });
  }));
}
