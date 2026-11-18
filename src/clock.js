'use strict';
// The dashboard can follow a time zone of its own (Настройки → Часовой пояс). The server dates things by the same clock.
const cfg = require('./config');
const db = require('./db');

let seen = { at: 0, tz: '' };
async function appTz() {
  if (Date.now() - seen.at < 30000) return seen.tz;
  let tz = cfg.tz;
  try {
    const d = await db.getDoc('settings', 'main');
    const z = d && d.data && d.data.tz;
    if (z && typeof z === 'string') { new Intl.DateTimeFormat('en-CA', { timeZone: z }); tz = z; }
  } catch (e) { /* unknown zone or no settings yet: keep the default */ }
  seen = { at: Date.now(), tz };
  return tz;
}
// { d: '2026-11-18', t: '21:05' } for a moment in a zone
function parts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || cfg.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { d: o.year + '-' + o.month + '-' + o.day, t: o.hour + ':' + o.minute };
}
// The moment (ms) when the clock of a zone shows the given date and time.
function wallToMs(date, time, tz) {
  const guess = Date.parse(date + 'T' + (time || '00:00') + ':00Z');
  if (!isFinite(guess)) return NaN;
  let ms = guess;
  for (let i = 0; i < 3; i++) {
    const p = parts(ms, tz), shown = Date.parse(p.d + 'T' + p.t + ':00Z');
    ms += guess - shown;
  }
  return ms;
}
module.exports = { appTz, parts, wallToMs, forget: () => { seen = { at: 0, tz: '' }; } };
