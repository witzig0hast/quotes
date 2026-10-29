// Mehrsprachigkeit: Deutsch ist die Quellsprache (Texte stehen im Code), Englisch kommt aus i18n-en.js.
// t('Text {0}', wert) übersetzt und setzt Platzhalter ein; fehlt eine Übersetzung, bleibt der deutsche Text.
import EN from './i18n-en.js';

export const LANG_KEY = 'quotes-lang';
export const LANGS = { de: 'Deutsch', en: 'English' };

function detect() {
  try { const saved = localStorage.getItem(LANG_KEY); if (LANGS[saved]) return saved; } catch { /* privat-Modus */ }
  const nav = (navigator.languages?.[0] ?? navigator.language ?? 'de').toLowerCase();
  return nav.startsWith('de') ? 'de' : 'en';
}

export const LANG = detect();
export const LOCALE = LANG === 'de' ? 'de-DE' : (navigator.language?.toLowerCase().startsWith('en') ? navigator.language : 'en-US');
document.documentElement.lang = LANG;

const DICT = LANG === 'en' ? EN : null;
const fill = (s, args) => (args.length ? s.replace(/\{(\d+)\}/g, (m, i) => String(args[i] ?? '')) : s);

export function t(key, ...args) {
  return fill(DICT?.[key] ?? key, args);
}

// Fehlermeldungen vom Server: exakter Text oder Muster mit Platzhaltern („Höchstens 20 Webhooks.“)
let patterns = null;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function tErr(msg) {
  if (!DICT || typeof msg !== 'string') return msg;
  if (DICT[msg]) return DICT[msg];
  patterns ??= Object.keys(DICT).filter((k) => /\{\d\}/.test(k)).map((k) => {
    const order = [...k.matchAll(/\{(\d)\}/g)].map((m) => Number(m[1]));
    return { re: new RegExp(`^${escapeRe(k).replace(/\\\{\d\\\}/g, '(.+?)')}$`, 's'), order, k };
  });
  for (const { re, order, k } of patterns) {
    const m = msg.match(re);
    if (!m) continue;
    const args = [];
    order.forEach((n, i) => { args[n] = m[i + 1]; });
    return fill(DICT[k], args);
  }
  return msg;
}

/** Hat jemand auf diesem Gerät ausdrücklich eine Sprache gewählt? */
export function hasLangChoice() {
  try { return !!LANGS[localStorage.getItem(LANG_KEY)]; } catch { return false; }
}

/** Sprache wechseln: wird gespeichert und die Seite neu geladen (alle Texte entstehen beim Laden). */
export function setLang(lang) {
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* privat-Modus */ }
  location.reload();
}

// Sprachen für Zitate (Originalsprache). Namen kommen vom Browser in der UI-Sprache.
export const QUOTE_LANGS = ['de', 'en', 'fr', 'es', 'it', 'pt', 'nl', 'la', 'el', 'ru', 'uk', 'pl', 'cs', 'sv', 'da', 'no', 'fi', 'tr', 'ar', 'he', 'fa', 'hi', 'zh', 'ja', 'ko'];
let names = null;
export function langName(code) {
  try { names ??= new Intl.DisplayNames([LOCALE], { type: 'language' }); return names.of(code) ?? code; } catch { return code; }
}
