import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

let server, base;
before(async () => {
  server = createApp({ db: openDb(':memory:'), secureCookies: false }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

class Client {
  cookie = ''; csrf = '';
  async req(method, path, body, { csrf = true } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...(csrf && this.csrf ? { 'x-csrf-token': this.csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const data = await res.json().catch(() => ({}));
    if (data.csrf) this.csrf = data.csrf;
    return { status: res.status, data, headers: res.headers };
  }
}
const signup = async (name) => { const c = new Client(); const r = await c.req('POST', '/api/register', { username: name, password: 'correct-horse-battery' }); assert.equal(r.status, 201); return c; };
const quote = (o = {}) => ({ text: 'Hallo Welt', person: 'Ada', source: '', visibility: 'private', ...o });

test('Registrierung validiert und Cookie ist HttpOnly + SameSite=Strict', async () => {
  const c = new Client();
  assert.equal((await c.req('POST', '/api/register', { username: 'a', password: 'x' })).status, 400);
  assert.equal((await c.req('POST', '/api/register', { username: 'validuser', password: 'short' })).status, 400);
  const r = await c.req('POST', '/api/register', { username: 'validuser', password: 'longenough123' });
  assert.equal(r.status, 201);
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/i); assert.match(sc, /SameSite=Strict/i);
  assert.equal((await new Client().req('POST', '/api/register', { username: 'VALIDUSER', password: 'longenough123' })).status, 409);
});

test('Login: falsche Daten -> 401, Passwort-Hash wird nie ausgeliefert', async () => {
  await signup('loginuser');
  const c = new Client();
  assert.equal((await c.req('POST', '/api/login', { username: 'loginuser', password: 'wrong-password' })).status, 401);
  assert.equal((await c.req('POST', '/api/login', { username: 'nobody', password: 'wrong-password' })).status, 401);
  const ok = await c.req('POST', '/api/login', { username: 'loginuser', password: 'correct-horse-battery' });
  assert.equal(ok.status, 200);
  assert.ok(!JSON.stringify(ok.data).includes('scrypt'));
});

test('Ohne Login kein Zugriff', async () => {
  assert.equal((await new Client().req('GET', '/api/quotes')).status, 401);
  assert.equal((await new Client().req('POST', '/api/quotes', quote())).status, 401);
});

test('CSRF-Token ist für schreibende Anfragen Pflicht', async () => {
  const c = await signup('csrfuser');
  assert.equal((await c.req('POST', '/api/quotes', quote(), { csrf: false })).status, 403);
  assert.equal((await c.req('POST', '/api/quotes', quote())).status, 201);
});

test('Sichtbarkeit: privat / geteilt / öffentlich', async () => {
  const alice = await signup('alice'), bob = await signup('bob'), carol = await signup('carol');
  const priv = (await alice.req('POST', '/api/quotes', quote({ text: 'geheim' }))).data;
  const shared = (await alice.req('POST', '/api/quotes', quote({ text: 'nur bob', visibility: 'shared', shareWith: ['Bob'] }))).data;
  const pub = (await alice.req('POST', '/api/quotes', quote({ text: 'für alle', visibility: 'public' }))).data;
  const texts = async (c, scope) => (await c.req('GET', `/api/quotes?scope=${scope}`)).data.quotes.map((q) => q.text);

  assert.deepEqual(await texts(bob, 'feed'), ['für alle']);
  assert.deepEqual(await texts(bob, 'shared'), ['nur bob']);
  assert.deepEqual(await texts(carol, 'shared'), []);
  assert.deepEqual((await texts(alice, 'mine')).sort(), ['für alle', 'geheim', 'nur bob']);
  // Fremde sehen weder Sichtbarkeit noch Empfängerliste
  const seen = (await bob.req('GET', '/api/quotes?scope=shared')).data.quotes[0];
  assert.equal(seen.visibility, undefined); assert.equal(seen.shareWith, undefined);
  // Like auf nicht sichtbares Zitat -> 404, auf sichtbares -> ok
  assert.equal((await carol.req('POST', `/api/quotes/${priv.id}/like`)).status, 404);
  assert.equal((await carol.req('POST', `/api/quotes/${shared.id}/like`)).status, 404);
  const like = await carol.req('POST', `/api/quotes/${pub.id}/like`);
  assert.deepEqual([like.data.liked, like.data.likes], [true, 1]);
  assert.deepEqual(await texts(carol, 'liked'), ['für alle']);
  // Fremde dürfen nicht ändern/löschen
  assert.equal((await bob.req('PUT', `/api/quotes/${pub.id}`, quote())).status, 404);
  assert.equal((await bob.req('DELETE', `/api/quotes/${pub.id}`)).status, 404);
  // Sichtbarkeit nachträglich auf privat -> sofort weg
  await alice.req('PUT', `/api/quotes/${pub.id}`, quote({ text: 'für alle', visibility: 'private' }));
  assert.deepEqual(await texts(bob, 'feed'), []);
});

test('Eingaben: Validierung, unbekannte Empfänger, SQL-/LIKE-Zeichen, XSS bleibt Text', async () => {
  const c = await signup('mallory');
  assert.equal((await c.req('POST', '/api/quotes', quote({ text: '  ' }))).status, 400);
  assert.equal((await c.req('POST', '/api/quotes', quote({ text: 'x'.repeat(1001) }))).status, 400);
  assert.equal((await c.req('POST', '/api/quotes', quote({ visibility: 'admin' }))).status, 400);
  assert.equal((await c.req('POST', '/api/quotes', quote({ visibility: 'shared', shareWith: ['gibtsnicht'] }))).status, 400);
  const xss = '<img src=x onerror=alert(1)>';
  await c.req('POST', '/api/quotes', quote({ text: xss, visibility: 'public' }));
  await c.req('POST', '/api/quotes', quote({ text: '100% sicher', visibility: 'public' }));
  const hits = (await c.req('GET', `/api/quotes?scope=feed&q=${encodeURIComponent("%")}`)).data.quotes;
  assert.deepEqual(hits.map((q) => q.text), ['100% sicher']); // % wird wörtlich gesucht
  const sqli = await c.req('GET', `/api/quotes?scope=feed&q=${encodeURIComponent("' OR 1=1 --")}`);
  assert.equal(sqli.status, 200); assert.equal(sqli.data.quotes.length, 0);
  assert.equal((await c.req('GET', '/api/quotes?scope=feed&q=onerror')).data.quotes[0].text, xss);
});

test('Sicherheits-Header und Logout', async () => {
  const c = await signup('headers');
  const r = await fetch(base + '/');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
  await c.req('POST', '/api/logout', {});
  assert.equal((await c.req('GET', '/api/quotes')).status, 401);
});

test('Konto löschen entfernt Zitate', async () => {
  const c = await signup('goner'); const other = await signup('stays');
  await c.req('POST', '/api/quotes', quote({ text: 'bye', visibility: 'public' }));
  assert.equal((await c.req('DELETE', '/api/me', { password: 'nope-nope-nope' })).status, 403);
  assert.equal((await c.req('DELETE', '/api/me', { password: 'correct-horse-battery' })).status, 200);
  assert.ok(!(await other.req('GET', '/api/quotes?scope=feed')).data.quotes.some((q) => q.text === 'bye'));
});
