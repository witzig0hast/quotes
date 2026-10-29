import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { startApp, clientFactory, quote } from './helpers.js';
import EN from '../public/i18n-en.js';
import { tr } from '../src/i18n.js';

let app, signup;
before(() => { app = startApp(); ({ signup } = clientFactory(app.base)); });
after(() => app.server.close());

test('Zitate: Originalsprache und Übersetzung speichern, suchen, exportieren', async () => {
  const a = await signup();
  const r = await a.req('POST', '/api/quotes', quote({ text: 'Stay hungry, stay foolish.', person: 'Steve Jobs', lang: 'en', translation: 'Bleib hungrig, bleib verrückt.' }));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.lang, 'en'); assert.equal(r.data.translation, 'Bleib hungrig, bleib verrückt.');
  // Suche findet auch die Übersetzung
  assert.equal((await a.get('/api/quotes?scope=mine&q=verrückt')).quotes.length, 1);
  // Ungültige Sprache / zu lange Übersetzung
  assert.equal((await a.req('POST', '/api/quotes', quote({ lang: 'english' }))).status, 400);
  assert.equal((await a.req('POST', '/api/quotes', quote({ translation: 'x'.repeat(1001) }))).status, 400);
  // Bearbeiten: Übersetzung entfernen
  const up = await a.req('PUT', `/api/quotes/${r.data.id}`, quote({ text: 'Stay hungry, stay foolish.', person: 'Steve Jobs', lang: 'en', translation: '' }));
  assert.equal(up.data.translation, null); assert.equal(up.data.lang, 'en');
  // Export enthält die Felder; Import liest sie wieder ein
  const ex = JSON.parse(await (await fetch(`${app.base}/api/export?format=json`, { headers: { cookie: a.cookie } })).text());
  assert.equal(ex.quotes[0].lang, 'en');
  const b = await signup();
  const imp = await b.req('POST', '/api/import', { format: 'json', content: JSON.stringify([{ text: 'La vie est belle.', person: 'Jemand', lang: 'fr', translation: 'Das Leben ist schön.' }]) });
  assert.equal(imp.data.imported, 1);
  const got = (await b.get('/api/quotes?scope=mine')).quotes[0];
  assert.equal(got.lang, 'fr'); assert.equal(got.translation, 'Das Leben ist schön.');
});

test('Sprache pro Nutzer: speichern, in /api/me, ungültige Werte abgelehnt', async () => {
  const a = await signup();
  assert.equal((await a.get('/api/me')).user.lang, null);
  assert.equal((await a.req('PUT', '/api/me/lang', { lang: 'xx' })).status, 400);
  assert.equal((await a.req('PUT', '/api/me/lang', { lang: 'en' })).status, 200);
  assert.equal((await a.get('/api/me')).user.lang, 'en');
});

test('Push-Texte in der Sprache des Empfängers', async () => {
  const sent = [];
  const local = startApp({ pushSender: async (sub, payload) => { sent.push(JSON.parse(payload)); } });
  try {
    const { signup: su } = clientFactory(local.base);
    const a = await su(), b = await su();
    local.db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, 'https://fcm.googleapis.com/x', 'k', 'a', 0)").run(b.id);
    await b.req('PUT', '/api/me/lang', { lang: 'en' });
    await a.req('POST', `/api/users/${b.name}/follow`);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(sent.some((p) => p.title === `@${a.name} is now following you`), JSON.stringify(sent));
  } finally { local.server.close(); }
});

test('Wörterbuch: jeder t()-Text im Frontend hat eine englische Übersetzung mit gleichen Platzhaltern', () => {
  const keys = new Set();
  for (const f of readdirSync('public').filter((n) => n.endsWith('.js') && !n.startsWith('i18n'))) {
    for (const m of readFileSync(`public/${f}`, 'utf8').matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'").replace(/\\n/g, '\n').replace(/\\\\/g, '\\'));
  }
  const technical = (k) => /^(GET|POST|curl) |^"|^ui-sans|^“ Quotes$/.test(k);
  const missing = [...keys].filter((k) => !(k in EN) && !technical(k));
  assert.deepEqual(missing, []);
  for (const [k, v] of Object.entries(EN)) {
    const ph = (s) => (s.match(/\{\d\}/g) ?? []).sort().join();
    assert.equal(ph(v), ph(k), `Platzhalter: ${k}`);
  }
  assert.equal(tr('en', 'Hallo @{0}', 'x'), 'Hi @x');
  assert.equal(tr('de', 'Hallo @{0}', 'x'), 'Hallo @x');
});
