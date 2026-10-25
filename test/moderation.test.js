import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, clientFactory, quote } from './helpers.js';

let app, signup, Client;
before(() => { process.env.ADMIN_USERS = 'chefin'; app = startApp(); ({ signup, Client } = clientFactory(app.base)); });
after(() => { app.server.close(); delete process.env.ADMIN_USERS; });

test('Gruppen-Rollen: Admin verwaltet Mitglieder, nur Besitzer vergibt Rollen und überträgt', async () => {
  const owner = await signup(), adm = await signup(), m1 = await signup(), m2 = await signup();
  const g = (await owner.req('POST', '/api/groups', { name: 'Team', members: [adm.name, m1.name, m2.name] })).data;
  assert.equal((await m1.req('PATCH', `/api/groups/${g.id}/members/${adm.id}`, { role: 'admin' })).status, 403);
  let d = (await owner.req('PATCH', `/api/groups/${g.id}/members/${adm.id}`, { role: 'admin' })).data;
  assert.deepEqual(d.members.map((m) => m.role), ['owner', 'admin', 'member', 'member']);
  assert.equal((await owner.req('PATCH', `/api/groups/${g.id}/members/${owner.id}`, { role: 'member' })).status, 400);
  // Admin: umbenennen, hinzufügen, normale Mitglieder entfernen – aber keine Admins/Besitzer, kein Löschen
  assert.equal((await adm.req('PATCH', `/api/groups/${g.id}`, { name: 'Team 2' })).status, 200);
  const extra = await signup();
  assert.equal((await adm.req('POST', `/api/groups/${g.id}/members`, { usernames: [extra.name] })).status, 200);
  assert.equal((await adm.req('DELETE', `/api/groups/${g.id}/members/${m2.id}`)).status, 200);
  assert.equal((await adm.req('DELETE', `/api/groups/${g.id}/members/${owner.id}`)).status, 400);
  assert.equal((await adm.req('DELETE', `/api/groups/${g.id}`)).status, 403);
  assert.equal((await m1.req('DELETE', `/api/groups/${g.id}/members/${extra.id}`)).status, 403);
  d = await adm.get(`/api/groups/${g.id}`);
  assert.deepEqual([d.myRole, d.canManage, d.isOwner], ['admin', true, false]);
  // Übertragen
  assert.equal((await adm.req('POST', `/api/groups/${g.id}/transfer`, { userId: m1.id })).status, 403);
  assert.equal((await owner.req('POST', `/api/groups/${g.id}/transfer`, { userId: 999999 })).status, 400);
  d = (await owner.req('POST', `/api/groups/${g.id}/transfer`, { userId: m1.id })).data;
  assert.equal(d.members.find((m) => m.id === m1.id).role, 'owner');
  assert.equal(d.members.find((m) => m.id === owner.id).role, 'admin');
  assert.equal((await m1.get(`/api/groups/${g.id}`)).isOwner, true);
  assert.ok((await m1.get('/api/notifications')).items.some((i) => i.type === 'group_owner'));
  assert.equal((await owner.req('DELETE', `/api/groups/${g.id}/members/${owner.id}`)).status, 200); // Ex-Besitzer kann nun austreten
});

test('Einladungslinks: beitreten, Nutzungslimit, Widerruf, nur Verwalter erstellen', async () => {
  const owner = await signup(), member = await signup(), j1 = await signup(), j2 = await signup();
  const g = (await owner.req('POST', '/api/groups', { name: 'Lesekreis', members: [member.name] })).data;
  assert.equal((await member.req('POST', `/api/groups/${g.id}/invites`, {})).status, 403);
  assert.equal((await owner.req('POST', `/api/groups/${g.id}/invites`, { days: 3 })).status, 400);
  const inv = (await owner.req('POST', `/api/groups/${g.id}/invites`, { days: 7, maxUses: 1 })).data;
  assert.match(inv.link, /^\/g\/[A-Za-z0-9_-]{32}$/);
  const token = inv.link.slice(3);
  const prev = await j1.get(`/api/invites/${token}`);
  assert.deepEqual([prev.group.name, prev.invitedBy, prev.alreadyMember], ['Lesekreis', owner.name, false]);
  assert.equal((await j1.req('POST', `/api/invites/${token}/accept`)).status, 200);
  assert.equal((await j1.get(`/api/groups/${g.id}`)).myRole, 'member');
  assert.equal((await j2.req('POST', `/api/invites/${token}/accept`)).status, 404); // Limit erreicht
  assert.ok((await owner.get('/api/notifications')).items.some((i) => i.type === 'group_join'));
  const inv2 = (await owner.req('POST', `/api/groups/${g.id}/invites`, { days: 1 })).data;
  assert.equal((await owner.get(`/api/groups/${g.id}/invites`)).invites.length, 1); // verbrauchte Einladung nicht mehr aktiv
  await owner.req('DELETE', `/api/groups/${g.id}/invites/${inv2.id}`);
  assert.equal((await j2.req('GET', `/api/invites/${inv2.link.slice(3)}`)).status, 404);
  assert.equal((await j2.req('GET', '/api/invites/abc')).status, 404);
  assert.equal((await new Client().req('POST', `/api/invites/${token}/accept`)).status, 401);
  // Token wird nicht im Klartext gespeichert
  const stored = app.db.prepare('SELECT token_hash FROM group_invites').all().map((r) => r.token_hash);
  assert.ok(!stored.includes(token));
});

test('Verbesserungsvorschläge: nur fremde sichtbare Zitate, Eigentümer entscheidet, Wert wird übernommen', async () => {
  const owner = await signup(), helper = await signup(), stranger = await signup();
  const q = (await owner.req('POST', '/api/quotes', quote({ text: 'Ich denke, also bin ich', person: 'Decartes', visibility: 'public' }))).data;
  const priv = (await owner.req('POST', '/api/quotes', quote({ text: 'privat' }))).data;
  assert.equal((await owner.req('POST', `/api/quotes/${q.id}/suggestions`, { field: 'person', value: 'X' })).status, 400);
  assert.equal((await stranger.req('POST', `/api/quotes/${priv.id}/suggestions`, { field: 'person', value: 'X' })).status, 404);
  assert.equal((await helper.req('POST', `/api/quotes/${q.id}/suggestions`, { field: 'evil', value: 'X' })).status, 400);
  assert.equal((await helper.req('POST', `/api/quotes/${q.id}/suggestions`, { field: 'person', value: 'Decartes' })).status, 400);
  const s = (await helper.req('POST', `/api/quotes/${q.id}/suggestions`, { field: 'person', value: 'René Descartes', note: 'Tippfehler' })).data;
  assert.equal((await helper.req('POST', `/api/quotes/${q.id}/suggestions`, { field: 'person', value: 'R. Descartes' })).status, 400); // schon offen
  const s2 = (await stranger.req('POST', `/api/quotes/${q.id}/suggestions`, { field: 'person', value: 'Descartes' })).data;
  const inc = (await owner.get('/api/suggestions')).incoming;
  assert.equal(inc.length, 2); assert.equal(inc.find((x) => x.id === s.id).current, 'Decartes');
  assert.ok((await owner.get('/api/notifications')).items.some((i) => i.type === 'suggestion'));
  assert.equal((await helper.req('POST', `/api/suggestions/${s.id}`, { action: 'accept' })).status, 404); // nur Eigentümer
  assert.equal((await owner.req('POST', `/api/suggestions/${s.id}`, { action: 'accept' })).status, 200);
  assert.equal((await owner.get(`/api/quotes/${q.id}`)).person, 'René Descartes');
  assert.equal((await owner.req('POST', `/api/suggestions/${s.id}`, { action: 'reject' })).status, 400); // schon entschieden
  assert.equal((await stranger.get('/api/suggestions')).outgoing[0].status, 'rejected'); // überholt
  assert.ok((await helper.get('/api/notifications')).items.some((i) => i.type === 'suggestion_accepted'));
  // Text-Vorschlag aktualisiert auch die Suchfassung
  const t = (await helper.req('POST', `/api/quotes/${q.id}/suggestions`, { field: 'text', value: 'Ich denke, also bin ich.' })).data;
  await owner.req('POST', `/api/suggestions/${t.id}`, { action: 'accept' });
  assert.equal((await owner.get(`/api/quotes-check?text=${encodeURIComponent('ich denke also bin ich')}`)).own.id, q.id);
  void s2;
});

test('Melden + Admin: nur Admins sehen den Bereich; Inhalte löschen; Nutzer sperren', async () => {
  const chefin = await signup('chefin'), troll = await signup(), user = await signup();
  assert.equal((await chefin.get('/api/me')).user.isAdmin, true);
  assert.equal((await user.get('/api/me')).user.isAdmin, false);
  const bad = (await troll.req('POST', '/api/quotes', quote({ text: 'Spam Spam Spam', visibility: 'public' }))).data;
  const hidden = (await troll.req('POST', '/api/quotes', quote({ text: 'privat' }))).data;
  assert.equal((await user.req('POST', '/api/reports', { quoteId: bad.id, reason: 'quatsch' })).status, 400);
  assert.equal((await user.req('POST', '/api/reports', { quoteId: hidden.id, reason: 'spam' })).status, 404);
  assert.equal((await troll.req('POST', '/api/reports', { quoteId: bad.id, reason: 'spam' })).status, 400); // eigenes
  assert.equal((await user.req('POST', '/api/reports', { quoteId: bad.id, reason: 'spam', note: 'Werbung' })).status, 201);
  assert.equal((await user.req('POST', '/api/reports', { quoteId: bad.id, reason: 'spam' })).data.duplicate, true);
  const c = (await troll.req('POST', `/api/quotes/${bad.id}/comments`, { body: 'Kauft bei mir!' })).data;
  assert.equal((await user.req('POST', '/api/reports', { commentId: c.id, reason: 'spam' })).status, 201);
  // Nicht-Admins: Admin-API existiert für sie nicht
  for (const p of ['/api/admin/overview', '/api/admin/reports', '/api/admin/users']) assert.equal((await user.req('GET', p)).status, 404);
  const ov = await chefin.get('/api/admin/overview');
  assert.equal(ov.openReports, 2);
  const reps = (await chefin.get('/api/admin/reports')).reports;
  const qRep = reps.find((r) => r.kind === 'quote');
  assert.equal(qRep.snapshot, '„Spam Spam Spam“ — Jemand'); assert.equal(qRep.target, troll.name);
  // Kommentar löschen, Zitat-Meldung verwerfen
  assert.equal((await chefin.req('POST', `/api/admin/reports/${reps.find((r) => r.kind === 'comment').id}`, { action: 'delete' })).status, 200);
  assert.equal((await user.get(`/api/quotes/${bad.id}`)).comments, 0);
  assert.equal((await chefin.req('POST', `/api/admin/reports/${qRep.id}`, { action: 'dismiss' })).status, 200);
  assert.equal((await chefin.get('/api/admin/overview')).openReports, 0);
  assert.equal((await chefin.get('/api/admin/reports?status=dismissed')).reports.length, 1);
  // Sperren: sofort abgemeldet, kein Login mehr; Admin kann sich nicht selbst sperren
  const tu = (await chefin.get(`/api/admin/users?q=${troll.name}`)).users[0];
  assert.equal(tu.reports, 2);
  assert.equal((await chefin.req('POST', `/api/admin/users/${chefin.id}`, { disabled: true })).status, 403);
  await chefin.req('POST', `/api/admin/users/${tu.id}`, { disabled: true });
  assert.equal((await troll.req('GET', '/api/quotes')).status, 401);
  const relog = await new Client().req('POST', '/api/login', { username: troll.name, password: 'correct-horse-battery' });
  assert.equal(relog.status, 403);
  await chefin.req('POST', `/api/admin/users/${tu.id}`, { disabled: false });
  assert.equal((await new Client().req('POST', '/api/login', { username: troll.name, password: 'correct-horse-battery' })).status, 200);
  // Admin ernennen / fest konfigurierte Admins bleiben
  await chefin.req('POST', `/api/admin/users/${user.id}`, { admin: true });
  assert.equal((await user.get('/api/me')).user.isAdmin, true);
  assert.equal((await user.req('POST', `/api/admin/users/${chefin.id}`, { admin: false })).status, 400);
});

test('Gemeldetes Zitat löschen: alle Meldungen dazu erledigt, Inhalt weg', async () => {
  const chefin = await new Client().req('POST', '/api/login', { username: 'chefin', password: 'correct-horse-battery' });
  const admin = new Client(); await admin.req('POST', '/api/login', { username: 'chefin', password: 'correct-horse-battery' });
  void chefin;
  const author = await signup(), r1 = await signup(), r2 = await signup();
  const q = (await author.req('POST', '/api/quotes', quote({ text: 'beleidigend', visibility: 'public' }))).data;
  await r1.req('POST', '/api/reports', { quoteId: q.id, reason: 'offensive' });
  await r2.req('POST', '/api/reports', { quoteId: q.id, reason: 'offensive' });
  const open = (await admin.get('/api/admin/reports')).reports.filter((r) => r.snapshot.includes('beleidigend'));
  assert.equal(open.length, 2);
  assert.equal((await admin.req('POST', `/api/admin/reports/${open[0].id}`, { action: 'delete' })).status, 200);
  assert.equal((await r1.req('GET', `/api/quotes/${q.id}`)).status, 404);
  const resolved = (await admin.get('/api/admin/reports?status=resolved')).reports.filter((r) => r.snapshot.includes('beleidigend'));
  assert.equal(resolved.length, 2);
  assert.equal(resolved[0].stillExists, false);
});
