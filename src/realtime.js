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
  const c = { res, role: user.role };
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
function publish(coll, id, data, version, src) {
  send('doc', { coll, id, data, version: version || 0, src: src || '' }, cfg.ownerOnly.has(coll));
}
function reloadAll() { send('reload', {}, false); }
function closeAll() { for (const c of clients) { try { c.res.end(); } catch (e) { /* closed */ } } clients.clear(); }

module.exports = { attach, publish, reloadAll, closeAll, size: () => clients.size };
