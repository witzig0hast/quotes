import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startApp, clientFactory, quote } from './helpers.js';
import { isPrivateIp, validateWebhookUrl, safeLookup } from '../src/features/integrations.js';

const deliveries = [];
let failNext = 0;
const webhookSender = async (url, body, headers) => {
  if (failNext > 0) { failNext--; return { ok: false, status: '500' }; }
  deliveries.push({ url, body: JSON.parse(body), raw: body, headers }); return { ok: true, status: '200' };
};
let app, signup, Client;
before(() => { app = startApp({ webhookSender }); ({ signup, Client } = clientFactory(app.base)); });
after(() => app.server.close());
const PW = 'correct-horse-battery';
const tick = () => new Promise((r) => setTimeout(r, 30));
const v1 = (token, method, path, body) => fetch(app.base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('SSRF-Schutz: private/interne Adressen werden erkannt und abgelehnt', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111']) assert.ok(!isPrivateIp(ip), ip);
  for (const u of ['http://example.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://169.254.169.254/latest',
    'https://user:pw@example.com/', 'https://ha.local/x', 'ftp://example.com']) assert.throws(() => validateWebhookUrl(u), u);
  assert.ok(validateWebhookUrl('https://hooks.slack.com/services/T/B/x'));
  assert.ok(validateWebhookUrl('http://192.168.1.10:8123/api/webhook/x', { allowPrivate: true })); // Home Assistant im LAN, nur wenn erlaubt
  // DNS-Ebene: Name, der auf eine interne Adresse auflöst, wird beim Verbinden blockiert
  const err = await new Promise((r) => safeLookup(false)('localhost', {}, (e) => r(e)));
  assert.equal(err?.code, 'EPRIVATE');
});

test('API-Schlüssel: nur mit Passwort, einmal sichtbar, Lese-/Schreibrecht, Cookies reichen nicht', async () => {
  const a = await signup(), b = await signup();
  await a.req('POST', '/api/quotes', quote({ text: 'a privat' }));
  const bPriv = (await b.req('POST', '/api/quotes', quote({ text: 'b privat' }))).data;
  await b.req('POST', '/api/quotes', quote({ text: 'b öffentlich', visibility: 'public' }));
  assert.equal((await a.req('POST', '/api/me/keys', { name: 'x', password: 'falsch-falsch' })).status, 403);
  const rk = (await a.req('POST', '/api/me/keys', { name: 'Home Assistant', scope: 'read', password: PW })).data;
  assert.match(rk.token, /^qk_[A-Za-z0-9_-]{43}$/);
  const list = (await a.get('/api/me/keys')).keys;
  assert.equal(list[0].prefix, rk.token.slice(0, 10)); assert.ok(!JSON.stringify(list).includes(rk.token));
  assert.equal((await v1(null, 'GET', '/api/v1/me')).status, 401);
  assert.equal((await v1('qk_' + 'x'.repeat(43), 'GET', '/api/v1/me')).status, 401);
  // Sitzungs-Cookie allein öffnet /api/v1 nicht
  assert.equal((await fetch(app.base + '/api/v1/me', { headers: { cookie: a.cookie } })).status, 401);
  assert.equal((await (await v1(rk.token, 'GET', '/api/v1/me')).json()).username, a.name);
  assert.deepEqual((await (await v1(rk.token, 'GET', '/api/v1/quotes?scope=mine')).json()).quotes.map((q) => q.text), ['a privat']);
  assert.deepEqual((await (await v1(rk.token, 'GET', '/api/v1/quotes')).json()).quotes.map((q) => q.text), ['b öffentlich']);
  assert.equal((await v1(rk.token, 'GET', `/api/v1/quotes/${bPriv.id}`)).status, 404);
  const txt = await (await v1(rk.token, 'GET', '/api/v1/daily?format=text')).text();
  assert.equal(txt, '„b öffentlich“ — Jemand');
  assert.equal((await v1(rk.token, 'POST', '/api/v1/quotes', quote({ text: 'per API' }))).status, 403);
  // Schreibrecht: kein CSRF-Token nötig (keine Cookies), Markieren/Teilen über API ignoriert
  const wk = (await a.req('POST', '/api/me/keys', { name: 'Kurzbefehl', scope: 'write', password: PW })).data;
  const created = await v1(wk.token, 'POST', '/api/v1/quotes', { ...quote({ text: 'per API gespeichert' }), mentions: [b.name], visibility: 'shared', shareWith: [b.name] });
  assert.equal(created.status, 201);
  const cq = await created.json();
  assert.deepEqual([cq.visibility, cq.mentions], ['private', []]);
  // Gesperrtes Konto / gelöschter Schlüssel -> 401
  await a.req('DELETE', `/api/me/keys/${wk.id}`);
  assert.equal((await v1(wk.token, 'GET', '/api/v1/me')).status, 401);
  app.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(a.id);
  assert.equal((await v1(rk.token, 'GET', '/api/v1/me')).status, 401);
  app.db.prepare('UPDATE users SET disabled = 0 WHERE id = ?').run(a.id);
});

test('Webhooks: signiert, nur Sichtbares, Slack-Format, Deaktivierung nach Fehlern', async () => {
  const a = await signup(), b = await signup();
  assert.equal((await a.req('POST', '/api/me/webhooks', { url: 'https://example.com/hook', events: ['quote.created'], password: 'falsch-falsch' })).status, 403);
  assert.equal((await a.req('POST', '/api/me/webhooks', { url: 'https://10.0.0.5/hook', events: ['quote.created'], password: PW })).status, 400);
  assert.equal((await a.req('POST', '/api/me/webhooks', { url: 'https://example.com/hook', events: [], password: PW })).status, 400);
  const w = (await a.req('POST', '/api/me/webhooks', { url: 'https://example.com/hook', events: ['quote.created', 'notification'], password: PW })).data;
  assert.ok(w.secret);
  assert.ok(!JSON.stringify((await a.get('/api/me/webhooks')).webhooks).includes(w.secret)); // Secret nur einmal
  deliveries.length = 0;
  await a.req('POST', '/api/quotes', quote({ text: 'webhook!' }));
  await tick();
  assert.equal(deliveries.length, 1);
  const d = deliveries[0];
  assert.equal(d.headers['X-Quotes-Event'], 'quote.created');
  assert.equal(d.body.data.quote.text, 'webhook!');
  assert.equal(d.headers['X-Quotes-Signature'], `sha256=${createHmac('sha256', w.secret).update(d.raw).digest('hex')}`);
  // Benachrichtigung: b markiert a in privatem Zitat -> a sieht es (markiert), Webhook enthält es
  deliveries.length = 0;
  await b.req('POST', '/api/quotes', quote({ text: 'für a', mentions: [a.name] }));
  await tick();
  assert.equal(deliveries[0].body.event, 'notification');
  assert.equal(deliveries[0].body.data.type, 'mention'); assert.equal(deliveries[0].body.data.quote.text, 'für a');
  // Slack-Format
  const s = (await a.req('POST', '/api/me/webhooks', { url: 'https://hooks.slack.com/services/x', events: ['quote.created'], format: 'slack', password: PW })).data;
  deliveries.length = 0;
  await a.req('POST', '/api/quotes', quote({ text: 'slack', person: 'P' }));
  await tick();
  assert.deepEqual(deliveries.find((x) => x.url.includes('slack')).body, { text: 'Neues Zitat: „slack“ — P' });
  // Test-Endpunkt + Deaktivierung nach 10 Fehlern in Folge
  assert.equal((await a.req('POST', `/api/me/webhooks/${s.id}/test`)).data.ok, true);
  failNext = 10;
  for (let i = 0; i < 10; i++) await a.req('POST', `/api/me/webhooks/${s.id}/test`);
  const hook = (await a.get('/api/me/webhooks')).webhooks.find((x) => x.id === s.id);
  assert.deepEqual([hook.active, hook.failures], [false, 10]);
  assert.match(hook.lastStatus, /Fehler/);
  assert.equal((await b.req('POST', `/api/me/webhooks/${s.id}/test`)).status, 404); // fremder Webhook
  void Client;
});
