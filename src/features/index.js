// Registriert alle Funktionsmodule. Jedes Modul bekommt die App und den gemeinsamen Kontext (ctx).
const modules = [];

export function registerFeatures(app, ctx) {
  for (const register of modules) register(app, ctx);
}
