import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

let server, base;
before(() => {
  // Viele Registrierungen in dieser Datei -> Auth-Limit anheben (Standard 20 wird in api.test.js geprüft)
  server = createApp({ db: openDb(':memory:'), secureCookies: false, authLimit: 1000 }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

class Client {
  cookie = ''; csrf = '';
  async req(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}) },
      body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const data = await res.json().catch(() => ({}));
    if (data.csrf) this.csrf = data.csrf;
    return { status: res.status, data, headers: res.headers };
  }
  get = (p) => this.req('GET', p).then((r) => r.data);
}
let n = 0;
const signup = async (name = `user${++n}`) => {
  const c = new Client(); c.name = name;
  const r = await c.req('POST', '/api/register', { username: name, password: 'correct-horse-battery' });
  assert.equal(r.status, 201, JSON.stringify(r.data)); c.id = r.data.user.id;
  return c;
};
const quote = (o = {}) => ({ text: 'Zitat', person: 'Jemand', source: '', visibility: 'private', ...o });
const texts = async (c, qs) => (await c.get(`/api/quotes?${qs}`)).quotes.map((q) => q.text);

test('Benutzername ändern: Validierung, Konflikt, Markierungen bleiben erhalten', async () => {
  const a = await signup('renamer'); const b = await signup('taken');
  assert.equal((await a.req('PUT', '/api/me/username', { username: 'x' })).status, 400);
  assert.equal((await a.req('PUT', '/api/me/username', { username: 'TAKEN' })).status, 409);
  const q = (await b.req('POST', '/api/quotes', quote({ text: 'für renamer', mentions: ['renamer'] }))).data;
  assert.equal((await a.req('PUT', '/api/me/username', { username: 'Neuer.Name' })).status, 200);
  assert.equal((await a.get('/api/me')).user.username, 'Neuer.Name');
  assert.deepEqual((await b.get(`/api/quotes/${q.id}`)).mentions, ['Neuer.Name']); // Markierung hängt an der ID
  assert.equal((await a.req('PUT', '/api/me/username', { username: 'neuer.name' })).status, 200); // eigene Groß-/Kleinschreibung ändern
  // Login mit neuem Namen
  const c = new Client();
  assert.equal((await c.req('POST', '/api/login', { username: 'neuer.name', password: 'correct-horse-battery' })).status, 200);
});

test('Markieren: Markierte sehen auch private Zitate, werden benachrichtigt, nur bei neuen Markierungen', async () => {
  const alice = await signup(), bob = await signup(), carol = await signup();
  assert.equal((await alice.req('POST', '/api/quotes', quote({ mentions: ['gibtsnicht'] }))).status, 400);
  const q = (await alice.req('POST', '/api/quotes', quote({ text: 'privat mit Markierung', mentions: [`@${bob.name}`, alice.name] }))).data;
  assert.deepEqual(q.mentions, [bob.name]); // sich selbst markieren wird ignoriert
  assert.deepEqual(await texts(bob, 'scope=shared'), ['privat mit Markierung']);
  assert.deepEqual(await texts(carol, 'scope=shared'), []);
  assert.equal((await carol.req('GET', `/api/quotes/${q.id}`)).status, 404);

  let nb = await bob.get('/api/notifications');
  assert.equal(nb.unread, 1);
  assert.deepEqual([nb.items[0].type, nb.items[0].actor, nb.items[0].quoteId], ['mention', alice.name, q.id]);
  assert.equal((await alice.get('/api/notifications')).unread, 0);
  // Erneut speichern (Bob weiterhin markiert) + Carol neu -> Bob keine zweite Nachricht, Carol eine
  await alice.req('PUT', `/api/quotes/${q.id}`, quote({ text: 'geändert', mentions: [bob.name, carol.name] }));
  assert.equal((await bob.get('/api/notifications')).unread, 1);
  assert.equal((await carol.get('/api/notifications')).unread, 1);
  // Gelesen markieren
  await bob.req('POST', '/api/notifications/read');
  nb = await bob.get('/api/notifications');
  assert.equal(nb.unread, 0); assert.equal(nb.items[0].read, true);
  // Markierung entfernt -> Zugriff und Benachrichtigung weg
  await alice.req('PUT', `/api/quotes/${q.id}`, quote({ text: 'geändert', mentions: [] }));
  assert.equal((await carol.get('/api/notifications')).items.length, 0);
  assert.equal((await carol.req('GET', `/api/quotes/${q.id}`)).status, 404);
  assert.equal((await alice.req('POST', '/api/quotes', quote({ mentions: Array.from({ length: 21 }, (_, i) => `u${i}`) }))).status, 400);
});

test('Teilen mit Nutzern erzeugt "share"-Benachrichtigung (nicht doppelt bei Markierung)', async () => {
  const a = await signup(), b = await signup(), c = await signup();
  await a.req('POST', '/api/quotes', quote({ visibility: 'shared', shareWith: [b.name, c.name], mentions: [c.name] }));
  assert.deepEqual((await b.get('/api/notifications')).items.map((i) => i.type), ['share']);
  assert.deepEqual((await c.get('/api/notifications')).items.map((i) => i.type), ['mention']);
});

test('Freigabe-Links: öffentlich lesbar ohne Login, nur Eigentümer, widerrufbar', async () => {
  const a = await signup(), b = await signup();
  const q = (await a.req('POST', '/api/quotes', quote({ text: 'Link-Zitat', person: 'Goethe', mentions: [b.name] }))).data;
  assert.equal(q.link, null);
  assert.equal((await b.req('POST', `/api/quotes/${q.id}/link`)).status, 404); // b ist markiert, aber nicht Eigentümer
  const { link } = (await a.req('POST', `/api/quotes/${q.id}/link`)).data;
  assert.match(link, /^\/s\/[A-Za-z0-9_-]{32}$/);
  assert.equal((await a.req('POST', `/api/quotes/${q.id}/link`)).data.link, link); // stabil
  const token = link.slice(3);
  const pub = await fetch(`${base}/api/public/quotes/${token}`);
  const data = await pub.json();
  assert.deepEqual(Object.keys(data).sort(), ['author', 'createdAt', 'image', 'lang', 'person', 'source', 'text', 'translation']); // keine Markierungen o. ä.
  assert.equal(data.text, 'Link-Zitat');
  const page = await fetch(`${base}${link}`);
  assert.equal(page.status, 200); assert.match(page.headers.get('x-robots-tag'), /noindex/);
  assert.equal((await a.get(`/api/quotes/${q.id}`)).link, link);
  assert.equal((await b.get(`/api/quotes/${q.id}`)).link, undefined); // Nicht-Eigentümer sehen den Link nicht
  await a.req('DELETE', `/api/quotes/${q.id}/link`);
  assert.equal((await fetch(`${base}/api/public/quotes/${token}`)).status, 404);
  assert.equal((await fetch(`${base}/api/public/quotes/abc`)).status, 404);
  assert.equal((await fetch(`${base}/api/public/quotes/${'%25'.repeat(10)}`)).status, 404);
});

test('Gruppen: anlegen, Mitglieder sehen Gruppen-Zitate, Rechte, Verlassen, Löschen', async () => {
  const owner = await signup(), m1 = await signup(), m2 = await signup(), out = await signup();
  const g = (await owner.req('POST', '/api/groups', { name: 'Lesekreis', members: [m1.name] })).data;
  assert.equal(g.isOwner, true); assert.deepEqual(g.members.map((m) => m.role), ['owner', 'member']);
  assert.equal((await m1.get('/api/notifications')).items[0].type, 'group_add');
  assert.equal((await m1.get('/api/notifications')).items[0].groupName, 'Lesekreis');

  // Rechte
  assert.equal((await m1.req('POST', `/api/groups/${g.id}/members`, { usernames: [out.name] })).status, 403);
  assert.equal((await m1.req('PATCH', `/api/groups/${g.id}`, { name: 'x' })).status, 403);
  assert.equal((await out.req('GET', `/api/groups/${g.id}`)).status, 404);
  assert.equal((await out.req('POST', '/api/quotes', quote({ visibility: 'shared', shareGroups: [g.id] }))).status, 400); // nicht Mitglied

  // Zitat mit der Gruppe teilen (auch von einem normalen Mitglied)
  await m1.req('POST', '/api/quotes', quote({ text: 'für den Kreis', visibility: 'shared', shareGroups: [g.id] }));
  assert.deepEqual(await texts(owner, `scope=group&group=${g.id}`), ['für den Kreis']);
  assert.deepEqual(await texts(owner, 'scope=shared'), ['für den Kreis']);
  assert.deepEqual(await texts(out, 'scope=shared'), []);
  assert.equal((await out.req('GET', `/api/quotes?scope=group&group=${g.id}`)).status, 404);

  // Mitglied hinzufügen -> sieht bestehende Gruppen-Zitate
  await owner.req('POST', `/api/groups/${g.id}/members`, { usernames: [m2.name] });
  assert.deepEqual(await texts(m2, `scope=group&group=${g.id}`), ['für den Kreis']);
  assert.equal((await owner.get('/api/groups')).groups[0].memberCount, 3);

  // Verlassen / Entfernen
  assert.equal((await owner.req('DELETE', `/api/groups/${g.id}/members/${owner.id}`)).status, 400);
  assert.equal((await m2.req('DELETE', `/api/groups/${g.id}/members/${m1.id}`)).status, 403);
  assert.equal((await m2.req('DELETE', `/api/groups/${g.id}/members/${m2.id}`)).status, 200);
  assert.deepEqual(await texts(m2, 'scope=shared'), []);
  assert.equal((await m2.get('/api/notifications')).items.length, 0); // Gruppen-Benachrichtigung ausgeblendet

  // Löschen nur durch Besitzer
  assert.equal((await m1.req('DELETE', `/api/groups/${g.id}`)).status, 403);
  assert.equal((await owner.req('DELETE', `/api/groups/${g.id}`)).status, 200);
  assert.deepEqual(await texts(owner, 'scope=shared'), []);
  assert.deepEqual((await owner.get('/api/groups')).groups, []);
});

test('Nutzersuche: Präfix, ohne sich selbst, LIKE-Zeichen wörtlich', async () => {
  const a = await signup('searchme_a'); await signup('searchme_b'); await signup('searchmeXc');
  assert.deepEqual((await a.get('/api/users?q=searchme_')).users, ['searchme_b']);
  assert.deepEqual((await a.get('/api/users?q=%40searchme')).users.sort(), ['searchmeXc', 'searchme_b'].sort());
  assert.deepEqual((await a.get('/api/users?q=%25')).users, []);
  assert.equal((await new Client().req('GET', '/api/users?q=s')).status, 401);
});

test('Tags: normalisiert, validiert, filterbar, durchsuchbar', async () => {
  const a = await signup();
  assert.equal((await a.req('POST', '/api/quotes', quote({ tags: ['ungültig!'] }))).status, 400);
  assert.equal((await a.req('POST', '/api/quotes', quote({ tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }))).status, 400);
  const q = (await a.req('POST', '/api/quotes', quote({ text: 'mit Tags', tags: ['#Weisheit', 'weisheit', 'Mut', 'Über_Leben'] }))).data;
  assert.deepEqual(q.tags, ['mut', 'weisheit', 'über_leben']);
  await a.req('POST', '/api/quotes', quote({ text: 'ohne Tags' }));
  assert.deepEqual(await texts(a, 'scope=mine&tag=%23WEISHEIT'), ['mit Tags']);
  assert.deepEqual(await texts(a, 'scope=mine&q=%23über'), ['mit Tags']); // Suche findet auch Tags
  assert.equal((await a.req('GET', '/api/quotes?scope=mine&tag=a%20b')).status, 400);
  // Bearbeiten ersetzt Tags
  await a.req('PUT', `/api/quotes/${q.id}`, quote({ text: 'mit Tags', tags: ['neu'] }));
  assert.deepEqual((await a.get(`/api/quotes/${q.id}`)).tags, ['neu']);
});

test('Tag-Wolke zeigt nur Tags sichtbarer Zitate', async () => {
  const a = await signup(), b = await signup();
  await a.req('POST', '/api/quotes', quote({ tags: ['geheimtag'] })); // privat
  await a.req('POST', '/api/quotes', quote({ visibility: 'public', tags: ['offen'] }));
  await a.req('POST', '/api/quotes', quote({ visibility: 'public', tags: ['offen'] }));
  const bTags = (await b.get('/api/tags')).tags;
  assert.ok(bTags.some((t) => t.tag === 'offen' && t.count >= 2));
  assert.ok(!bTags.some((t) => t.tag === 'geheimtag'));
  assert.ok((await a.get('/api/tags?scope=mine')).tags.some((t) => t.tag === 'geheimtag'));
});

test('Filter nach Person (exakt, ohne Groß/Klein) und Sortierung nach Beliebtheit', async () => {
  const a = await signup(), b = await signup(), c = await signup();
  const q1 = (await a.req('POST', '/api/quotes', quote({ text: 'eins', person: 'Hannah Arendt', visibility: 'public' }))).data;
  const q2 = (await a.req('POST', '/api/quotes', quote({ text: 'zwei', person: 'Hannah Arendt Fan', visibility: 'public' }))).data;
  assert.deepEqual(await texts(a, 'scope=mine&person=hannah%20arendt'), ['eins']);
  await b.req('POST', `/api/quotes/${q1.id}/like`); await c.req('POST', `/api/quotes/${q1.id}/like`); await b.req('POST', `/api/quotes/${q2.id}/like`);
  assert.deepEqual((await texts(a, 'scope=mine&sort=top')).slice(0, 2), ['eins', 'zwei']);
  assert.deepEqual((await texts(a, 'scope=mine')).slice(0, 2), ['zwei', 'eins']);
});

test('Zitat des Tages: nur öffentliche Zitate, für alle gleich', async () => {
  const a = await signup(), b = await signup();
  const da = (await a.get('/api/daily')).quote, db2 = (await b.get('/api/daily')).quote;
  assert.ok(da); assert.equal(da.id, db2.id);
  // Eigentümer-Felder nur für den Eigentümer
  const viewer = da.mine ? db2 : da;
  assert.equal(viewer.visibility === undefined || viewer.mine, true);
  // Private Zitate tauchen nie auf (nur öffentliche Kandidaten)
  const full = await a.get(`/api/quotes/${da.id}`);
  assert.equal(full.mine ? full.visibility : 'public', 'public');
  assert.equal((await new Client().req('GET', '/api/daily')).status, 401);
});

test('Export: nur eigene Zitate, JSON und CSV (mit Formel-Schutz)', async () => {
  const a = await signup(), b = await signup();
  await a.req('POST', '/api/quotes', quote({ text: '=HYPERLINK("http://x")', person: 'Mal "Lory"', tags: ['csv'], mentions: [b.name] }));
  await b.req('POST', '/api/quotes', quote({ text: 'fremd' }));
  const j = await fetch(`${base}/api/export?format=json`, { headers: { cookie: a.cookie } });
  assert.match(j.headers.get('content-disposition'), /attachment; filename="quotes-\d{4}-\d{2}-\d{2}\.json"/);
  const data = await j.json();
  assert.deepEqual(data.quotes.map((q) => q.text), ['=HYPERLINK("http://x")']);
  assert.deepEqual(data.quotes[0].mentions, [b.name]);
  const c = await fetch(`${base}/api/export?format=csv`, { headers: { cookie: a.cookie } });
  assert.match(c.headers.get('content-type'), /text\/csv/);
  const bytes = Buffer.from(await c.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]); // UTF-8-BOM, damit Excel Umlaute richtig erkennt
  const csv = bytes.subarray(3).toString('utf8');
  assert.ok(csv.startsWith('text,person'));
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`)); // Formel entschärft, Anführungszeichen verdoppelt
  assert.ok(csv.includes('"Mal ""Lory"""'));
  assert.ok(!csv.includes('fremd'));
  assert.equal((await fetch(`${base}/api/export`)).status, 401);
});
