'use strict';
// Postgres: a small document store (collection + id -> JSON) and a few helper tables.
const { Pool } = require('pg');
const crypto = require('crypto');

let pool = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  coll text NOT NULL,
  id text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (coll, id)
);
CREATE TABLE IF NOT EXISTS kv (
  k text PRIMARY KEY,
  v jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS members (
  tg_id bigint PRIMARY KEY,
  username text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'viewer',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz
);
CREATE TABLE IF NOT EXISTS invites (
  username text PRIMARY KEY,
  role text NOT NULL DEFAULT 'viewer',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS login_codes (
  code text PRIMARY KEY,
  tg_id bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  used boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS bot_state (
  tg_id bigint PRIMARY KEY,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS files (
  id text PRIMARY KEY,
  mime text NOT NULL,
  bytes bytea NOT NULL,
  size integer NOT NULL,
  owner bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

function needSsl(url) {
  if (process.env.DATABASE_SSL === '0') return false;
  if (process.env.DATABASE_SSL === '1') return true;
  // Render's external database hosts need TLS; the internal ones (no dots) do not.
  return /@[^/@]*\.render\.com/.test(url) || /sslmode=require/.test(url);
}

async function init(url) {
  pool = new Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    ssl: needSsl(url) ? { rejectUnauthorized: false } : undefined,
  });
  pool.on('error', (e) => console.error('[db] idle client error:', e.message));
  await pool.query(SCHEMA);
  return pool;
}
async function close() { if (pool) { await pool.end(); pool = null; } }
const q = (text, params) => pool.query(text, params);

/* ---------- documents ---------- */
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Keep only plain JSON, drop keys that could touch object prototypes.
function sanitize(v, depth = 0) {
  if (depth > 12) throw Object.assign(new Error('too deep'), { code: 'bad_data' });
  if (Array.isArray(v)) return v.map((x) => sanitize(x, depth + 1));
  if (isObj(v)) {
    const out = {};
    for (const k of Object.keys(v)) { if (!BAD_KEYS.has(k)) out[k] = sanitize(v[k], depth + 1); }
    return out;
  }
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return null;
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  return v;
}
// update(): objects merge key by key, arrays and plain values replace.
function merge(a, b) {
  for (const k of Object.keys(b)) {
    if (BAD_KEYS.has(k)) continue;
    if (isObj(b[k]) && isObj(a[k])) merge(a[k], b[k]); else a[k] = b[k];
  }
  return a;
}

async function listDocs(coll) {
  const r = await q('SELECT id, data, version FROM docs WHERE coll = $1 ORDER BY id', [coll]);
  return r.rows;
}
async function getDoc(coll, id) {
  const r = await q('SELECT id, data, version FROM docs WHERE coll = $1 AND id = $2', [coll, id]);
  return r.rows[0] || null;
}
async function setDoc(coll, id, data) {
  const clean = sanitize(data);
  const r = await q(
    `INSERT INTO docs (coll, id, data) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (coll, id) DO UPDATE SET data = EXCLUDED.data, version = docs.version + 1, updated_at = now()
     RETURNING version`, [coll, id, JSON.stringify(clean)]);
  return { id, data: clean, version: r.rows[0].version };
}
async function updateDoc(coll, id, patch) {
  const clean = sanitize(patch);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const cur = await c.query('SELECT data FROM docs WHERE coll = $1 AND id = $2 FOR UPDATE', [coll, id]);
    if (!cur.rows.length) { await c.query('ROLLBACK'); return null; }
    const next = merge(cur.rows[0].data || {}, clean);
    const r = await c.query('UPDATE docs SET data = $3::jsonb, version = version + 1, updated_at = now() WHERE coll = $1 AND id = $2 RETURNING version', [coll, id, JSON.stringify(next)]);
    await c.query('COMMIT');
    return { id, data: next, version: r.rows[0].version };
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* connection is gone */ }
    throw e;
  } finally { c.release(); }
}
async function deleteDoc(coll, id) {
  const r = await q('DELETE FROM docs WHERE coll = $1 AND id = $2', [coll, id]);
  return r.rowCount > 0;
}
async function countDocs() {
  const r = await q('SELECT count(*)::int AS n FROM docs');
  return r.rows[0].n;
}
async function exportAll() {
  const r = await q('SELECT coll, id, data FROM docs ORDER BY coll, id');
  const docs = {};
  for (const row of r.rows) { (docs[row.coll] = docs[row.coll] || {})[row.id] = row.data; }
  return docs;
}
// docs: { collection: { id: data } }. replace=true first clears every allowed collection.
async function importAll(docs, allowed, replace) {
  const c = await pool.connect();
  let n = 0;
  try {
    await c.query('BEGIN');
    if (replace) await c.query('DELETE FROM docs WHERE coll = ANY($1)', [allowed]);
    for (const coll of Object.keys(docs || {})) {
      if (!allowed.includes(coll) || !isObj(docs[coll])) continue;
      for (const id of Object.keys(docs[coll])) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !isObj(docs[coll][id])) continue;
        await c.query(
          `INSERT INTO docs (coll, id, data) VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (coll, id) DO UPDATE SET data = EXCLUDED.data, version = docs.version + 1, updated_at = now()`,
          [coll, id, JSON.stringify(sanitize(docs[coll][id]))]);
        n++;
      }
    }
    await c.query('COMMIT');
    return n;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* connection is gone */ }
    throw e;
  } finally { c.release(); }
}

/* ---------- key-value, members, invites ---------- */
async function kvGet(k) { const r = await q('SELECT v FROM kv WHERE k = $1', [k]); return r.rows.length ? r.rows[0].v : null; }
async function kvSet(k, v) {
  await q('INSERT INTO kv (k, v) VALUES ($1, $2::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = now()', [k, JSON.stringify(v)]);
}
// Sets the value only when the key is free. Returns the value that is stored afterwards.
async function kvClaim(k, v) {
  await q('INSERT INTO kv (k, v) VALUES ($1, $2::jsonb) ON CONFLICT (k) DO NOTHING', [k, JSON.stringify(v)]);
  return kvGet(k);
}
async function getMember(tgId) { const r = await q('SELECT tg_id::text AS id, username, name, role FROM members WHERE tg_id = $1', [tgId]); return r.rows[0] || null; }
async function upsertMember(tgId, username, name, role) {
  await q(`INSERT INTO members (tg_id, username, name, role, last_seen) VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (tg_id) DO UPDATE SET username = EXCLUDED.username, name = EXCLUDED.name, role = EXCLUDED.role, last_seen = now()`,
    [tgId, username || '', name || '', role]);
}
async function touchMember(tgId, username, name) {
  await q('UPDATE members SET username = $2, name = $3, last_seen = now() WHERE tg_id = $1', [tgId, username || '', name || '']);
}
async function listMembers() { const r = await q('SELECT tg_id::text AS id, username, name, role FROM members ORDER BY created_at'); return r.rows; }
async function removeMemberByUsername(username) { const r = await q('DELETE FROM members WHERE lower(username) = $1', [username]); return r.rowCount; }
async function setInvite(username, role) {
  await q('INSERT INTO invites (username, role) VALUES ($1, $2) ON CONFLICT (username) DO UPDATE SET role = EXCLUDED.role, created_at = now()', [username, role]);
}
async function takeInvite(username) { const r = await q('DELETE FROM invites WHERE username = $1 RETURNING role', [username]); return r.rows.length ? r.rows[0].role : null; }
async function listInvites() { const r = await q('SELECT username, role FROM invites ORDER BY created_at'); return r.rows; }
async function removeInvite(username) { const r = await q('DELETE FROM invites WHERE username = $1', [username]); return r.rowCount; }

/* ---------- one-time login links ---------- */
async function createLoginCode(tgId, minutes = 10) {
  const code = crypto.randomBytes(24).toString('base64url');
  await q("DELETE FROM login_codes WHERE expires_at < now() - interval '1 day'");
  await q("INSERT INTO login_codes (code, tg_id, expires_at) VALUES ($1, $2, now() + ($3 || ' minutes')::interval)", [code, tgId, String(minutes)]);
  return code;
}
async function useLoginCode(code) {
  const r = await q('UPDATE login_codes SET used = true WHERE code = $1 AND used = false AND expires_at > now() RETURNING tg_id::text AS id', [code]);
  return r.rows.length ? r.rows[0].id : null;
}

/* ---------- bot conversation state ---------- */
async function getState(tgId) { const r = await q('SELECT state FROM bot_state WHERE tg_id = $1', [tgId]); return r.rows.length ? r.rows[0].state : {}; }
async function setState(tgId, state) {
  await q('INSERT INTO bot_state (tg_id, state) VALUES ($1, $2::jsonb) ON CONFLICT (tg_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()', [tgId, JSON.stringify(state || {})]);
}

/* ---------- uploaded pictures ---------- */
async function putFile(mime, buf, owner) {
  const id = crypto.randomBytes(12).toString('base64url');
  await q('INSERT INTO files (id, mime, bytes, size, owner) VALUES ($1, $2, $3, $4, $5)', [id, mime, buf, buf.length, owner]);
  return id;
}
async function getFile(id) { const r = await q('SELECT mime, bytes FROM files WHERE id = $1', [id]); return r.rows[0] || null; }

module.exports = {
  init, close, q, sanitize, merge,
  listDocs, getDoc, setDoc, updateDoc, deleteDoc, countDocs, exportAll, importAll,
  kvGet, kvSet, kvClaim, getMember, upsertMember, touchMember, listMembers, removeMemberByUsername,
  setInvite, takeInvite, listInvites, removeInvite,
  createLoginCode, useLoginCode, getState, setState, putFile, getFile,
};
