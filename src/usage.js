'use strict';
// How much of the Claude API the app itself uses: requests, tokens and an estimate of the cost, one record per day.
const cfg = require('./config');
const db = require('./db');
const hub = require('./realtime');
const clock = require('./clock');

const num = (v) => (Number.isFinite(+v) && +v > 0 ? Math.round(+v) : 0);
function costOf(model, u) {
  const p = cfg.aiPrices[model];
  if (!p) return null;
  return (u.in * p.in + u.out * p.out + u.cr * p.cr + u.cw * p.cw) / 1e6;
}
// usage: the `usage` object of a Messages API answer. src: 'page' or 'bot'.
async function record(model, usage, src) {
  const u = { in: num(usage && usage.input_tokens), out: num(usage && usage.output_tokens), cr: num(usage && usage.cache_read_input_tokens), cw: num(usage && usage.cache_creation_input_tokens) };
  const cost = costOf(model, u), date = clock.parts(Date.now(), await clock.appTz()).d, key = src === 'bot' ? 'bot' : 'page';
  const add = (o) => {
    o.n = (+o.n || 0) + 1; o.in = (+o.in || 0) + u.in; o.out = (+o.out || 0) + u.out; o.cr = (+o.cr || 0) + u.cr; o.cw = (+o.cw || 0) + u.cw;
    if (cost !== null) o.cost = Math.round(((+o.cost || 0) + cost) * 1e6) / 1e6;
    return o;
  };
  const d = await db.mutateDoc('usage', 'u' + date.replace(/-/g, ''), (cur) => {
    const next = add(Object.assign({ date, src: 'server' }, cur));
    next.by = Object.assign({}, cur.by); next.by[key] = add(Object.assign({}, next.by[key]));
    next.models = Object.assign({}, cur.models); next.models[model] = (+next.models[model] || 0) + 1;
    if (cost === null) next.unpriced = (+cur.unpriced || 0) + 1;
    next.u = new Date().toISOString();
    return next;
  });
  hub.publish('usage', d.id, d.data, d.version);
  return d;
}
async function month(prefix) {
  const out = { n: 0, in: 0, out: 0, cost: 0, days: 0 };
  for (const x of await db.listDocs('usage')) {
    if (!String(x.data.date || '').startsWith(prefix)) continue;
    out.n += +x.data.n || 0; out.in += +x.data.in || 0; out.out += +x.data.out || 0; out.cost += +x.data.cost || 0; out.days++;
  }
  return out;
}
module.exports = { record, month, costOf };
