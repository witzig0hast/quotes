import { openDb } from './db.js';
import { createApp } from './app.js';

const db = openDb();
const app = createApp({ db });
const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => console.log(`Quotes läuft auf http://localhost:${port}`));

// Abgelaufene Sessions regelmäßig entfernen
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600 * 1000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
