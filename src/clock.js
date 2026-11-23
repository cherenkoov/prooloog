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
// 'UTC+5:30' for a moment in a zone
function offsetLabel(ms, tz) {
  const p = parts(ms, tz), min = Math.round((Date.parse(p.d + 'T' + p.t + ':00Z') - ms) / 60000), a = Math.abs(min);
  return 'UTC' + (min < 0 ? '−' : '+') + Math.floor(a / 60) + (a % 60 ? ':' + String(a % 60).padStart(2, '0') : '');
}
// A meeting can carry the zone its time was set in (`zone`). Its date and time are still kept by the app's clock,
// so the calendar and the reminders work as before; the zone only says how to tell people when it is.
const ZONES = {
  'Europe/Moscow': { ru: 'МСК', en: 'Moscow' }, 'Asia/Tbilisi': { ru: 'Тбилиси', en: 'Tbilisi' }, 'Africa/Cairo': { ru: 'Каир', en: 'Cairo' },
  'Europe/Istanbul': { ru: 'Стамбул', en: 'Istanbul' }, 'Asia/Dubai': { ru: 'Дубай', en: 'Dubai' }, 'Asia/Kolkata': { ru: 'Индия', en: 'India' },
  'Europe/Kiev': { ru: 'Киев', en: 'Kyiv' }, 'Asia/Almaty': { ru: 'Алматы', en: 'Almaty' }, 'Asia/Bangkok': { ru: 'Бангкок', en: 'Bangkok' },
  'Asia/Makassar': { ru: 'Бали', en: 'Bali' }, 'Europe/Berlin': { ru: 'Берлин', en: 'Berlin' }, 'Europe/London': { ru: 'Лондон', en: 'London' },
  'Europe/Lisbon': { ru: 'Лиссабон', en: 'Lisbon' }, 'America/New_York': { ru: 'Нью-Йорк', en: 'New York' }, 'America/Los_Angeles': { ru: 'Лос-Анджелес', en: 'Los Angeles' },
};
function okZone(z) {
  if (!z || typeof z !== 'string' || z.length > 64) return false;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: z }); return true; } catch (e) { return false; }
}
// How the moment of a meeting is written for people: { d, t, label, own }. In the meeting's own zone when it has
// one (own: true, label «МСК, UTC+3»), otherwise by the app's clock (label «UTC+5:30»).
function shown(e, ms, tz, lang) {
  const own = okZone(e && e.zone), z = own ? e.zone : tz, p = parts(ms, z), n = own && ZONES[z] ? ZONES[z][lang === 'en' ? 'en' : 'ru'] : '';
  return { d: p.d, t: p.t, label: (n ? n + ', ' : '') + offsetLabel(ms, z), own };
}
module.exports = { appTz, parts, wallToMs, offsetLabel, okZone, shown, forget: () => { seen = { at: 0, tz: '' }; } };
