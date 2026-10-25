import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, clientFactory, quote } from './helpers.js';

let app, signup, Client;
before(() => { app = startApp(); ({ signup, Client } = clientFactory(app.base)); });
after(() => app.server.close());

test('Kommentare: nur wer das Zitat sieht; Eigentümer + @Erwähnte (mit Zugriff) werden benachrichtigt', async () => {
  const owner = await signup(), friend = await signup(), stranger = await signup();
  const priv = (await owner.req('POST', '/api/quotes', quote({ text: 'nur für friend', visibility: 'shared', shareWith: [friend.name] }))).data;
  assert.equal((await stranger.req('GET', `/api/quotes/${priv.id}/comments`)).status, 404);
  assert.equal((await stranger.req('POST', `/api/quotes/${priv.id}/comments`, { body: 'hallo' })).status, 404);
  assert.equal((await friend.req('POST', `/api/quotes/${priv.id}/comments`, { body: '  ' })).status, 400);
  // friend erwähnt stranger (kein Zugriff) -> stranger bekommt nichts
  const c = (await friend.req('POST', `/api/quotes/${priv.id}/comments`, { body: `Schön! @${stranger.name} @${owner.name}` })).data;
  assert.equal(c.mine, true); assert.equal(c.canDelete, true);
  assert.equal((await stranger.get('/api/notifications')).items.length, 0);
  const n = (await owner.get('/api/notifications')).items;
  assert.equal(n.length, 1); // nur eine Nachricht, obwohl Eigentümer und erwähnt
  assert.deepEqual([n[0].type, n[0].actor, n[0].commentText], ['comment_mention', friend.name, c.body]);
  assert.equal((await owner.get(`/api/quotes/${priv.id}`)).comments, 1);
  const list = (await owner.get(`/api/quotes/${priv.id}/comments`)).comments;
  assert.deepEqual([list[0].mine, list[0].canDelete], [false, true]); // Eigentümer darf moderieren
  // Löschen: Fremder nein, Eigentümer ja; Benachrichtigung verschwindet
  const c2 = (await owner.req('POST', `/api/quotes/${priv.id}/comments`, { body: `Danke @${friend.name}` })).data;
  assert.equal((await friend.req('DELETE', `/api/comments/${c2.id}`)).status, 403);
  assert.equal((await owner.req('DELETE', `/api/comments/${c.id}`)).status, 200);
  assert.equal((await owner.get('/api/notifications')).items.length, 0);
  // Zugriff entzogen -> Kommentar-Benachrichtigungen ausgeblendet
  assert.equal((await friend.get('/api/notifications')).items.filter((i) => i.type === 'comment_mention').length, 1);
  await owner.req('PUT', `/api/quotes/${priv.id}`, quote({ text: 'nur für friend', visibility: 'private' }));
  assert.equal((await friend.get('/api/notifications')).items.filter((i) => i.type === 'comment_mention').length, 0);
});

test('Folgen & Profile: Zähler, Benachrichtigung, Gefolgt-Feed nur mit sichtbaren Zitaten', async () => {
  const a = await signup(), b = await signup();
  await b.req('POST', '/api/quotes', quote({ text: 'b öffentlich', visibility: 'public', tags: ['x'] }));
  await b.req('POST', '/api/quotes', quote({ text: 'b privat', tags: ['geheim'] }));
  assert.equal((await a.req('POST', `/api/users/${a.name}/follow`)).status, 400);
  assert.equal((await a.req('POST', '/api/users/gibtsnicht/follow')).status, 404);
  let p = await a.get(`/api/users/${b.name}`);
  assert.deepEqual([p.quotes, p.followers, p.isFollowing, p.isMe], [1, 0, false, false]);
  assert.deepEqual(p.tags, [{ tag: 'x', count: 1 }]); // private Tags bleiben verborgen
  await a.req('POST', `/api/users/${b.name}/follow`); await a.req('POST', `/api/users/${b.name}/follow`); // doppelt = egal
  assert.equal((await b.get('/api/notifications')).items.filter((i) => i.type === 'follow').length, 1);
  p = await a.get(`/api/users/${b.name}`);
  assert.deepEqual([p.followers, p.isFollowing], [1, true]);
  assert.equal((await b.get(`/api/users/${a.name}`)).followsYou, true);
  const feed = (await a.get('/api/quotes?scope=following')).quotes.map((q) => q.text);
  assert.deepEqual(feed, ['b öffentlich']);
  assert.deepEqual((await a.get(`/api/quotes?scope=user&user=${b.name}`)).quotes.map((q) => q.text), ['b öffentlich']);
  assert.equal((await b.get(`/api/quotes?scope=user&user=${b.name}`)).quotes.length, 2);
  assert.equal((await a.req('GET', '/api/quotes?scope=user&user=niemand')).status, 404);
  assert.deepEqual((await a.get('/api/me/follows')).following, [b.name]);
  await a.req('DELETE', `/api/users/${b.name}/follow`);
  assert.deepEqual((await a.get('/api/quotes?scope=following')).quotes, []);
});

test('Erweiterte Suche: tolerant, Zeitraum, Sichtbarkeit, "Meintest du"', async () => {
  const a = await signup();
  await a.req('POST', '/api/quotes', quote({ text: 'Café crème am Straßenrand', person: 'Friedrich Nietzsche', visibility: 'public' }));
  await a.req('POST', '/api/quotes', quote({ text: 'Ganz privat', person: 'Niemand' }));
  const t = async (qs) => (await a.get(`/api/quotes?scope=mine&${qs}`)).quotes.map((q) => q.text);
  assert.deepEqual(await t('q=cafe%20creme'), ['Café crème am Straßenrand']);
  assert.deepEqual(await t('q=strassenrand'), ['Café crème am Straßenrand']);
  assert.deepEqual(await t('vis=private'), ['Ganz privat']);
  assert.deepEqual(await t('vis=public'), ['Café crème am Straßenrand']);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await t(`from=${today}&to=${today}`)).length, 2);
  assert.deepEqual(await t('to=2000-01-01'), []);
  assert.equal((await t('from=kaputt')).length, 2); // ungültig -> ignoriert
  const miss = await a.get('/api/quotes?scope=mine&q=Nietsche');
  assert.deepEqual([miss.quotes.length, miss.suggestion], [0, 'Nietzsche']);
  assert.equal((await a.get('/api/quotes?scope=mine&q=xyzabc')).suggestion, undefined);
});

test('Statistik: Kennzahlen, Monate, Serie', async () => {
  const a = await signup(), b = await signup();
  assert.deepEqual((await a.get('/api/stats')).streak, { current: 0, longest: 0, activeToday: false });
  const q1 = (await a.req('POST', '/api/quotes', quote({ person: 'Goethe', visibility: 'public', tags: ['t1'] }))).data;
  await a.req('POST', '/api/quotes', quote({ text: 'zweites', person: 'goethe' }));
  await b.req('POST', `/api/quotes/${q1.id}/like`);
  await a.req('POST', `/api/quotes/${q1.id}/like`); // eigene Likes zählen nicht als "erhalten"
  const s = await a.get('/api/stats');
  assert.equal(s.total, 2);
  assert.deepEqual(s.byVisibility, { private: 1, shared: 0, public: 1 });
  assert.deepEqual([s.likesReceived, s.likesGiven], [1, 1]);
  assert.deepEqual(s.topPeople, [{ name: 'Goethe', count: 2 }]);
  assert.equal(s.perMonth.length, 12);
  assert.equal(s.perMonth.at(-1).count, 2);
  assert.deepEqual(s.streak, { current: 1, longest: 1, activeToday: true });
  assert.equal((await new Client().req('GET', '/api/stats')).status, 401);
});
