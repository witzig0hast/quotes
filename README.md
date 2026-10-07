# Quotes

Moderne, sichere Web-App, um Zitate von Personen zu sammeln und mit anderen Nutzern zu teilen.

## Start

```bash
npm install
npm start          # http://localhost:3000
npm test
```

Benötigt Node.js ≥ 22.13 (nutzt das eingebaute `node:sqlite`). Daten liegen in `data/quotes.db`.

| Variable | Bedeutung |
|---|---|
| `PORT` | Port (Standard 3000) |
| `DB_FILE` | Pfad der SQLite-Datei |
| `NODE_ENV=production` | Secure-Cookies, HSTS – nur hinter HTTPS betreiben |
| `TRUST_PROXY` | Anzahl Proxys (z. B. `1`), damit Rate-Limits die echte Client-IP nutzen |

## Funktionen

- Registrierung/Login, Konto löschen
- Zitate mit Person und Quelle anlegen, bearbeiten, löschen, durchsuchen
- Sichtbarkeit pro Zitat: **privat**, **bestimmte Nutzer** oder **öffentlich** (alle angemeldeten Nutzer)
- Ansichten: Entdecken, Meine, Geteilt (mit mir), Favoriten (♥)
- Schwarz-Weiß-Design, Hell-/Dunkelmodus automatisch, responsiv (Handy bis Desktop)

## Sicherheit

- Passwörter mit scrypt + Salt, Mindestlänge 10; Login ohne User-Enumeration (auch Timing)
- Session-Token zufällig, nur als SHA-256-Hash in der DB; Cookie `HttpOnly`, `SameSite=Strict`, `Secure` in Produktion
- CSRF-Token (Header) für alle schreibenden Requests
- Strikte CSP (kein Inline-Script/-Style), Helmet-Header; UI setzt Nutzerinhalte nur per `textContent`
- Parametrisierte SQL-Queries, serverseitige Validierung, Body-Limit, Rate-Limits für Login/Schreiben
- Zugriffsprüfung serverseitig für jedes Zitat (Fremde erhalten 404, sehen keine Empfängerlisten)
