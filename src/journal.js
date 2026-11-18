'use strict';
// The journal: what was done with the data, by whom and when («Данные» → «Логи» in the dashboard).
// The server writes it for everybody who changes data here: the owner's page, guests, the bot, work chats,
// Claude through the connector. Entries are gathered for a couple of seconds and added to the day's record
// in `audit` (owner only), so a burst of changes costs one write, not one per change.
// The journal is not part of copies, merges or syncs: it is the history of this copy of the data.
const db = require('./db');
const hub = require('./realtime');
const clock = require('./clock');

const KEEP_DAYS = 90, CAP = 400, WAIT_MS = 2000;
const SKIP = new Set(['activity', 'usage', 'gone', 'audit', 'evsubs']); // bookkeeping, not actions
const STATE = ['status', 'st', 'review', 'done'];
let queue = [], timer = null, running = null, pruned = 0, day = '', part = 1;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function same(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isObj(a) && isObj(b)) { const k = Object.keys(a), q = Object.keys(b); return k.length === q.length && k.every((x) => same(a[x], b[x])); }
  return (a === undefined || a === null || a === '') && (b === undefined || b === null || b === '');
}
const titleOf = (o) => String((o && (o.name || o.title || o.text || o.summary || o.from)) || '').replace(/\s+/g, ' ').trim().slice(0, 80);

function soon() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush().catch((e) => console.error('[journal]', e.message)); }, WAIT_MS);
  if (timer.unref) timer.unref();
}
function push(e) { queue.push(e); soon(); }

// a: add | upd | del. prev and next are whole records (null when there is none). by: who, '' for the owner.
function note(a, coll, id, next, prev, by) {
  if (SKIP.has(coll)) return;
  const all = a === 'del' ? prev || {} : next || {};
  const e = { t: new Date().toISOString(), a, c: coll, i: String(id), n: titleOf(all) };
  if (typeof all.project === 'string' && all.project) e.p = all.project;
  if (by) e.by = String(by).slice(0, 60);
  if (a === 'upd') {
    const keys = [...new Set(Object.keys(prev || {}).concat(Object.keys(next || {})))].filter((k) => k !== 'u' && !same((prev || {})[k], (next || {})[k]));
    if (!keys.length || (keys.length === 1 && keys[0] === 'order')) return; // nothing changed, or only the place in a list
    e.f = keys.filter((k) => k !== 'order').slice(0, 6);
    const s = STATE.find((k) => keys.includes(k));
    if (s) e.s = String((next || {})[s]);
  }
  push(e);
}
// Something that is not one record: a copy loaded, a merge, access given or taken away.
function event(kind, text, by) {
  const e = { t: new Date().toISOString(), a: kind === 'acc' ? 'acc' : 'bulk', n: String(text || '').slice(0, 240) };
  if (by) e.by = String(by).slice(0, 60);
  push(e);
}

async function flush() {
  if (running) await running;
  if (!queue.length) return 0;
  const items = queue; queue = [];
  running = (async () => {
    const tz = await clock.appTz(), d = clock.parts(Date.now(), tz).d;
    if (day !== d) { day = d; part = 1; }
    let left = items;
    for (let i = 0; i < 20 && left.length; i++) {
      const id = 's' + d.replace(/-/g, '') + (part > 1 ? '-' + part : '');
      let took = 0;
      const doc = await db.mutateDoc('audit', id, (cur) => {
        const have = Array.isArray(cur.items) ? cur.items : [];
        took = Math.max(0, Math.min(left.length, CAP - have.length));
        return { date: d, items: have.concat(left.slice(0, took)), u: new Date().toISOString() };
      });
      if (took) hub.publish('audit', doc.id, doc.data, doc.version);
      left = left.slice(took);
      if (left.length) part++;
    }
    if (Date.now() - pruned > 864e5) {
      pruned = Date.now();
      const cut = new Date(Date.parse(d + 'T00:00:00Z') - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
      await db.q("DELETE FROM docs WHERE coll = 'audit' AND (data->>'date') < $1", [cut]);
    }
    return items.length;
  })();
  try { return await running; } finally { running = null; }
}
async function stop() { if (timer) { clearTimeout(timer); timer = null; } try { await flush(); } catch (e) { /* the base is closing */ } }

module.exports = { note, event, flush, stop, same, SKIP, KEEP_DAYS };
