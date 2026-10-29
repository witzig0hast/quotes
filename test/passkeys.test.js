import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign, randomBytes } from 'node:crypto';
import { startApp, clientFactory } from './helpers.js';
import { totp } from '../src/features/twofactor.js';

let app, signup, Client;
before(() => { app = startApp(); ({ signup, Client } = clientFactory(app.base)); });
after(() => app.server.close());
const PW = 'correct-horse-battery';
const sha = (b) => createHash('sha256').update(b).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');

// Minimaler CBOR-Encoder (nur was Authenticator-Daten brauchen)
function cbor(v) {
  const head = (major, n) => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n])
    : Buffer.from([(major << 5) | 25, n >> 8, n & 255]));
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: unsupported');
}

/** Software-Authenticator (ES256, "none"-Attestierung), wie ein Passkey im Browser. */
function authenticator({ uv = true } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = randomBytes(16);
  let counter = 0, userHandle = null;
  const flags = (extra) => (0x01 | (uv ? 0x04 : 0) | extra);
  const clientData = (type, challenge, origin) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: b64u(credId),
    register(options, origin) {
      userHandle = options.user.id;
      const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
      const len = Buffer.from([credId.length >> 8, credId.length & 255]);
      const authData = Buffer.concat([sha(options.rp.id), Buffer.from([flags(0x40)]), Buffer.alloc(4), Buffer.alloc(16), len, credId, cose]);
      const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientData('webauthn.create', options.challenge, origin)), attestationObject: b64u(att), transports: ['internal'] } };
    },
    login(options, origin, rpId) {
      const cnt = Buffer.alloc(4); cnt.writeUInt32BE(++counter);
      const authData = Buffer.concat([sha(rpId), Buffer.from([flags(0)]), cnt]);
      const cd = clientData('webauthn.get', options.challenge, origin);
      const signature = sign('sha256', Buffer.concat([authData, sha(cd)]), privateKey);
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(signature), userHandle } };
    },
  };
}

async function addPasskey(c, auth, name) {
  const { data } = await c.req('POST', '/api/me/passkeys/options', { password: PW });
  assert.equal(data.options.rp.id, '127.0.0.1');
  return c.req('POST', '/api/me/passkeys', { flow: data.flow, response: auth.register(data.options, app.base), name });
}
async function passkeyLogin(auth, opts = {}) {
  const c = new Client();
  const { data } = await c.req('POST', '/api/login/passkey/options');
  const response = auth.login(data.options, opts.origin ?? app.base, '127.0.0.1');
  return { c, r: await c.req('POST', '/api/login/passkey', { flow: data.flow, response }), flow: data.flow, response };
}

test('Passkeys: registrieren (nur mit Passwort), anmelden ohne Passwort, umbenennen, löschen', async () => {
  const a = await signup();
  const auth = authenticator();
  assert.equal((await a.req('POST', '/api/me/passkeys/options', { password: 'falsch-falsch' })).status, 403);
  const add = await addPasskey(a, auth, 'Mein Handy');
  assert.equal(add.status, 201, JSON.stringify(add.data));
  assert.equal(add.data.items.length, 1); assert.equal(add.data.items[0].name, 'Mein Handy');
  // Gleicher Schlüssel nicht doppelt
  assert.equal((await addPasskey(a, auth)).status, 409);

  const { c, r } = await passkeyLogin(auth);
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.user.id, a.id); assert.ok(c.cookie);
  assert.equal((await c.req('GET', '/api/me')).status, 200);
  assert.ok(app.db.prepare('SELECT last_used_at FROM passkeys').get().last_used_at);

  const pid = add.data.items[0].id;
  assert.equal((await a.req('PATCH', `/api/me/passkeys/${pid}`, { name: 'Laptop' })).data.items[0].name, 'Laptop');
  const b = await signup();
  assert.equal((await b.req('DELETE', `/api/me/passkeys/${pid}`)).status, 404); // fremder Passkey
  assert.equal((await a.req('DELETE', `/api/me/passkeys/${pid}`)).data.items.length, 0);
  assert.equal((await passkeyLogin(auth)).r.status, 401); // gelöscht -> keine Anmeldung mehr
});

test('Passkeys: Challenge einmalig, falsche Herkunft und gesperrte Konten abgelehnt', async () => {
  const a = await signup();
  const auth = authenticator();
  assert.equal((await addPasskey(a, auth)).status, 201);
  // Replay derselben Antwort / desselben Ablaufs
  const first = await passkeyLogin(auth);
  assert.equal(first.r.status, 200);
  assert.equal((await new Client().req('POST', '/api/login/passkey', { flow: first.flow, response: first.response })).status, 400);
  // Phishing-Seite (andere Origin) wird abgelehnt
  assert.equal((await passkeyLogin(auth, { origin: 'https://quotes.evil.example' })).r.status, 401);
  // Fremde Signatur (anderer Schlüssel mit gleicher ID) abgelehnt
  const fake = authenticator(); fake.id = auth.id;
  const c = new Client(); const { data } = await c.req('POST', '/api/login/passkey/options');
  const resp = fake.login(data.options, app.base, '127.0.0.1'); resp.id = resp.rawId = auth.id;
  assert.equal((await c.req('POST', '/api/login/passkey', { flow: data.flow, response: resp })).status, 401);
  // Gesperrt
  app.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(a.id);
  assert.equal((await passkeyLogin(auth)).r.status, 403);
});

test('Passkeys: ohne Nutzer-Verifizierung braucht ein 2FA-Konto zusätzlich den Code', async () => {
  const a = await signup();
  const setup = (await a.req('POST', '/api/me/2fa/setup', { password: PW })).data;
  const step = Math.floor(Date.now() / 30000);
  assert.equal((await a.req('POST', '/api/me/2fa/enable', { code: totp(setup.secret, step) })).status, 200);
  const key = authenticator({ uv: false });
  assert.equal((await addPasskey(a, key)).status, 201);
  const { c, r } = await passkeyLogin(key);
  assert.equal(r.data.twoFactor, true); assert.equal(c.cookie, '');
  const ok = await c.req('POST', '/api/login/2fa', { ticket: r.data.ticket, code: totp(setup.secret, step + 1) });
  assert.equal(ok.status, 200);
  // Mit Verifizierung (Fingerabdruck/PIN) genügt der Passkey allein
  const bio = authenticator();
  assert.equal((await addPasskey(a, bio)).status, 201);
  assert.equal((await passkeyLogin(bio)).r.status, 200);
});
