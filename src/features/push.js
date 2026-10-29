// Web-Push: Benachrichtigungen aufs Gerät (auch bei geschlossener App).
// Aktiv, wenn VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY gesetzt sind (Schlüssel erzeugen: npm run vapid).
import webpush from 'web-push';
import { bad, handler } from '../util.js';
import { tr } from '../i18n.js';

// Nur an bekannte Push-Dienste senden – sonst könnte man den Server Anfragen an beliebige Adressen schicken lassen (SSRF)
const ALLOWED_HOSTS = [
  /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];
export const isAllowedEndpoint = (endpoint) => {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && ALLOWED_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
};
const B64URL = /^[A-Za-z0-9_-]+=*$/;

export function registerPush(app, ctx) {
  const { db, requireAuth, writeLimiter, onNotify } = ctx;
  const publicKey = process.env.VAPID_PUBLIC_KEY, privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@localhost';
  const send = ctx.pushSender ?? (publicKey && privateKey
    ? (sub, payload) => webpush.sendNotification(sub, payload, { vapidDetails: { subject, publicKey, privateKey }, TTL: 24 * 3600 })
    : null);
  ctx.pushEnabled = !!send;
  ctx.pushKey = publicKey ?? 'test-key';

  app.get('/api/push', requireAuth, (req, res) => {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(req.user.id);
    res.json({ enabled: !!send, publicKey: send ? ctx.pushKey : null, devices: n });
  });

  app.post('/api/push/subscribe', requireAuth, writeLimiter, handler((req, res) => {
    if (!send) throw bad('Push ist auf diesem Server nicht eingerichtet.');
    const sub = req.body?.subscription;
    const endpoint = String(sub?.endpoint ?? ''), p256dh = String(sub?.keys?.p256dh ?? ''), auth = String(sub?.keys?.auth ?? '');
    if (endpoint.length > 1000 || !isAllowedEndpoint(endpoint)) throw bad('Unbekannter Push-Dienst.');
    if (!B64URL.test(p256dh) || p256dh.length > 200 || !B64URL.test(auth) || auth.length > 64) throw bad('Ungültige Push-Schlüssel.');
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(req.user.id);
    if (n >= 10 && !db.prepare('SELECT 1 FROM push_subscriptions WHERE endpoint = ?').get(endpoint)) throw bad('Höchstens 10 Geräte pro Konto.');
    // Gleiches Gerät (endpoint) gehört immer dem zuletzt angemeldeten Nutzer
    db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?)
                ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
      .run(req.user.id, endpoint, p256dh, auth, Date.now());
    res.status(201).json({ ok: true });
  }));

  app.delete('/api/push/subscribe', requireAuth, writeLimiter, handler((req, res) => {
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(req.user.id, String(req.body?.endpoint ?? ''));
    res.json({ ok: true });
  }));

  // Kurze Texte für die Benachrichtigung auf dem Sperrbildschirm
  const TEXT = {
    mention: '@{0} hat dich in einem Zitat markiert', share: '@{0} hat ein Zitat mit dir geteilt',
    group_add: '@{0} hat dich zur Gruppe „{1}“ hinzugefügt', comment: '@{0} hat dein Zitat kommentiert',
    comment_mention: '@{0} hat dich in einem Kommentar erwähnt', follow: '@{0} folgt dir jetzt',
    group_owner: '@{0} hat dir die Gruppe „{1}“ übertragen', group_join: '@{0} ist „{1}“ beigetreten',
    suggestion: '@{0} schlägt eine Korrektur vor', suggestion_accepted: '@{0} hat deine Korrektur übernommen',
    suggestion_rejected: '@{0} hat deine Korrektur nicht übernommen',
  };

  const deliver = async (uid, payload) => {
    const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(uid);
    await Promise.all(subs.map(async (s) => {
      try {
        await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
      } catch (e) {
        // Abo abgelaufen/abgemeldet -> entfernen
        if (e?.statusCode === 404 || e?.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
        else console.warn('[push]', e?.statusCode ?? '', e?.message ?? e);
      }
    }));
  };
  ctx.deliverPush = deliver;

  onNotify((uid, type, actorId, { quoteId, groupId }) => {
    if (!send) return;
    const lang = db.prepare('SELECT lang FROM users WHERE id = ?').get(uid)?.lang;
    const actor = db.prepare('SELECT username FROM users WHERE id = ?').get(actorId)?.username ?? tr(lang, 'Jemand');
    const group = groupId ? db.prepare('SELECT name FROM user_groups WHERE id = ?').get(groupId)?.name ?? '' : '';
    const quote = quoteId ? db.prepare('SELECT text, person FROM quotes WHERE id = ?').get(quoteId) : null;
    const title = tr(lang, TEXT[type] ?? 'Neues von @{0}', actor, group);
    const body = quote ? `„${quote.text.slice(0, 120)}${quote.text.length > 120 ? '…' : ''}“ — ${quote.person}` : '';
    deliver(uid, { title, body, url: '/?notifications=1', tag: `${type}-${quoteId ?? groupId ?? actorId}` }).catch(() => {});
  });

  // Test-Benachrichtigung an die eigenen Geräte
  app.post('/api/push/test', requireAuth, writeLimiter, handler(async (req, res) => {
    if (!send) throw bad('Push ist auf diesem Server nicht eingerichtet.');
    await deliver(req.user.id, { title: 'Quotes', body: tr(req.user.lang, 'So sehen Benachrichtigungen aus ✓'), url: '/' });
    res.json({ ok: true });
  }));
}
