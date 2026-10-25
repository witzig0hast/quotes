// Registriert alle Funktionsmodule. Jedes Modul bekommt die App und den gemeinsamen Kontext (ctx).
import { registerCollections } from './collections.js';
import { registerPeople } from './people.js';
import { registerImport } from './import.js';

const modules = [registerCollections, registerPeople, registerImport];

export function registerFeatures(app, ctx) {
  for (const register of modules) register(app, ctx);
}
