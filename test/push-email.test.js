import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, clientFactory, quote } from './helpers.js';
import { isAllowedEndpoint } from '../src/features/push.js';

const pushed = [], mails = [];
let pushFail = null;
const pushSender = async (sub, payload) => { if (pushFail) { const e = new Error('gone'); e.statusCode = pushFail; throw e; } pushed.push({ sub, payload: JSON.parse(payload) }); };
const mailer = { sendMail: async (m) => { mails.push(m); return { messageId: 'x' }; } };
let app, signup, Client, ctxApp;
before(() => {
  app = startApp({ pushSender, mailer, publicUrl: 'https://quotes.example.com' });
  ({ signup, Client } = clientFactory(app.base));
});
after(() => app.server.close());
const FCM = 'https://fcm.googleapis.com/fcm/send/abc123';
const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
const tick = () => new Promise((r) => setTimeout(r, 20));

test('Push-Endpunkte: nur bekannte Push-Dienste über HTTPS (kein SSRF)', () => {
  for (const ok of [FCM, 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/abc', 'https://db5p.notify.windows.com/w/?token=1']) assert.ok(isAllowedEndpoint(ok), ok);
  for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example.com/x', 'https://169.254.169.254/latest', 'https://fcm.googleapis.com.evil.com/x',
    'https://fcm.googleapis.com:8443/x', 'https://localhost/x', 'javascript:alert(1)', '']) assert.ok(!isAllowedEndpoint(bad), bad);
});

test('Push: abonnieren, bei Benachrichtigung senden, abgelaufene Abos aufräumen', async () => {
  const a = await signup(), b = await signup();
  assert.ok((await a.get('/api/config')).push.publicKey);
  assert.equal((await a.req('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://evil.example.com/x', keys } })).status, 400);
  assert.equal((await a.req('POST', '/api/push/subscribe', { subscription: { endpoint: FCM, keys: { p256dh: '<script>', auth: 'x' } } })).status, 400);
  assert.equal((await a.req('POST', '/api/push/subscribe', { subscription: { endpoint: FCM, keys } })).status, 201);
  assert.equal((await a.get('/api/push')).devices, 1);
  pushed.length = 0;
  await b.req('POST', '/api/quotes', quote({ text: 'Für dich, a', mentions: [a.name] }));
  await tick();
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].sub.endpoint, FCM);
  assert.equal(pushed[0].payload.title, `@${b.name} hat dich in einem Zitat markiert`);
  assert.match(pushed[0].payload.body, /Für dich, a/);
  assert.equal(pushed[0].payload.url, '/?notifications=1');
  // Gleiches Gerät meldet sich mit anderem Konto an -> Abo wechselt den Besitzer
  assert.equal((await b.req('POST', '/api/push/subscribe', { subscription: { endpoint: FCM, keys } })).status, 201);
  assert.equal((await a.get('/api/push')).devices, 0);
  // 410 Gone -> Abo wird gelöscht
  pushFail = 410;
  await a.req('POST', '/api/quotes', quote({ text: 'zurück an b', mentions: [b.name] }));
  await tick(); pushFail = null;
  assert.equal((await b.get('/api/push')).devices, 0);
});

test('E-Mail: Bestätigung per Link, Wochenrückblick nur bestätigt + zugestimmt', async () => {
  const a = await signup(), b = await signup();
  assert.equal((await a.get('/api/me/email')).enabled, true);
  assert.equal((await a.req('PUT', '/api/me/email', { email: 'kein-mail' })).status, 400);
  assert.equal((await a.req('PUT', '/api/me/digest', { enabled: true })).status, 400); // noch keine bestätigte Adresse
  mails.length = 0;
  assert.equal((await a.req('PUT', '/api/me/email', { email: 'A@Example.com' })).status, 200);
  assert.equal(mails.length, 1); assert.equal(mails[0].to, 'a@example.com');
  const link = mails[0].text.match(/https:\/\/quotes\.example\.com(\/api\/email\/verify\?token=[A-Za-z0-9_-]+)/)[1];
  const badV = await fetch(`${app.base}/api/email/verify?token=${'x'.repeat(43)}`, { redirect: 'manual' });
  assert.equal(badV.headers.get('location'), '/?email=invalid');
  const okV = await fetch(app.base + link, { redirect: 'manual' });
  assert.equal(okV.headers.get('location'), '/?email=verified');
  assert.equal((await fetch(app.base + link, { redirect: 'manual' })).headers.get('location'), '/?email=invalid'); // einmalig
  assert.equal((await a.get('/api/me/email')).verified, true);
  assert.equal((await a.req('PUT', '/api/me/digest', { enabled: true })).status, 200);

  // Inhalt für den Rückblick: a folgt b, b veröffentlicht (mit HTML im Text), a hat Ungelesenes
  await a.req('POST', `/api/users/${b.name}/follow`);
  await b.req('POST', '/api/quotes', quote({ text: '<script>alert(1)</script> Mut', person: 'B & Co', visibility: 'public', mentions: [a.name] }));
  mails.length = 0;
  const now = Date.now();
  // runDigest über den Kontext der laufenden App aufrufen
  const { sent } = await app.server.ctx.runDigest(now);
  assert.equal(sent, 1); assert.equal(mails[0].to, 'a@example.com');
  assert.ok(mails[0].html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!mails[0].html.includes('<script>'));
  assert.ok(mails[0].html.includes('B &amp; Co'));
  assert.equal((await app.server.ctx.runDigest(now + 3600_000)).sent, 0); // nicht doppelt
  // Abmelden aus der Mail; gefälschtes Token wirkungslos
  const unsub = mails[0].text.match(/https:\/\/quotes\.example\.com(\/api\/digest\/unsubscribe\?u=\d+&t=[A-Za-z0-9_-]+)/)[1];
  assert.equal((await fetch(app.base + unsub.replace(/t=.*/, 't=falsch'), { redirect: 'manual' })).headers.get('location'), '/?digest=invalid');
  assert.equal((await a.get('/api/me/email')).digest, true);
  assert.equal((await fetch(app.base + unsub, { redirect: 'manual' })).headers.get('location'), '/?digest=off');
  assert.equal((await a.get('/api/me/email')).digest, false);
  assert.equal((await app.server.ctx.runDigest(now + 8 * 86_400_000)).sent, 0);
});

test('Ohne Mailserver: E-Mail-Funktion aus', async () => {
  const off = startApp({ mailer: null, publicUrl: null });
  const { signup: s2 } = clientFactory(off.base);
  const u = await s2();
  assert.equal((await u.get('/api/me/email')).enabled, false);
  assert.equal((await u.req('PUT', '/api/me/email', { email: 'x@example.com' })).status, 400);
  assert.equal((await u.get('/api/config')).email, false);
  off.server.close();
  void Client; void ctxApp;
});
