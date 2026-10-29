// Serverseitige Texte (Push, E-Mails) in der Sprache des Nutzers. Nutzt dasselbe Wörterbuch wie die Oberfläche.
import EN from '../public/i18n-en.js';

export const LANGS = ['de', 'en'];

/** tr('en', 'Hallo @{0}', name) -> "Hello @name"; ohne Übersetzung bleibt der deutsche Text. */
export function tr(lang, key, ...args) {
  const s = (lang === 'en' ? EN[key] : null) ?? key;
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => String(args[i] ?? '')) : s;
}
