// Gemeinsame Test-Helfer
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

export function startApp(opts = {}) {
  process.env.WIKIPEDIA ??= 'off'; // Tests ohne Netzwerk
  const db = openDb(':memory:');
  const server = createApp({ db, secureCookies: false, authLimit: 1000, ...opts }).listen(0);
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}

export function clientFactory(base) {
  let n = 0;
  class Client {
    cookie = ''; csrf = '';
    async req(method, path, body) {
      const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}) },
        body: body === undefined ? (method === 'GET' ? undefined : '{}') : (typeof body === 'string' ? body : JSON.stringify(body)),
      });
      const sc = res.headers.get('set-cookie');
      if (sc && sc.startsWith('sid=')) this.cookie = sc.split(';')[0];
      const data = await res.json().catch(() => ({}));
      if (data.csrf) this.csrf = data.csrf;
      return { status: res.status, data, headers: res.headers };
    }
    get = (p) => this.req('GET', p).then((r) => r.data);
  }
  const signup = async (name = `user${++n}_${Math.random().toString(36).slice(2, 6)}`) => {
    const c = new Client(); c.name = name;
    const r = await c.req('POST', '/api/register', { username: name, password: 'correct-horse-battery' });
    assert.equal(r.status, 201, JSON.stringify(r.data)); c.id = r.data.user.id;
    return c;
  };
  return { Client, signup };
}

export const quote = (o = {}) => ({ text: 'Ein Zitat mit genug Text', person: 'Jemand', source: '', visibility: 'private', ...o });
