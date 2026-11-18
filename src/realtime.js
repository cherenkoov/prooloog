'use strict';
// Live updates: every open dashboard keeps one event stream and hears about changed documents.
const cfg = require('./config');

const clients = new Set();

function attach(req, res, user) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 4000\n\n');
  const c = { res, role: user.role, id: String(user.id), projects: user.projects || null };
  clients.add(c);
  const beat = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) { /* closed */ } }, 25000);
  const done = () => { clearInterval(beat); clients.delete(c); };
  req.on('close', done);
  res.on('error', done);
}

function send(event, payload, ownerOnly) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) {
    if (ownerOnly && c.role !== 'owner') continue;
    try { c.res.write(frame); } catch (e) { clients.delete(c); }
  }
}

// data === null means the document was deleted. src names the browser that made the change.
// prev is the record as it was before the change (null when it is new or unknown).
// A member who sees only some projects hears about a record of theirs, hears a deletion when a record
// leaves their projects, and hears nothing at all about the rest: not even its id.
function publish(coll, id, data, version, src, prev) {
  const ownerOnly = cfg.ownerOnly.has(coll);
  for (const c of clients) {
    if (ownerOnly && c.role !== 'owner') continue;
    let d = data;
    if (c.projects && coll !== 'settings') {
      if (coll === 'projects') { if (!c.projects.includes(id)) continue; }
      else {
        const mine = (x) => !!x && typeof x.project === 'string' && c.projects.includes(x.project);
        if (!mine(data)) { if (!mine(prev)) continue; d = null; }
      }
    }
    try { c.res.write(`event: doc\ndata: ${JSON.stringify({ coll, id, data: d, version: d === null ? 0 : version || 0, src: src || '' })}\n\n`); } catch (e) { clients.delete(c); }
  }
}
// The access of one person changed: their open streams follow the new access at once,
// and their pages load everything again.
function setAccess(userId, role, projects) {
  for (const c of clients) {
    if (c.id !== String(userId) || c.role === 'owner') continue;
    c.role = role === 'editor' ? 'editor' : 'viewer';
    c.projects = Array.isArray(projects) ? projects.slice() : null;
    try { c.res.write('event: reload\ndata: {}\n\n'); } catch (e) { clients.delete(c); }
  }
}
// The access is closed: the page is told to check itself (it meets the gate) and the stream ends.
function dropUser(userId) {
  for (const c of clients) {
    if (c.id !== String(userId) || c.role === 'owner') continue;
    try { c.res.write('event: reload\ndata: {}\n\n'); c.res.end(); } catch (e) { /* already gone */ }
    clients.delete(c);
  }
}
function reloadAll() { send('reload', {}, false); }
function closeAll() { for (const c of clients) { try { c.res.end(); } catch (e) { /* closed */ } } clients.clear(); }

module.exports = { attach, publish, reloadAll, setAccess, dropUser, closeAll, size: () => clients.size };
