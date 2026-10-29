// E-Mail-Adresse (bestätigt) + Wochenrückblick per Mail.
// Aktiv, wenn SMTP_URL (z. B. smtp://user:pass@mail.example.com:587) und PUBLIC_URL gesetzt sind.
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import nodemailer from 'nodemailer';
import { bad, clean, handler, escapeHtml } from '../util.js';

const DAY = 86_400_000;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

export function registerEmail(app, ctx) {
  const { db, requireAuth, authLimiter, writeLimiter, publicUrl, ACCESS } = ctx;
  const mailer = ctx.mailer === undefined ? (process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null) : ctx.mailer;
  const from = process.env.MAIL_FROM || `Quotes <no-reply@${publicUrl ? new URL(publicUrl).hostname : 'localhost'}>`;
  const enabled = !!mailer && !!publicUrl;
  ctx.emailEnabled = enabled;
  if (mailer && !publicUrl) console.warn('[email] SMTP konfiguriert, aber PUBLIC_URL fehlt – E-Mails deaktiviert.');

  // Geheimnis für Abmeldelinks (einmalig zufällig erzeugt und gespeichert)
  let secret = db.prepare("SELECT value FROM settings WHERE key = 'secret'").get()?.value;
  if (!secret) { secret = randomBytes(32).toString('hex'); db.prepare("INSERT INTO settings (key, value) VALUES ('secret', ?)").run(secret); }
  const unsubToken = (uid) => createHmac('sha256', secret).update(`digest:${uid}`).digest('base64url');

  const send = (to, subject, text, html) => mailer.sendMail({ from, to, subject, text, html });
  const layout = (title, inner) => `<!doctype html><html lang="de"><body style="margin:0;background:#f5f5f5;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0a0a0a">
<div style="max-width:560px;margin:0 auto;padding:32px 20px"><div style="font-family:Georgia,serif;font-size:22px;font-weight:700;margin-bottom:20px">“ Quotes</div>
<div style="background:#fff;border:1px solid #e3e3e3;border-radius:14px;padding:24px"><h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 16px">${escapeHtml(title)}</h1>${inner}</div></div></body></html>`;
  const button = (href, label) => `<p style="margin:24px 0 8px"><a href="${escapeHtml(href)}" style="background:#0a0a0a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:600;display:inline-block">${escapeHtml(label)}</a></p>`;

  app.get('/api/me/email', requireAuth, (req, res) => {
    const u = db.prepare('SELECT email, email_verified, digest FROM users WHERE id = ?').get(req.user.id);
    res.json({ enabled, email: u.email ?? null, verified: !!u.email_verified, digest: !!u.digest });
  });

  // Adresse setzen/ändern -> Bestätigungsmail; leer = entfernen
  app.put('/api/me/email', requireAuth, authLimiter, handler(async (req, res) => {
    if (!enabled) throw bad('E-Mail ist auf diesem Server nicht eingerichtet.');
    const email = clean(req.body?.email ?? '', 254).toLowerCase();
    if (!email) {
      db.prepare('UPDATE users SET email = NULL, email_verified = 0, digest = 0, email_token_hash = NULL WHERE id = ?').run(req.user.id);
      return res.json({ email: null, verified: false, digest: false });
    }
    if (email.length > 254 || !EMAIL_RE.test(email)) throw bad('Bitte eine gültige E-Mail-Adresse angeben.');
    const token = randomBytes(32).toString('base64url');
    db.prepare('UPDATE users SET email = ?, email_verified = 0, email_token_hash = ?, email_token_expires = ? WHERE id = ?')
      .run(email, sha256(token), Date.now() + DAY, req.user.id);
    const link = `${publicUrl}/api/email/verify?token=${token}`;
    await send(email, 'Bitte bestätige deine E-Mail-Adresse',
      `Hallo @${req.user.username},\n\nbitte bestätige deine Adresse für Quotes:\n${link}\n\nDer Link ist 24 Stunden gültig. Wenn du das nicht warst, ignoriere diese Mail.`,
      layout('E-Mail bestätigen', `<p>Hallo @${escapeHtml(req.user.username)},</p><p>bitte bestätige deine Adresse für Quotes.</p>${button(link, 'Adresse bestätigen')}<p style="color:#6f6f6f;font-size:13px">Der Link ist 24 Stunden gültig. Wenn du das nicht warst, ignoriere diese Mail.</p>`));
    res.json({ email, verified: false, digest: !!db.prepare('SELECT digest FROM users WHERE id = ?').get(req.user.id).digest });
  }));

  // Bestätigungslink (aus der Mail, ohne Login nötig – das Token ist der Nachweis)
  app.get('/api/email/verify', authLimiter, (req, res) => {
    const token = String(req.query.token ?? '');
    const u = /^[A-Za-z0-9_-]{43}$/.test(token)
      ? db.prepare('SELECT id, email_token_expires FROM users WHERE email_token_hash = ?').get(sha256(token)) : null;
    if (!u || u.email_token_expires < Date.now()) return res.redirect(302, '/?email=invalid');
    db.prepare('UPDATE users SET email_verified = 1, email_token_hash = NULL, email_token_expires = NULL WHERE id = ?').run(u.id);
    res.redirect(302, '/?email=verified');
  });

  app.put('/api/me/digest', requireAuth, writeLimiter, handler((req, res) => {
    const on = req.body?.enabled === true;
    const u = db.prepare('SELECT email_verified FROM users WHERE id = ?').get(req.user.id);
    if (on && !u.email_verified) throw bad('Bitte zuerst deine E-Mail-Adresse bestätigen.');
    db.prepare('UPDATE users SET digest = ? WHERE id = ?').run(on ? 1 : 0, req.user.id);
    res.json({ digest: on });
  }));

  // Abmelden mit einem Klick aus der Mail (ohne Login)
  app.get('/api/digest/unsubscribe', (req, res) => {
    const uid = Number(req.query.u), t = String(req.query.t ?? '');
    const expected = Number.isSafeInteger(uid) ? unsubToken(uid) : '';
    const ok = expected && t.length === expected.length && timingSafeEqual(Buffer.from(t), Buffer.from(expected));
    if (ok) db.prepare('UPDATE users SET digest = 0 WHERE id = ?').run(uid);
    res.redirect(302, ok ? '/?digest=off' : '/?digest=invalid');
  });

  /** Wochenrückblick an alle fälligen Nutzer senden (stündlich vom Server aufgerufen). */
  ctx.runDigest = async (now = Date.now()) => {
    if (!enabled) return { sent: 0 };
    const due = db.prepare(`SELECT id, username, email FROM users WHERE digest = 1 AND email_verified = 1 AND disabled = 0
                            AND email IS NOT NULL AND (last_digest_at IS NULL OR last_digest_at <= ?)`).all(now - 7 * DAY + 3600_000);
    let sent = 0;
    for (const u of due) {
      db.prepare('UPDATE users SET last_digest_at = ? WHERE id = ?').run(now, u.id); // vorab: nie doppelt senden
      const since = now - 7 * DAY;
      const p = { me: u.id, since };
      const unread = db.prepare(`SELECT n.type, a.username AS actor FROM notifications n JOIN users a ON a.id = n.actor_id
                                 WHERE n.user_id = @me AND n.read_at IS NULL AND n.created_at > @since
                                 AND (n.quote_id IS NULL OR EXISTS(SELECT 1 FROM quotes q WHERE q.id = n.quote_id AND ${ACCESS}))
                                 ORDER BY n.created_at DESC LIMIT 50`).all(p);
      const followed = db.prepare(`SELECT q.text, q.person, u.username AS author FROM quotes q JOIN users u ON u.id = q.user_id
                                   WHERE q.created_at > @since AND q.user_id IN (SELECT followee_id FROM follows WHERE follower_id = @me)
                                   AND ${ACCESS} ORDER BY (SELECT COUNT(*) FROM likes l WHERE l.quote_id = q.id) DESC, q.created_at DESC LIMIT 3`).all(p);
      const top = db.prepare(`SELECT q.text, q.person FROM quotes q WHERE q.visibility = 'public' AND q.created_at > @since
                              ORDER BY (SELECT COUNT(*) FROM likes l WHERE l.quote_id = q.id) DESC, q.created_at DESC LIMIT 1`).get({ since });
      if (!unread.length && !followed.length && !top) continue; // nichts zu berichten -> keine Mail
      const unsub = `${publicUrl}/api/digest/unsubscribe?u=${u.id}&t=${unsubToken(u.id)}`;
      const quoteHtml = (q) => `<blockquote style="margin:12px 0;padding:4px 0 4px 14px;border-left:3px solid #0a0a0a;font-family:Georgia,serif;font-size:17px">„${escapeHtml(q.text)}“<br><span style="font-family:-apple-system,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase">— ${escapeHtml(q.person)}</span></blockquote>`;
      const parts = [], text = [`Hallo @${u.username}, dein Wochenrückblick:`];
      if (unread.length) {
        parts.push(`<p><b>${unread.length} ungelesene Benachrichtigung${unread.length === 1 ? '' : 'en'}</b> – u. a. von ${escapeHtml([...new Set(unread.map((x) => `@${x.actor}`))].slice(0, 3).join(', '))}.</p>`);
        text.push(`${unread.length} ungelesene Benachrichtigungen.`);
      }
      if (followed.length) {
        parts.push(`<p><b>Neu von Leuten, denen du folgst</b></p>${followed.map(quoteHtml).join('')}`);
        text.push('Neu von Leuten, denen du folgst:', ...followed.map((q) => `„${q.text}“ — ${q.person} (@${q.author})`));
      }
      if (top) { parts.push(`<p><b>Zitat der Woche</b></p>${quoteHtml(top)}`); text.push(`Zitat der Woche: „${top.text}“ — ${top.person}`); }
      text.push('', `Öffnen: ${publicUrl}/`, `Abmelden: ${unsub}`);
      try {
        await send(u.email, 'Dein Wochenrückblick bei Quotes', text.join('\n'),
          layout(`Hallo @${u.username}`, parts.join('') + button(`${publicUrl}/`, 'Quotes öffnen')
            + `<p style="color:#6f6f6f;font-size:12px;margin-top:24px">Du bekommst diese Mail, weil du den Wochenrückblick aktiviert hast. <a href="${escapeHtml(unsub)}" style="color:#6f6f6f">Abmelden</a></p>`));
        sent++;
      } catch (e) { console.warn('[digest]', e.message); }
    }
    return { sent };
  };
}
