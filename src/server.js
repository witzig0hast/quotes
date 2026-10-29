import { openDb } from './db.js';
import { createApp } from './app.js';
import { oidcFromEnv } from './oidc.js';

const db = openDb();
const oidc = oidcFromEnv();
const app = createApp({ db, oidc });
const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => {
  console.log(`Quotes läuft auf http://localhost:${port}`);
  if (oidc) console.log(`SSO aktiv: ${oidc.name} (${oidc.issuer})`);
  const ctx = app.locals.ctx;
  console.log(`Push: ${ctx.pushEnabled ? 'aktiv' : 'aus (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY fehlen)'} · E-Mail: ${ctx.emailEnabled ? 'aktiv' : 'aus (SMTP_URL/PUBLIC_URL fehlen)'}`);
});

// Wochenrückblick: stündlich prüfen, wer fällig ist (jeder bekommt höchstens eine Mail pro Woche)
if (app.locals.ctx.emailEnabled) {
  const runDigest = () => app.locals.ctx.runDigest().then((r) => r.sent && console.log(`[digest] ${r.sent} Mail(s) gesendet`)).catch((e) => console.error('[digest]', e));
  setTimeout(runDigest, 60_000).unref();
  setInterval(runDigest, 3600 * 1000).unref();
}

// Abgelaufene Sessions regelmäßig entfernen
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600 * 1000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
