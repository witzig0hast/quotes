import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, clientFactory, quote } from './helpers.js';

let app, signup, Client;
before(() => { app = startApp(); ({ signup, Client } = clientFactory(app.base)); });
after(() => app.server.close());

test('Sammlungen: anlegen, nur sichtbare Zitate hinzufügen, nur Eigentümer ändert', async () => {
  const a = await signup(), b = await signup();
  const own = (await a.req('POST', '/api/quotes', quote({ text: 'eigenes privates Zitat' }))).data;
  const pub = (await b.req('POST', '/api/quotes', quote({ text: 'öffentliches von b', visibility: 'public' }))).data;
  const hidden = (await b.req('POST', '/api/quotes', quote({ text: 'privates von b' }))).data;
  assert.equal((await a.req('POST', '/api/collections', { name: '' })).status, 400);
  const c = (await a.req('POST', '/api/collections', { name: 'Hochzeitsrede', description: 'für Tim & Lea' })).data;
  assert.equal(c.isOwner, true); assert.equal(c.count, 0);
  assert.equal((await a.req('POST', `/api/collections/${c.id}/quotes`, { quoteId: own.id })).status, 200);
  assert.equal((await a.req('POST', `/api/collections/${c.id}/quotes`, { quoteId: pub.id })).status, 200);
  assert.equal((await a.req('POST', `/api/collections/${c.id}/quotes`, { quoteId: pub.id })).status, 200); // doppelt = ok
  assert.equal((await a.req('POST', `/api/collections/${c.id}/quotes`, { quoteId: hidden.id })).status, 404);
  const d = await a.get(`/api/collections/${c.id}`);
  assert.deepEqual(d.quotes.map((q) => q.text).sort(), ['eigenes privates Zitat', 'öffentliches von b']);
  assert.equal(d.collection.count, 2);
  // Fremde: weder sehen noch ändern
  assert.equal((await b.req('GET', `/api/collections/${c.id}`)).status, 404);
  assert.equal((await b.req('PATCH', `/api/collections/${c.id}`, { name: 'x' })).status, 404);
  // "contains"-Markierung für das Menü
  const list = (await a.get(`/api/collections?quote=${pub.id}`)).collections;
  assert.equal(list[0].contains, true);
  await a.req('DELETE', `/api/collections/${c.id}/quotes/${pub.id}`);
  assert.equal((await a.get(`/api/collections?quote=${pub.id}`)).collections[0].contains, false);
  // Zitat gelöscht -> verschwindet aus der Sammlung
  await a.req('DELETE', `/api/quotes/${own.id}`);
  assert.equal((await a.get(`/api/collections/${c.id}`)).collection.count, 0);
});

test('Sammlungen mit Gruppen teilen: Mitglieder sehen eigene Zitate des Eigentümers, aber nichts Fremdes', async () => {
  const owner = await signup(), member = await signup(), third = await signup(), outsider = await signup();
  const g = (await owner.req('POST', '/api/groups', { name: 'Kreis', members: [member.name] })).data;
  const ownPrivate = (await owner.req('POST', '/api/quotes', quote({ text: 'privat vom Eigentümer' }))).data;
  // third teilt ein Zitat NUR mit owner -> member darf es nicht sehen
  const onlyForOwner = (await third.req('POST', '/api/quotes', quote({ text: 'nur für den Eigentümer', visibility: 'shared', shareWith: [owner.name] }))).data;
  assert.equal((await owner.req('POST', '/api/collections', { name: 'x', groups: [999999] })).status, 400);
  const c = (await owner.req('POST', '/api/collections', { name: 'Für den Kreis', groups: [g.id] })).data;
  await owner.req('POST', `/api/collections/${c.id}/quotes`, { quoteId: ownPrivate.id });
  await owner.req('POST', `/api/collections/${c.id}/quotes`, { quoteId: onlyForOwner.id });
  assert.equal((await owner.get(`/api/collections/${c.id}`)).quotes.length, 2);
  const seen = await member.get(`/api/collections/${c.id}`);
  assert.deepEqual(seen.quotes.map((q) => q.text), ['privat vom Eigentümer']);
  assert.equal(seen.collection.count, 1); assert.equal(seen.collection.isOwner, false);
  assert.equal(seen.collection.groups, undefined); // Details nur für Eigentümer
  assert.equal((await member.req('POST', `/api/collections/${c.id}/quotes`, { quoteId: ownPrivate.id })).status, 403);
  assert.equal((await outsider.req('GET', `/api/collections/${c.id}`)).status, 404);
  assert.ok((await member.get('/api/collections')).collections.some((x) => x.id === c.id));
  // Mitglied verlässt die Gruppe -> kein Zugriff mehr
  await member.req('DELETE', `/api/groups/${g.id}/members/${member.id}`);
  assert.equal((await member.req('GET', `/api/collections/${c.id}`)).status, 404);
});

test('Sammlungs-Link: öffentlich nur öffentliche + eigene Zitate, widerrufbar', async () => {
  const a = await signup(), b = await signup();
  const mine = (await a.req('POST', '/api/quotes', quote({ text: 'meins, privat', mentions: [b.name] }))).data;
  const forA = (await b.req('POST', '/api/quotes', quote({ text: 'von b nur an a', visibility: 'shared', shareWith: [a.name] }))).data;
  const pub = (await b.req('POST', '/api/quotes', quote({ text: 'von b öffentlich', visibility: 'public' }))).data;
  const c = (await a.req('POST', '/api/collections', { name: 'Linkliste' })).data;
  for (const q of [mine, forA, pub]) await a.req('POST', `/api/collections/${c.id}/quotes`, { quoteId: q.id });
  const { link } = (await a.req('POST', `/api/collections/${c.id}/link`)).data;
  assert.match(link, /^\/c\/[A-Za-z0-9_-]{32}$/);
  const r = await fetch(`${app.base}/api/public/collections/${link.slice(3)}`);
  const data = await r.json();
  assert.deepEqual(data.quotes.map((q) => q.text).sort(), ['meins, privat', 'von b öffentlich']);
  assert.ok(!JSON.stringify(data).includes(b.name + '"]')); // keine Markierungen
  assert.deepEqual(Object.keys(data.quotes[0]).sort(), ['author', 'createdAt', 'lang', 'person', 'source', 'text', 'translation']);
  const page = await fetch(`${app.base}${link}`);
  assert.equal(page.status, 200); assert.match(page.headers.get('x-robots-tag'), /noindex/);
  await a.req('DELETE', `/api/collections/${c.id}/link`);
  assert.equal((await fetch(`${app.base}/api/public/collections/${link.slice(3)}`)).status, 404);
});

test('Personen-Seite: nur sichtbare Zitate zählen; Vorschläge', async () => {
  const a = await signup(), b = await signup();
  await a.req('POST', '/api/quotes', quote({ text: 'Curie eins', person: 'Marie Curie', visibility: 'public', tags: ['mut'] }));
  await a.req('POST', '/api/quotes', quote({ text: 'Curie zwei', person: 'marie curie', tags: ['mut', 'physik'] })); // privat
  const pa = await a.get('/api/people/Marie%20Curie');
  assert.equal(pa.count, 2); assert.deepEqual(pa.tags[0], { tag: 'mut', count: 2 }); assert.equal(pa.wiki, null);
  const pb = await b.get('/api/people/marie%20curie');
  assert.equal(pb.count, 1); assert.deepEqual(pb.tags, [{ tag: 'mut', count: 1 }]);
  assert.equal((await b.req('GET', '/api/people/Unbekannt')).status, 404);
  assert.deepEqual((await b.get('/api/people?q=curi')).people, ['Marie Curie']);
  assert.equal((await new Client().req('GET', '/api/people/Marie%20Curie')).status, 401);
});

test('Zufallszitat: nur Sichtbares, nach Bereich, null wenn leer', async () => {
  const a = await signup(), b = await signup();
  assert.equal((await a.get('/api/random?scope=mine')).quote, null);
  await b.req('POST', '/api/quotes', quote({ text: 'geheim von b' }));
  const mine = (await a.req('POST', '/api/quotes', quote({ text: 'zufall mein' }))).data;
  for (let i = 0; i < 15; i++) {
    const q = (await a.get('/api/random')).quote;
    assert.notEqual(q.text, 'geheim von b');
  }
  assert.equal((await a.get('/api/random?scope=mine')).quote.id, mine.id);
  assert.equal((await a.get(`/api/random?scope=mine&not=${mine.id}`)).quote, null);
});

test('Duplikate: tolerant gegenüber Satzzeichen, Groß/Klein, Umlaut-Schreibweisen', async () => {
  const a = await signup(), b = await signup();
  const q = (await a.req('POST', '/api/quotes', quote({ text: 'Ich weiß, dass ich nichts weiß.', person: 'Sokrates' }))).data;
  const chk = (c, text, ex = '') => c.get(`/api/quotes-check?text=${encodeURIComponent(text)}${ex}`);
  assert.equal((await chk(a, 'ich weiss dass ich NICHTS weiss')).own.id, q.id);
  assert.equal((await chk(a, 'ich weiss dass ich nichts weiss', `&exclude=${q.id}`)).own, null); // beim Bearbeiten
  assert.deepEqual(await chk(b, 'ich weiss dass ich nichts weiss'), { own: null, existing: null }); // a's privates bleibt verborgen
  await a.req('PUT', `/api/quotes/${q.id}`, quote({ text: 'Ich weiß, dass ich nichts weiß.', person: 'Sokrates', visibility: 'public' }));
  assert.equal((await chk(b, 'Ich weiß, dass ich nichts weiß!')).existing.id, q.id);
  assert.deepEqual(await chk(b, 'kurz'), { own: null, existing: null });
});
