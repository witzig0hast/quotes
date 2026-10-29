import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, clientFactory } from './helpers.js';
import { totp, base32 } from '../src/features/twofactor.js';

let app, signup, Client;
before(() => { app = startApp(); ({ signup, Client } = clientFactory(app.base)); });
after(() => app.server.close());
const PW = 'correct-horse-battery';
const step = () => Math.floor(Date.now() / 30000);
const login = async (name) => { const c = new Client(); const r = await c.req('POST', '/api/login', { username: name, password: PW }); return { c, r }; };

test('TOTP entspricht RFC 6238 (Testvektor SHA1)', () => {
  const secret = base32(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totp(secret, 1), '287082');            // T=59s -> 94287082 (8-stellig)
  assert.equal(totp(secret, 37037036), '081804');     // T=1111111109 -> 07081804
  assert.equal(totp(secret, 41152263), '005924');     // T=1234567890 -> 89005924 (6-stellig)
});

test('Zwei-Faktor: einrichten, Login in zwei Schritten, Replay-Schutz, Wiederherstellung, ausschalten', async () => {
  const a = await signup();
  assert.deepEqual(await a.get('/api/me/2fa'), { available: true, enabled: false, recoveryLeft: 0 });
  assert.equal((await a.req('POST', '/api/me/2fa/setup', { password: 'falsch-falsch' })).status, 403);
  const setup = (await a.req('POST', '/api/me/2fa/setup', { password: PW })).data;
  assert.match(setup.uri, /^otpauth:\/\/totp\/Quotes%3A/); assert.match(setup.qr, /^data:image\/svg\+xml;base64,/);
  assert.equal((await a.req('POST', '/api/me/2fa/enable', { code: '000000' })).status, 400);
  const en = (await a.req('POST', '/api/me/2fa/enable', { code: totp(setup.secret, step()) })).data;
  assert.equal(en.recoveryCodes.length, 10); assert.match(en.recoveryCodes[0], /^\d{4}-\d{4}-\d{4}$/);
  assert.ok(!JSON.stringify(app.db.prepare('SELECT recovery_codes FROM users WHERE id = ?').get(a.id)).includes(en.recoveryCodes[0])); // nur Hashes

  // Login: erst Ticket, keine Sitzung
  const { c, r } = await login(a.name);
  assert.equal(r.data.twoFactor, true); assert.ok(r.data.ticket); assert.equal(c.cookie, '');
  assert.equal((await c.req('GET', '/api/quotes')).status, 401);
  // Code von gerade eben (beim Aktivieren benutzt) zählt nicht noch einmal
  assert.equal((await c.req('POST', '/api/login/2fa', { ticket: r.data.ticket, code: totp(setup.secret, step()) })).status, 401);
  // Nächster gültiger Schritt (Fenster +1) -> Sitzung
  const ok = await c.req('POST', '/api/login/2fa', { ticket: r.data.ticket, code: totp(setup.secret, step() + 1) });
  assert.equal(ok.status, 200); assert.ok(c.cookie);
  assert.equal((await c.req('POST', '/api/login/2fa', { ticket: r.data.ticket, code: totp(setup.secret, step() + 1) })).status, 401); // Ticket einmalig

  // Brute-Force: nach 5 Fehlversuchen ist das Ticket verbraucht
  const { c: c2, r: r2 } = await login(a.name);
  for (let i = 0; i < 5; i++) assert.equal((await c2.req('POST', '/api/login/2fa', { ticket: r2.data.ticket, code: '123456' })).status, 401);
  // auch ein Wiederherstellungscode hilft mit diesem Ticket nicht mehr
  assert.equal((await c2.req('POST', '/api/login/2fa', { ticket: r2.data.ticket, code: en.recoveryCodes[0] })).status, 401);

  // Wiederherstellungscode: einmalig
  const { c: c3, r: r3 } = await login(a.name);
  const rec = await c3.req('POST', '/api/login/2fa', { ticket: r3.data.ticket, code: en.recoveryCodes[0].replace(/-/g, '') });
  assert.equal(rec.status, 200); assert.equal(rec.data.user.recoveryCodesLeft, 9);
  const { c: c4, r: r4 } = await login(a.name);
  assert.equal((await c4.req('POST', '/api/login/2fa', { ticket: r4.data.ticket, code: en.recoveryCodes[0] })).status, 401);

  // Ausschalten nur mit Passwort + Code
  assert.equal((await a.req('POST', '/api/me/2fa/disable', { password: PW, code: '000000' })).status, 400);
  assert.equal((await a.req('POST', '/api/me/2fa/disable', { password: PW, code: en.recoveryCodes[1] })).status, 200);
  assert.equal((await login(a.name)).r.data.twoFactor, undefined);
});

test('Aktivieren meldet andere Sitzungen ab', async () => {
  const a = await signup();
  const other = (await login(a.name)).c;
  assert.equal((await other.req('GET', '/api/quotes')).status, 200);
  const s = (await a.req('POST', '/api/me/2fa/setup', { password: PW })).data;
  await a.req('POST', '/api/me/2fa/enable', { code: totp(s.secret, step()) });
  assert.equal((await other.req('GET', '/api/quotes')).status, 401);
  assert.equal((await a.req('GET', '/api/quotes')).status, 200);
});
