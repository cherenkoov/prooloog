'use strict';
// A connector for Claude (Model Context Protocol over HTTP): the owner adds its address in Claude as a custom
// connector, and Claude can then read the dashboard data, add records and keep two copies of the data in step.
// The endpoint is stateless: every POST is one JSON-RPC message, the answer is one JSON object.
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');
const hub = require('./realtime');
const sync = require('./sync');
const clock = require('./clock');

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

async function token(renew) {
  let t = renew ? null : await db.kvGet('mcp_token');
  if (!t || typeof t.v !== 'string') { t = { v: crypto.randomBytes(24).toString('base64url'), at: new Date().toISOString() }; await db.kvSet('mcp_token', t); }
  return t.v;
}
async function tokenOk(given) {
  const t = await db.kvGet('mcp_token');
  if (!t || typeof t.v !== 'string' || typeof given !== 'string') return false;
  const a = Buffer.from(t.v), b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const str = (d) => ({ type: 'string', description: d });
const TOOLS = [
  { name: 'status', description: 'Overview of the Prooloog dashboard: how many records each section holds, the app time zone and today\'s date there.',
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'list', description: 'Read the records of one collection. Collections: ' + cfg.collections.join(', ') + '. Optional filter by project id.',
    inputSchema: { type: 'object', properties: { collection: str('Collection name'), project: str('Only records of this project id'), limit: { type: 'integer', description: 'At most this many records (default 200)' } }, required: ['collection'] }, annotations: { readOnlyHint: true } },
  { name: 'get', description: 'Read one record by collection and id.',
    inputSchema: { type: 'object', properties: { collection: str('Collection name'), id: str('Record id') }, required: ['collection', 'id'] }, annotations: { readOnlyHint: true } },
  { name: 'write', description: 'Change records directly: set (whole record), merge (some fields) or delete. Use only when the owner asked for this change. A client message never goes here: save it with add_message so that the owner reviews it first.',
    inputSchema: { type: 'object', properties: { ops: { type: 'array', description: 'Up to 50 changes', items: { type: 'object', properties: { op: { type: 'string', enum: ['set', 'merge', 'delete'] }, collection: str('Collection name'), id: str('Record id: letters, digits, _ or -'), data: { type: 'object', description: 'The record (set) or the fields to change (merge)' } }, required: ['op', 'collection', 'id'] } } }, required: ['ops'] }, annotations: { destructiveHint: true } },
  { name: 'add_message', description: 'Save a message from a client or partner, linked to a project. The project itself does not change: proposed changes wait for the owner\'s review in the dashboard.',
    inputSchema: { type: 'object', properties: { project: str('Project id'), from: str('Who wrote it'), text: str('The message text or transcript'), summary: str('One or two sentences'), date: str('YYYY-MM-DD, default today'), channel: { type: 'string', enum: ['tg', 'wa', 'mail', 'call', 'other'] },
      items: { type: 'array', description: 'Proposed changes for review, up to 8. Shapes: {t:"next",to}, {t:"task",title,due}, {t:"msn",title,date}, {t:"ev",title,date,time}, {t:"cm",text,tag}, {t:"ct",name,role,tg}, {t:"st",to}', items: { type: 'object' } } }, required: ['project', 'text'] } },
  { name: 'sync', description: 'Bring two copies of the dashboard data in step. Send the other copy as docs ({collection: {id: record}}): the fresher record wins, deletions are kept. Returns what changed here and the full data after the merge, to be merged back on the other side.',
    inputSchema: { type: 'object', properties: { docs: { type: 'object', description: 'The other copy: {collection: {id: record}}. Omit to only read the full data.' } } }, annotations: { destructiveHint: true } },
];

const fail = (msg) => { const e = new Error(msg); e.tool = true; return e; };
function coll(name) { if (!cfg.collections.includes(name)) throw fail('Unknown collection: ' + name + '. Known: ' + cfg.collections.join(', ')); return name; }

async function call(name, a) {
  a = isObj(a) ? a : {};
  if (name === 'status') {
    const docs = await db.exportAll(), tz = await clock.appTz(), now = clock.parts(Date.now(), tz), counts = {};
    for (const k of cfg.collections) counts[k] = Object.keys(docs[k] || {}).length;
    return { app: cfg.appName, timeZone: tz, today: now.d, time: now.t, records: counts };
  }
  if (name === 'list') {
    let rows = await db.listDocs(coll(a.collection));
    if (typeof a.project === 'string' && a.project) rows = rows.filter((r) => (a.collection === 'projects' ? r.id === a.project : r.data.project === a.project || (Array.isArray(r.data.projects) && r.data.projects.includes(a.project))));
    const limit = Math.max(1, Math.min(1000, Math.round(+a.limit || 200)));
    return { total: rows.length, records: rows.slice(0, limit).map((r) => ({ id: r.id, data: r.data })) };
  }
  if (name === 'get') {
    if (!ID_RE.test(String(a.id || ''))) throw fail('Bad id');
    const d = await db.getDoc(coll(a.collection), a.id);
    return d ? { id: d.id, data: d.data } : { missing: true };
  }
  if (name === 'write') {
    if (!Array.isArray(a.ops) || !a.ops.length || a.ops.length > 50) throw fail('ops must be a list of 1 to 50 changes');
    for (const o of a.ops) {
      if (!isObj(o) || !['set', 'merge', 'delete'].includes(o.op) || !ID_RE.test(String(o.id || ''))) throw fail('Each change needs op (set, merge, delete), collection and id');
      coll(o.collection);
      if (o.op !== 'delete' && !isObj(o.data)) throw fail('set and merge need data');
    }
    const done = [], at = new Date().toISOString();
    for (const o of a.ops) {
      if (o.op === 'delete') {
        const old = await db.getDoc(o.collection, o.id);
        const was = await db.deleteDoc(o.collection, o.id);
        hub.publish(o.collection, o.id, null, 0, '', old && old.data);
        if (was && o.collection !== 'gone' && o.collection !== 'activity') { const g = await db.setDoc('gone', sync.goneId(o.collection, o.id), { c: o.collection, i: o.id, at, u: at }); hub.publish('gone', g.id, g.data, g.version); }
        done.push({ op: 'delete', collection: o.collection, id: o.id, existed: was });
        continue;
      }
      const data = Object.assign({}, o.data, { u: at }), old = await db.getDoc(o.collection, o.id);
      const d = o.op === 'set' ? await db.setDoc(o.collection, o.id, data) : await db.updateDoc(o.collection, o.id, data);
      if (!d) throw fail('Nothing to merge into: ' + o.collection + '/' + o.id + ' does not exist. Changes before it were saved.');
      hub.publish(o.collection, d.id, d.data, d.version, '', old && old.data);
      // a chat that gets a project, or is kept more fully than before, is told so by the bot
      if (o.collection === 'chats') await require('./groups').onSettings(old && old.data, d).catch(() => {});
      done.push({ op: o.op, collection: o.collection, id: o.id, version: d.version });
    }
    return { done };
  }
  if (name === 'add_message') {
    const text = String(a.text || '').trim();
    if (!text) throw fail('text is empty');
    const p = typeof a.project === 'string' ? await db.getDoc('projects', a.project) : null;
    if (!p) throw fail('Unknown project id. Read the collection projects first.');
    const tz = await clock.appTz(), at = new Date().toISOString();
    const items = (Array.isArray(a.items) ? a.items : []).filter((x) => isObj(x) && typeof x.t === 'string').slice(0, 8);
    const id = 'gc' + crypto.randomBytes(8).toString('hex');
    const d = await db.setDoc('messages', id, {
      text: text.slice(0, 8000), from: String(a.from || '').slice(0, 80), contact: '', project: p.id,
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(a.date || '')) ? a.date : clock.parts(Date.now(), tz).d,
      channel: ['tg', 'wa', 'mail', 'call', 'other'].includes(a.channel) ? a.channel : 'other', summary: String(a.summary || '').slice(0, 600),
      review: 'pending', proposal: items.length ? { items, by: 'claude', at } : null, applied: [], src: 'claude', u: at,
    });
    hub.publish('messages', d.id, d.data, d.version);
    return { saved: { id, project: p.id }, note: 'The message waits for review in the dashboard. Nothing in the project was changed.' };
  }
  if (name === 'sync') {
    let stats = null;
    if (a.docs !== undefined) {
      if (!isObj(a.docs)) throw fail('docs must be an object: {collection: {id: record}}');
      stats = await sync.mergeDocs(a.docs);
      if (stats.added || stats.updated || stats.deleted) hub.reloadAll();
    }
    return { changedHere: stats, exportedAt: new Date().toISOString(), docs: await db.exportAll() };
  }
  throw fail('Unknown tool: ' + name);
}

async function rpc(msg) {
  const id = msg && msg.id, method = msg && msg.method;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
  if (!isObj(msg) || msg.jsonrpc !== '2.0' || typeof method !== 'string') return err(-32600, 'Invalid request');
  if (id === undefined || id === null) return null;                       // a notification: nothing to answer
  if (method === 'initialize') {
    const want = msg.params && msg.params.protocolVersion;
    return ok({ protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[1], capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'prooloog', title: cfg.appName, version: '1.0.0' },
      instructions: 'Prooloog is the owner\'s personal project dashboard. Text is in Russian. A message from a client or partner is saved with add_message and waits for the owner\'s review; direct changes with write are only for what the owner asked for.' });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: TOOLS });
  if (method === 'tools/call') {
    const p = msg.params || {};
    if (!TOOLS.some((t) => t.name === p.name)) return err(-32602, 'Unknown tool: ' + p.name);
    try {
      return ok({ content: [{ type: 'text', text: JSON.stringify(await call(p.name, p.arguments)) }] });
    } catch (e) {
      if (!e.tool) console.error('[mcp] ' + p.name + ' failed:', e.message);
      return ok({ content: [{ type: 'text', text: e.tool ? e.message : 'The server could not do this. Try again.' }], isError: true });
    }
  }
  return err(-32601, 'Method not found: ' + method);
}

// Express handler for POST /mcp/:token (or POST /mcp with the token in the Authorization header).
async function handle(req, res) {
  const given = req.params.token || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!(await tokenOk(given))) return res.status(404).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Not found' } });
  const body = req.body;
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.slice(0, 20).map(rpc))).filter(Boolean);
    return out.length ? res.json(out) : res.status(202).end();
  }
  const out = await rpc(body);
  if (!out) return res.status(202).end();
  res.status(out.error && out.error.code === -32600 ? 400 : 200).json(out);
}
module.exports = { handle, token, call, TOOLS };
