// Registriert alle Funktionsmodule. Jedes Modul bekommt die App und den gemeinsamen Kontext (ctx).
import { registerCollections } from './collections.js';
import { registerPeople } from './people.js';
import { registerImport } from './import.js';
import { registerSocial } from './social.js';
import { registerStats } from './stats.js';
import { registerGroupsExtra } from './groups-extra.js';
import { registerSuggestions } from './suggestions.js';
import { registerAdmin } from './admin.js';

const modules = [registerCollections, registerPeople, registerImport, registerSocial, registerStats, registerGroupsExtra, registerSuggestions, registerAdmin];

export function registerFeatures(app, ctx) {
  for (const register of modules) register(app, ctx);
}
