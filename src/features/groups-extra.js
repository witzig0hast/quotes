// Gruppen: Rollen (Admin), Besitz übertragen, Einladungslinks.
import { randomBytes, createHash } from 'node:crypto';
import { bad, notFound, forbidden, handler, intParam } from '../util.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function registerGroupsExtra(app, ctx) {
  const { db, requireAuth, writeLimiter, readLimiter, tx, notify, groupDetails, groupGid, isManager, memberRole, MAX_MEMBERS } = ctx;

  // Rolle ändern (nur Besitzer): admin <-> member
  app.patch('/api/groups/:gid/members/:uid', requireAuth, writeLimiter, handler((req, res) => {
    const { gid, role } = groupGid(req);
    if (role !== 'owner') throw forbidden('Nur der Besitzer kann Rollen vergeben.');
    const uid = intParam(req.params.uid);
    const target = memberRole(gid, uid);
    if (!target) throw notFound('Mitglied nicht gefunden.');
    if (target === 'owner') throw bad('Die Rolle des Besitzers lässt sich nicht ändern – übertrage die Gruppe stattdessen.');
    if (!['admin', 'member'].includes(req.body?.role)) throw bad('Rolle muss "admin" oder "member" sein.');
    db.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?').run(req.body.role, gid, uid);
    res.json(groupDetails(gid, req.user.id));
  }));

  // Besitz übertragen (nur Besitzer); der bisherige Besitzer wird Admin
  app.post('/api/groups/:gid/transfer', requireAuth, writeLimiter, handler((req, res) => {
    const { gid, role } = groupGid(req);
    if (role !== 'owner') throw forbidden('Nur der Besitzer kann die Gruppe übertragen.');
    const uid = intParam(req.body?.userId);
    if (uid === req.user.id) throw bad('Du bist bereits Besitzer.');
    if (!memberRole(gid, uid)) throw bad('Nur an Mitglieder der Gruppe übertragbar.');
    tx(() => {
      db.prepare("UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?").run(gid, req.user.id);
      db.prepare("UPDATE group_members SET role = 'owner' WHERE group_id = ? AND user_id = ?").run(gid, uid);
      db.prepare('UPDATE user_groups SET owner_id = ? WHERE id = ?').run(uid, gid);
    });
    notify([uid], 'group_owner', req.user.id, { groupId: gid });
    res.json(groupDetails(gid, req.user.id));
  }));

  // --- Einladungslinks (Besitzer & Admins) ---
  const shapeInvite = (i) => ({ id: i.id, expiresAt: i.expires_at, maxUses: i.max_uses, uses: i.uses, createdBy: i.creator, createdAt: i.created_at });

  app.get('/api/groups/:gid/invites', requireAuth, handler((req, res) => {
    const { gid, role } = groupGid(req);
    if (!isManager(role)) throw forbidden('Nur Besitzer und Admins sehen Einladungen.');
    const rows = db.prepare(`SELECT i.*, u.username AS creator FROM group_invites i JOIN users u ON u.id = i.created_by
                             WHERE i.group_id = ? AND i.expires_at > ? AND (i.max_uses IS NULL OR i.uses < i.max_uses)
                             ORDER BY i.created_at DESC`).all(gid, Date.now());
    res.json({ invites: rows.map(shapeInvite) });
  }));

  app.post('/api/groups/:gid/invites', requireAuth, writeLimiter, handler((req, res) => {
    const { gid, role } = groupGid(req);
    if (!isManager(role)) throw forbidden('Nur Besitzer und Admins können einladen.');
    const days = Number(req.body?.days ?? 7);
    const maxUses = req.body?.maxUses == null || req.body.maxUses === '' ? null : Number(req.body.maxUses);
    if (![1, 7, 30].includes(days)) throw bad('Gültigkeit: 1, 7 oder 30 Tage.');
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100)) throw bad('Maximale Nutzungen: 1–100 oder unbegrenzt.');
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM group_invites WHERE group_id = ? AND expires_at > ?').get(gid, Date.now());
    if (n >= 20) throw bad('Höchstens 20 aktive Einladungslinks pro Gruppe.');
    const token = randomBytes(24).toString('base64url');
    const id = Number(db.prepare('INSERT INTO group_invites (token_hash, group_id, created_by, expires_at, max_uses, created_at) VALUES (?,?,?,?,?,?)')
      .run(sha256(token), gid, req.user.id, Date.now() + days * 86_400_000, maxUses, Date.now()).lastInsertRowid);
    // Der Klartext-Token wird nur jetzt einmal zurückgegeben
    res.status(201).json({ id, link: `/g/${token}`, expiresAt: Date.now() + days * 86_400_000, maxUses });
  }));

  app.delete('/api/groups/:gid/invites/:iid', requireAuth, writeLimiter, handler((req, res) => {
    const { gid, role } = groupGid(req);
    if (!isManager(role)) throw forbidden('Nur Besitzer und Admins können Einladungen widerrufen.');
    db.prepare('DELETE FROM group_invites WHERE id = ? AND group_id = ?').run(intParam(req.params.iid), gid);
    res.json({ ok: true });
  }));

  const findInvite = (token) => {
    if (!/^[A-Za-z0-9_-]{32}$/.test(String(token))) throw notFound('Diese Einladung ist ungültig.');
    const i = db.prepare(`SELECT i.*, g.name AS group_name, u.username AS creator,
                            (SELECT COUNT(*) FROM group_members m WHERE m.group_id = i.group_id) AS members
                          FROM group_invites i JOIN user_groups g ON g.id = i.group_id JOIN users u ON u.id = i.created_by
                          WHERE i.token_hash = ?`).get(sha256(token));
    if (!i) throw notFound('Diese Einladung ist ungültig oder wurde widerrufen.');
    if (i.expires_at <= Date.now()) throw notFound('Diese Einladung ist abgelaufen.');
    if (i.max_uses !== null && i.uses >= i.max_uses) throw notFound('Diese Einladung wurde bereits vollständig genutzt.');
    return i;
  };

  // Vorschau (angemeldet): Gruppenname, Mitgliederzahl, Einladender
  app.get('/api/invites/:token', requireAuth, readLimiter, handler((req, res) => {
    const i = findInvite(req.params.token);
    res.json({ group: { id: i.group_id, name: i.group_name, members: i.members }, invitedBy: i.creator, alreadyMember: !!memberRole(i.group_id, req.user.id) });
  }));

  app.post('/api/invites/:token/accept', requireAuth, writeLimiter, handler((req, res) => {
    const i = findInvite(req.params.token);
    if (memberRole(i.group_id, req.user.id)) return res.json(groupDetails(i.group_id, req.user.id));
    if (i.members >= MAX_MEMBERS) throw bad(`Die Gruppe ist voll (max. ${MAX_MEMBERS} Mitglieder).`);
    tx(() => {
      // Nutzung atomar zählen, damit max_uses auch bei gleichzeitigen Klicks hält
      const r = db.prepare('UPDATE group_invites SET uses = uses + 1 WHERE id = ? AND (max_uses IS NULL OR uses < max_uses)').run(i.id);
      if (!r.changes) throw notFound('Diese Einladung wurde bereits vollständig genutzt.');
      db.prepare("INSERT INTO group_members (group_id, user_id, role, added_at) VALUES (?,?,'member',?)").run(i.group_id, req.user.id, Date.now());
    });
    notify([i.created_by], 'group_join', req.user.id, { groupId: i.group_id });
    res.json(groupDetails(i.group_id, req.user.id));
  }));
}
