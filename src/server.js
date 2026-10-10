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
});

// Abgelaufene Sessions regelmäßig entfernen
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600 * 1000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
