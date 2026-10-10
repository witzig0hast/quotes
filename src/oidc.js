// OpenID Connect (Authorization Code Flow + PKCE) – funktioniert mit authentik, Keycloak, Authelia, Google, Entra ID …
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export class OidcError extends Error {
  constructor(code, detail) { super(detail || code); this.code = code; }
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const rand = (n) => randomBytes(n).toString('base64url');
const FLOW_TTL_MS = 10 * 60 * 1000;
const META_TTL_MS = 60 * 60 * 1000;
// Nur asymmetrische Verfahren; "none" und HS* (Algorithm-Confusion) werden nie akzeptiert.
const ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

function assertSecureUrl(value, what) {
  let u;
  try { u = new URL(value); } catch { throw new OidcError('provider_error', `${what}: ungültige URL`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new OidcError('provider_error', `${what} muss HTTPS nutzen`);
  return u;
}

export function oidcFromEnv(env = process.env) {
  if (!env.OIDC_ISSUER) return null;
  for (const k of ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'PUBLIC_URL']) {
    if (!env[k]) throw new Error(`${k} muss gesetzt sein, wenn OIDC_ISSUER konfiguriert ist.`);
  }
  assertSecureUrl(env.OIDC_ISSUER, 'OIDC_ISSUER');
  assertSecureUrl(env.PUBLIC_URL, 'PUBLIC_URL');
  return createOidc({
    issuer: env.OIDC_ISSUER,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    publicUrl: env.PUBLIC_URL,
    name: env.OIDC_NAME || 'SSO',
    scopes: env.OIDC_SCOPES || 'openid profile email',
    allowSignup: env.OIDC_ALLOW_SIGNUP !== 'false',
    passwordLogin: env.OIDC_PASSWORD_LOGIN !== 'false',
  });
}

export function createOidc({ issuer, clientId, clientSecret, publicUrl, name = 'SSO', scopes = 'openid profile email',
  allowSignup = true, passwordLogin = true, fetch: fetchImpl = globalThis.fetch }) {
  const redirectUri = `${publicUrl.replace(/\/+$/, '')}/api/auth/oidc/callback`;
  let meta = null, metaAt = 0, jwks = null;

  async function getMeta() {
    if (meta && Date.now() - metaAt < META_TTL_MS) return meta;
    const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    let doc;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      doc = await res.json();
    } catch (e) { throw new OidcError('provider_error', `Discovery fehlgeschlagen: ${e.message}`); }
    // Issuer im Dokument muss exakt dem konfigurierten entsprechen (verhindert Mix-up).
    if (doc.issuer !== issuer) throw new OidcError('provider_error', `Issuer-Mismatch: erwartet ${issuer}, erhalten ${doc.issuer}`);
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) assertSecureUrl(doc[k], k);
    if (Array.isArray(doc.code_challenge_methods_supported) && !doc.code_challenge_methods_supported.includes('S256')) {
      throw new OidcError('provider_error', 'Provider unterstützt kein PKCE (S256)');
    }
    meta = doc; metaAt = Date.now();
    jwks = createRemoteJWKSet(new URL(doc.jwks_uri), { timeoutDuration: 8000 });
    return meta;
  }

  /** Startet einen Login: gibt die Redirect-URL und das Browser-Binding-Secret zurück. */
  async function begin(db) {
    const m = await getMeta();
    const state = rand(32), nonce = rand(32), verifier = rand(48), bind = rand(24);
    db.prepare('DELETE FROM oidc_flows WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO oidc_flows (state_hash, bind_hash, nonce, verifier, expires_at) VALUES (?,?,?,?,?)')
      .run(sha256(state), sha256(bind), nonce, verifier, Date.now() + FLOW_TTL_MS);
    const u = new URL(m.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: scopes, state, nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    }).toString();
    return { url: u.toString(), bind };
  }

  /** Schließt den Login ab und gibt die verifizierten Claims zurück. */
  async function complete(db, { state, code, error, bind }) {
    if (typeof state !== 'string' || !state) throw new OidcError('invalid_state');
    const hash = sha256(state);
    const flow = db.prepare('SELECT * FROM oidc_flows WHERE state_hash = ?').get(hash);
    db.prepare('DELETE FROM oidc_flows WHERE state_hash = ?').run(hash); // einmalig
    if (!flow || flow.expires_at < Date.now()) throw new OidcError('invalid_state', 'State unbekannt oder abgelaufen');
    const a = Buffer.from(flow.bind_hash), b = Buffer.from(sha256(String(bind ?? '')));
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new OidcError('invalid_state', 'Browser-Binding stimmt nicht');
    if (error) throw new OidcError(error === 'access_denied' ? 'access_denied' : 'provider_error', `Provider-Fehler: ${String(error).slice(0, 50)}`);
    if (typeof code !== 'string' || !code || code.length > 2048) throw new OidcError('invalid_request');

    const m = await getMeta();
    let tokens;
    try {
      const res = await fetchImpl(m.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId,
          client_secret: clientSecret, code_verifier: flow.verifier }),
        signal: AbortSignal.timeout(8000),
      });
      tokens = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${tokens?.error ?? ''}`);
    } catch (e) { throw new OidcError('provider_error', `Token-Austausch fehlgeschlagen: ${e.message}`); }
    if (typeof tokens.id_token !== 'string') throw new OidcError('provider_error', 'Kein id_token erhalten');

    let payload;
    try {
      ({ payload } = await jwtVerify(tokens.id_token, jwks, { issuer: m.issuer, audience: clientId, algorithms: ALGS, clockTolerance: 30 }));
    } catch (e) { throw new OidcError('invalid_token', `ID-Token ungültig: ${e.message}`); }
    if (payload.nonce !== flow.nonce) throw new OidcError('invalid_token', 'Nonce stimmt nicht');
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw new OidcError('invalid_token', 'sub fehlt');
    return { sub: payload.sub, preferredUsername: str(payload.preferred_username), email: str(payload.email), name: str(payload.name) };
  }

  return { issuer, name, allowSignup, passwordLogin, begin, complete };
}

const str = (v) => (typeof v === 'string' ? v : '');
