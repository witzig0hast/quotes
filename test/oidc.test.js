import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createOidc, oidcFromEnv } from '../src/oidc.js';

// ---- Mock-IdP (verhält sich wie authentik: Discovery, Token-Endpoint, JWKS) ----
const CLIENT_ID = 'quotes-client', SECRET = 's3cret';
let idp, issuer, privateKey, kid = 'k1', evilKey;
const idpState = { claims: {}, override: {}, lastToken: null, tokenStatus: 200 };
const sign = (key, payload, alg = 'RS256') => new SignJWT(payload).setProtectedHeader({ alg, kid }).sign(key);

before(async () => {
  ({ privateKey } = await generateKeyPair('RS256'));
  const pub = await generateKeyPair('RS256');
  ({ privateKey: evilKey } = await generateKeyPair('RS256'));
  const jwk = { ...(await exportJWK(pub.publicKey)), kid, alg: 'RS256', use: 'sig' };
  privateKey = pub.privateKey;
  idp = http.createServer((req, res) => {
    const url = new URL(req.url, issuer);
    const json = (o, st = 200) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      return json({ issuer: idpState.metaIssuer ?? issuer, authorization_endpoint: `${issuer}authorize`, token_endpoint: `${issuer}token`,
        jwks_uri: `${issuer}jwks`, code_challenge_methods_supported: ['S256'] });
    }
    if (url.pathname.endsWith('/jwks')) return json({ keys: [jwk] });
    if (url.pathname.endsWith('/token') && req.method === 'POST') {
      let body = ''; req.on('data', (c) => (body += c)); req.on('end', async () => {
        const p = Object.fromEntries(new URLSearchParams(body));
        idpState.lastToken = p;
        if (idpState.tokenStatus !== 200) return json({ error: 'invalid_grant' }, idpState.tokenStatus);
        const ok = p.client_secret === SECRET && p.client_id === CLIENT_ID
          && createHash('sha256').update(p.code_verifier).digest('base64url') === idpState.challenge;
        if (!ok) return json({ error: 'invalid_grant' }, 400);
        const now = Math.floor(Date.now() / 1000);
        const payload = { iss: issuer, aud: CLIENT_ID, iat: now, exp: now + 300, nonce: idpState.nonce, ...idpState.claims, ...idpState.override };
        const key = idpState.signWith ?? privateKey;
        json({ token_type: 'Bearer', access_token: 'x', id_token: idpState.noIdToken ? undefined : await sign(key, payload) });
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => idp.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${idp.address().port}/application/o/quotes/`;
});
after(() => idp.close());

// ---- App ----
function setup(opts = {}) {
  const db = openDb(':memory:');
  const oidc = createOidc({ issuer, clientId: CLIENT_ID, clientSecret: SECRET, publicUrl: 'http://localhost:3000', name: 'Authentik', ...opts });
  const server = createApp({ db, oidc, secureCookies: false }).listen(0);
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}
const reset = (claims) => { Object.assign(idpState, { claims, override: {}, signWith: null, noIdToken: false, tokenStatus: 200, metaIssuer: undefined }); };

/** Führt den Browser-Flow aus: /login -> (IdP) -> /callback */
async function sso(ctx, { claims, override = {}, tamperState, dropBind, sameBrowserBind } = {}) {
  reset(claims ?? { sub: 'user-1', preferred_username: 'Alice', email: 'a@example.com' });
  Object.assign(idpState.override, override);
  const r1 = await fetch(`${ctx.base}/api/auth/oidc/login`, { redirect: 'manual' });
  assert.equal(r1.status, 302);
  const loc = new URL(r1.headers.get('location'));
  const bindCookie = r1.headers.get('set-cookie')?.split(';')[0];
  idpState.nonce = loc.searchParams.get('nonce'); idpState.challenge = loc.searchParams.get('code_challenge');
  const cb = new URL(`${ctx.base}/api/auth/oidc/callback`);
  cb.searchParams.set('code', 'abc'); cb.searchParams.set('state', tamperState ?? loc.searchParams.get('state'));
  const headers = {}; const cookie = sameBrowserBind ?? bindCookie;
  if (!dropBind && cookie) headers.cookie = cookie;
  const r2 = await fetch(cb, { redirect: 'manual', headers });
  return { loc, r1, r2, bindCookie, cb, where: r2.headers.get('location'), session: r2.headers.get('set-cookie')?.split(',').find((c) => c.trim().startsWith('sid='))?.split(';')[0] };
}
const me = async (ctx, sid) => (await fetch(`${ctx.base}/api/me`, { headers: { cookie: sid } })).json();

test('Login-Redirect enthält PKCE (S256), state, nonce, redirect_uri; Bind-Cookie ist HttpOnly+Lax', async () => {
  const ctx = setup();
  const r = await fetch(`${ctx.base}/api/auth/oidc/login`, { redirect: 'manual' });
  const u = new URL(r.headers.get('location'));
  assert.equal(u.origin + u.pathname, `${issuer.replace(/\/$/, '').replace(/\/application.*/, '')}/authorize`.replace('/authorize', '/application/o/quotes/authorize'));
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:3000/api/auth/oidc/callback');
  assert.ok(u.searchParams.get('state').length >= 40 && u.searchParams.get('nonce').length >= 40);
  const sc = r.headers.get('set-cookie'); assert.match(sc, /HttpOnly/i); assert.match(sc, /SameSite=Lax/i);
  ctx.server.close();
});

test('Erfolgreicher Login legt Nutzer an, startet Session, zweiter Login = gleicher Nutzer', async () => {
  const ctx = setup();
  const a = await sso(ctx);
  assert.equal(a.where, '/'); assert.ok(a.session);
  assert.equal(idpState.lastToken.code_verifier.length >= 43, true);
  const m = await me(ctx, a.session);
  assert.equal(m.user.username, 'Alice'); assert.equal(m.user.sso, true);
  assert.equal(m.user.usernameSet, false); // SSO-Name ist nur ein Vorschlag
  const b = await sso(ctx);
  assert.equal((await me(ctx, b.session)).user.id, m.user.id);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM users').get().c, 1);
  ctx.server.close();
});

test('Kein Auto-Linking: gleicher Username/E-Mail wie lokales Konto -> eigenes Konto mit Suffix', async () => {
  const ctx = setup();
  const reg = await fetch(`${ctx.base}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'correct-horse-battery' }) });
  assert.equal(reg.status, 201);
  const a = await sso(ctx, { claims: { sub: 'attacker', preferred_username: 'alice', email: 'alice@example.com' } });
  const m = await me(ctx, a.session);
  assert.notEqual(m.user.username.toLowerCase(), 'alice'); assert.match(m.user.username, /^alice\d{4}$/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM users').get().c, 2);
  ctx.server.close();
});

test('SSO-Konto kann sich nicht per Passwort anmelden (auch nicht mit "!")', async () => {
  const ctx = setup();
  await sso(ctx);
  for (const password of ['!', '', 'irgendwas-langes-123']) {
    const r = await fetch(`${ctx.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Alice', password }) });
    assert.equal(r.status, 401);
  }
  ctx.server.close();
});

test('Angriffe: falscher State, fehlendes/fremdes Bind-Cookie, Replay -> abgelehnt, keine Session', async () => {
  const ctx = setup();
  const bad = async (r, code) => { assert.match(r.where, new RegExp(`sso_error=${code}`)); assert.equal(r.session, undefined); };
  await bad(await sso(ctx, { tamperState: 'erfunden' }), 'invalid_state');
  await bad(await sso(ctx, { dropBind: true }), 'invalid_state');                       // Login-CSRF / State-Fixation
  await bad(await sso(ctx, { sameBrowserBind: 'oidc_bind=fremdes-secret' }), 'invalid_state');
  // Replay: derselbe state/code ein zweites Mal
  const ok = await sso(ctx);
  assert.ok(ok.session);
  const replay = await fetch(ok.cb, { redirect: 'manual', headers: { cookie: ok.bindCookie } });
  assert.match(replay.headers.get('location'), /invalid_state/);
  ctx.server.close();
});

test('ID-Token-Prüfung: falsche Audience / Issuer / Nonce / abgelaufen / fehlender sub', async () => {
  const ctx = setup();
  const rej = async (opts, code = 'invalid_token') => { const r = await sso(ctx, opts); assert.match(r.where, new RegExp(`sso_error=${code}`), JSON.stringify(opts.override ?? opts)); assert.equal(r.session, undefined); };
  await rej({ override: { aud: 'anderer-client' } });
  await rej({ override: { iss: 'https://evil.example/' } });
  await rej({ override: { nonce: 'falsch' } });
  await rej({ override: { exp: Math.floor(Date.now() / 1000) - 3600 } });
  await rej({ override: { sub: undefined } });
  ctx.server.close();
});

test('Fremd signierte Tokens werden abgelehnt', async () => {
  const ctx = setup();
  reset({ sub: 'u', preferred_username: 'x' });
  idpState.signWith = evilKey;
  const r1 = await fetch(`${ctx.base}/api/auth/oidc/login`, { redirect: 'manual' });
  const loc = new URL(r1.headers.get('location'));
  idpState.nonce = loc.searchParams.get('nonce'); idpState.challenge = loc.searchParams.get('code_challenge');
  const cb = `${ctx.base}/api/auth/oidc/callback?code=abc&state=${loc.searchParams.get('state')}`;
  const r2 = await fetch(cb, { redirect: 'manual', headers: { cookie: r1.headers.get('set-cookie').split(';')[0] } });
  assert.match(r2.headers.get('location'), /sso_error=invalid_token/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM users').get().c, 0);
  ctx.server.close();
});

test('Provider-Fehler: Token-Endpoint 400, access_denied, Issuer-Mismatch in Discovery', async () => {
  const ctx = setup();
  reset({ sub: 'u1', preferred_username: 'bob' });
  idpState.tokenStatus = 400;
  const r1 = await fetch(`${ctx.base}/api/auth/oidc/login`, { redirect: 'manual' });
  const st = new URL(r1.headers.get('location')).searchParams.get('state');
  const r2 = await fetch(`${ctx.base}/api/auth/oidc/callback?code=abc&state=${st}`, { redirect: 'manual', headers: { cookie: r1.headers.get('set-cookie').split(';')[0] } });
  assert.match(r2.headers.get('location'), /sso_error=provider_error/);

  const r3 = await fetch(`${ctx.base}/api/auth/oidc/login`, { redirect: 'manual' });
  const st3 = new URL(r3.headers.get('location')).searchParams.get('state');
  const r4 = await fetch(`${ctx.base}/api/auth/oidc/callback?error=access_denied&state=${st3}`, { redirect: 'manual', headers: { cookie: r3.headers.get('set-cookie').split(';')[0] } });
  assert.match(r4.headers.get('location'), /sso_error=access_denied/);
  ctx.server.close();

  reset({}); idpState.metaIssuer = 'https://evil.example/';
  const ctx2 = setup();
  const r5 = await fetch(`${ctx2.base}/api/auth/oidc/login`, { redirect: 'manual' });
  assert.match(r5.headers.get('location'), /sso_error=provider_error/);
  ctx2.server.close(); idpState.metaIssuer = undefined;
});

test('Optionen: Registrierung per SSO aus, Passwort-Login aus, /api/config', async () => {
  const closed = setup({ allowSignup: false });
  assert.match((await sso(closed)).where, /sso_error=signup_disabled/);
  closed.server.close();

  const ctx = setup({ passwordLogin: false });
  const cfg = await (await fetch(`${ctx.base}/api/config`)).json();
  assert.deepEqual(cfg, { sso: { name: 'Authentik' }, passwordLogin: false });
  for (const path of ['/api/login', '/api/register']) {
    const r = await fetch(ctx.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'abc', password: 'longenough123' }) });
    assert.equal(r.status, 403);
  }
  assert.ok((await sso(ctx)).session); // SSO funktioniert weiterhin
  ctx.server.close();
});

test('Konto löschen: SSO-Nutzer bestätigt mit Benutzername', async () => {
  const ctx = setup();
  const a = await sso(ctx);
  const m = await me(ctx, a.session);
  const del = (body) => fetch(`${ctx.base}/api/me`, { method: 'DELETE', headers: { cookie: a.session, 'content-type': 'application/json', 'x-csrf-token': m.csrf }, body: JSON.stringify(body) });
  assert.equal((await del({ confirm: 'falsch' })).status, 403);
  assert.equal((await del({ password: '!' })).status, 403);
  assert.equal((await del({ confirm: 'Alice' })).status, 200);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM identities').get().c, 0);
  ctx.server.close();
});

test('Ohne SSO-Konfiguration: keine Routen, config zeigt sso=null; ENV-Validierung', async () => {
  const db = openDb(':memory:');
  const server = createApp({ db, secureCookies: false }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(`${base}/api/config`)).json(), { sso: null, passwordLogin: true });
  assert.equal((await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' })).status, 404);
  server.close();
  assert.equal(oidcFromEnv({}), null);
  assert.throws(() => oidcFromEnv({ OIDC_ISSUER: 'https://sso.example.com/' }), /OIDC_CLIENT_ID/);
  assert.throws(() => oidcFromEnv({ OIDC_ISSUER: 'http://sso.example.com/', OIDC_CLIENT_ID: 'a', OIDC_CLIENT_SECRET: 'b', PUBLIC_URL: 'https://q.example.com' }), /HTTPS/);
});

// ---- Bestehendes Konto mit SSO verknüpfen ----
async function localUser(ctx, username) {
  const r = await fetch(`${ctx.base}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'correct-horse-battery' }) });
  assert.equal(r.status, 201);
  const { csrf, user } = await r.json();
  return { sid: r.headers.get('set-cookie').split(';')[0], csrf, id: user.id };
}
const call = (ctx, u, method, path, body, { csrf = true } = {}) => fetch(ctx.base + path, { method, redirect: 'manual',
  headers: { 'content-type': 'application/json', cookie: u.sid, ...(csrf ? { 'x-csrf-token': u.csrf } : {}) }, body: JSON.stringify(body ?? {}) });

/** Startet die Verknüpfung als u und spielt den IdP-Rücksprung durch. */
async function link(ctx, u, claims, { password = 'correct-horse-battery' } = {}) {
  reset(claims);
  const r1 = await call(ctx, u, 'POST', '/api/me/sso', { password });
  if (r1.status !== 200) return { status: r1.status };
  const { url } = await r1.json();
  const loc = new URL(url);
  idpState.nonce = loc.searchParams.get('nonce'); idpState.challenge = loc.searchParams.get('code_challenge');
  const bind = r1.headers.get('set-cookie').split(';')[0];
  assert.match(bind, /^oidc_bind=/);
  // Rücksprung vom IdP: cross-site, daher KEIN sid-Cookie (SameSite=Strict) – nur das Bind-Cookie
  const r2 = await fetch(`${ctx.base}/api/auth/oidc/callback?code=abc&state=${loc.searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: bind } });
  return { status: 200, where: r2.headers.get('location'), setsSession: /sid=/.test(r2.headers.get('set-cookie') ?? '') };
}
const meOf = async (ctx, u) => (await fetch(`${ctx.base}/api/me`, { headers: { cookie: u.sid } })).json();

test('Verknüpfen: bestehendes Konto + SSO -> danach landet SSO-Login im selben Konto', async () => {
  const ctx = setup();
  const karim = await localUser(ctx, 'karim');
  assert.equal((await meOf(ctx, karim)).user.ssoLinked, false);
  const r = await link(ctx, karim, { sub: 'ak-123', preferred_username: 'k.hast' });
  assert.equal(r.where, '/?sso_linked=1');
  assert.equal(r.setsSession, false);
  const m = await meOf(ctx, karim);
  assert.equal(m.user.ssoLinked, true); assert.equal(m.user.sso, false); assert.equal(m.user.username, 'karim'); // Name bleibt
  const viaSso = await sso(ctx, { claims: { sub: 'ak-123', preferred_username: 'k.hast' } });
  assert.equal((await me(ctx, viaSso.session)).user.id, karim.id);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM users').get().c, 1); // kein zweites Konto
  // Passwort-Login funktioniert weiterhin
  const pw = await fetch(`${ctx.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'karim', password: 'correct-horse-battery' }) });
  assert.equal(pw.status, 200);
  // Zweites Verknüpfen -> 409
  assert.equal((await call(ctx, karim, 'POST', '/api/me/sso', { password: 'correct-horse-battery' })).status, 409);
  ctx.server.close();
});

test('Verknüpfen: Passwort, Login und CSRF sind Pflicht', async () => {
  const ctx = setup();
  const u = await localUser(ctx, 'pwcheck');
  assert.equal((await link(ctx, u, { sub: 'x' }, { password: 'falsch-falsch' })).status, 403);
  assert.equal((await call(ctx, u, 'POST', '/api/me/sso', { password: 'correct-horse-battery' }, { csrf: false })).status, 403);
  assert.equal((await fetch(`${ctx.base}/api/me/sso`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM identities').get().c, 0);
  ctx.server.close();
});

test('Verknüpfen: SSO-Identität eines anderen Kontos wird nicht übernommen', async () => {
  const ctx = setup();
  const other = await sso(ctx, { claims: { sub: 'victim-sub', preferred_username: 'victim' } }); // eigenes SSO-Konto existiert
  const otherId = (await me(ctx, other.session)).user.id;
  const u = await localUser(ctx, 'attacker');
  const r = await link(ctx, u, { sub: 'victim-sub' });
  assert.match(r.where, /sso_error=already_linked/);
  assert.equal(ctx.db.prepare("SELECT user_id FROM identities WHERE sub = 'victim-sub'").get().user_id, otherId);
  assert.equal((await meOf(ctx, u)).user.ssoLinked, false);
  ctx.server.close();
});

test('Verknüpfung lösen: nur mit Passwort, nicht bei reinen SSO-Konten', async () => {
  const ctx = setup();
  const u = await localUser(ctx, 'unlinker');
  await link(ctx, u, { sub: 'ul-1' });
  assert.equal((await call(ctx, u, 'DELETE', '/api/me/sso', { password: 'falsch-falsch' })).status, 403);
  assert.equal((await call(ctx, u, 'DELETE', '/api/me/sso', { password: 'correct-horse-battery' })).status, 200);
  assert.equal((await meOf(ctx, u)).user.ssoLinked, false);
  const again = await sso(ctx, { claims: { sub: 'ul-1', preferred_username: 'ul' } });
  assert.notEqual((await me(ctx, again.session)).user.id, u.id); // SSO führt nicht mehr ins alte Konto

  const ssoOnly = await sso(ctx, { claims: { sub: 'only-sso', preferred_username: 'onlysso' } });
  const m = await me(ctx, ssoOnly.session);
  assert.equal(m.user.ssoLinked, true);
  const r = await fetch(`${ctx.base}/api/me/sso`, { method: 'DELETE', headers: { 'content-type': 'application/json', cookie: ssoOnly.session, 'x-csrf-token': m.csrf }, body: '{}' });
  assert.equal(r.status, 400);
  ctx.server.close();
});

test('Verknüpfungs-Flow ist an den Browser gebunden und einmalig', async () => {
  const ctx = setup();
  const u = await localUser(ctx, 'boundlink');
  reset({ sub: 'bound-1' });
  const r1 = await call(ctx, u, 'POST', '/api/me/sso', { password: 'correct-horse-battery' });
  const loc = new URL((await r1.json()).url);
  idpState.nonce = loc.searchParams.get('nonce'); idpState.challenge = loc.searchParams.get('code_challenge');
  const cb = `${ctx.base}/api/auth/oidc/callback?code=abc&state=${loc.searchParams.get('state')}`;
  // Fremder Browser (ohne Bind-Cookie), z. B. Opfer klickt präparierten Link -> abgelehnt, Flow verbraucht
  const foreign = await fetch(cb, { redirect: 'manual', headers: { cookie: 'oidc_bind=anderes' } });
  assert.match(foreign.headers.get('location'), /invalid_state/);
  const own = await fetch(cb, { redirect: 'manual', headers: { cookie: r1.headers.get('set-cookie').split(';')[0] } });
  assert.match(own.headers.get('location'), /invalid_state/); // einmalig
  assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM identities').get().c, 0);
  ctx.server.close();
});
