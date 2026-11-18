'use strict';
// Merging a copy of the data into the database. The fresher record wins (field `u`), and a deletion
// on either side stays a deletion: every delete leaves a mark in the collection `gone`.
const cfg = require('./config');
const db = require('./db');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const goneId = (coll, id) => (coll + '-' + id).slice(0, 64);
const stable = (v) => (Array.isArray(v) ? '[' + v.map(stable).join(',') + ']'
  : isObj(v) ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v === undefined ? null : v));
const same = (a, b) => stable(a) === stable(b);

async function mergeDocs(incoming) {
  const mine = await db.exportAll();
  const myGone = mine.gone || {}, theirGone = isObj(incoming.gone) ? incoming.gone : {};
  const st = { added: 0, updated: 0, deleted: 0, kept: 0 };
  for (const k of cfg.dataCollections) {
    if (k === 'gone') continue;
    const theirs = isObj(incoming[k]) ? incoming[k] : {}, have = mine[k] || {};
    for (const id of Object.keys(theirs)) {
      const tv = theirs[id];
      if (!ID_RE.test(id) || !isObj(tv)) continue;
      const mv = have[id], gid = goneId(k, id), tg = myGone[gid], tu = String(tv.u || '');
      if (!mv) {
        if (tg && String(tg.at || '') >= tu) { st.kept++; continue; }
        await db.setDoc(k, id, tv); st.added++;
        if (tg) await db.deleteDoc('gone', gid);
      } else if (!same(mv, db.sanitize(tv))) {
        if (tu > String(mv.u || '')) { await db.setDoc(k, id, tv); st.updated++; } else st.kept++;
      }
    }
    for (const id of Object.keys(have)) {
      if (Object.prototype.hasOwnProperty.call(theirs, id)) continue;
      const g = theirGone[goneId(k, id)];
      if (isObj(g) && String(g.at || '') > String(have[id].u || '')) { await db.deleteDoc(k, id); st.deleted++; }
    }
  }
  const now = await db.exportAll();
  for (const gid of Object.keys(theirGone)) {
    const g = theirGone[gid];
    if (!ID_RE.test(gid) || !isObj(g) || typeof g.c !== 'string' || typeof g.i !== 'string') continue;
    const live = now[g.c] && now[g.c][g.i], mg = myGone[gid];
    if (live && String(live.u || '') >= String(g.at || '')) continue;
    if (!mg || String(g.at || '') > String(mg.at || '')) await db.setDoc('gone', gid, g);
  }
  return st;
}
module.exports = { mergeDocs, goneId, same };
