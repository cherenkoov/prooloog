'use strict';
// Who is asking: Telegram Mini App sign-in, signed sessions, roles.
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');

const SESSION_DAYS = 30;

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Telegram signs the data it hands to a Mini App with the bot token.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function checkInitData(initData, maxAgeSec = 86400) {
  if (!cfg.botToken || typeof initData !== 'string' || initData.length > 8192) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(cfg.botToken).digest();
  const mine = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (!safeEqual(mine, hash)) return null;
  const at = +p.get('auth_date');
  if (!at || Math.abs(Date.now() / 1000 - at) > maxAgeSec) return null;
  try {
    const u = JSON.parse(p.get('user') || 'null');
    return u && /^\d{1,20}$/.test(String(u.id)) ? u : null;
  } catch (e) { return null; }
}

function signSession(tgId) {
  const body = Buffer.from(JSON.stringify({ u: String(tgId), e: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 })).toString('base64url');
  const sig = crypto.createHmac('sha256', cfg.sessionSecret).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifySession(token) {
  if (typeof token !== 'string' || token.length > 600) return null;
  const i = token.indexOf('.');
  if (i < 1) return null;
  const body = token.slice(0, i), sig = token.slice(i + 1);
  const mine = crypto.createHmac('sha256', cfg.sessionSecret).update(body).digest('base64url');
  if (!safeEqual(mine, sig)) return null;
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return o && /^\d{1,20}$/.test(String(o.u)) && +o.e > Date.now() / 1000 ? String(o.u) : null;
  } catch (e) { return null; }
}

const fullName = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ').slice(0, 80);

async function ownerId() {
  if (cfg.ownerId) return cfg.ownerId;
  const o = await db.kvGet('owner');
  return o && o.id ? String(o.id) : '';
}

// The role of a Telegram user: owner, editor, viewer, or null for strangers.
// A user object (with username) may claim ownership or an invite; a bare id may not.
async function roleOf(user) {
  const id = String(user.id);
  const username = String(user.username || '').toLowerCase();
  let owner = await ownerId();
  if (!owner && cfg.ownerUsername && username && username === cfg.ownerUsername) {
    const claimed = await db.kvClaim('owner', { id, username });
    owner = String(claimed.id);
  }
  if (owner && owner === id) {
    if (username || user.first_name) await db.kvSet('owner_profile', { id, username, name: fullName(user) });
    return 'owner';
  }
  const m = await db.getMember(id);
  if (m) {
    if (username || user.first_name) await db.touchMember(id, username, fullName(user));
    return m.role === 'editor' ? 'editor' : 'viewer';
  }
  if (username) {
    const invited = await db.takeInvite(username);
    if (invited) {
      await db.upsertMember(id, username, fullName(user), invited === 'editor' ? 'editor' : 'viewer');
      return invited === 'editor' ? 'editor' : 'viewer';
    }
  }
  return null;
}

// The projects a member may see: null for all of them, or a list of project ids.
async function scopeOf(id) {
  const m = await db.getMember(String(id));
  return m && Array.isArray(m.projects) ? m.projects.filter((x) => typeof x === 'string') : null;
}
// May a member with this project list see the record? Projects are matched by id, everything else by its `project`.
function sees(projects, coll, id, data) {
  if (projects === null || projects === undefined) return true;
  if (coll === 'settings') return true;
  if (coll === 'projects') return projects.includes(id);
  return !!data && typeof data.project === 'string' && projects.includes(data.project);
}

async function profileOf(id, role) {
  if (role === 'owner') {
    const p = await db.kvGet('owner_profile');
    return { id, name: (p && p.name) || '', username: (p && p.username) || '' };
  }
  const m = await db.getMember(id);
  return { id, name: (m && m.name) || '', username: (m && m.username) || '' };
}

function tokenFrom(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return typeof req.query.t === 'string' ? req.query.t : '';
}

// need: 'read' (any member), 'write' (owner or editor), 'owner'.
function guard(need = 'read') {
  return async (req, res, next) => {
    const id = verifySession(tokenFrom(req));
    if (!id) return res.status(401).json({ error: 'unauthorized' });
    const role = await roleOf({ id });
    if (!role) return res.status(403).json({ error: 'no_access' });
    if (need === 'owner' && role !== 'owner') return res.status(403).json({ error: 'forbidden' });
    if (need === 'write' && role === 'viewer') return res.status(403).json({ error: 'forbidden' });
    req.user = { id, role, projects: role === 'owner' ? null : await scopeOf(id) };
    next();
  };
}

module.exports = { checkInitData, signSession, verifySession, roleOf, profileOf, ownerId, guard, fullName, scopeOf, sees };
