'use strict';
// Reminders from the bot. An event carries its rules in `rem` (minutes before the start); an event with a call
// link also gets the link five minutes before. A meeting participant who opened the bot by the event's link
// is reminded too, by rules of their own.
const cfg = require('./config');
const db = require('./db');
const auth = require('./auth');
const T = require('./telegram');
const clock = require('./clock');

const GRACE = 10 * 60000, LINK_MIN = 5;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };
const rules = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => Math.round(+x)).filter((x) => x >= 1 && x <= 43200))].sort((a, b) => b - a).slice(0, 5);
function before(m) {
  if (m % 1440 === 0) { const d = m / 1440; return 'Через ' + d + ' ' + plural(d, 'день', 'дня', 'дней'); }
  if (m % 60 === 0) { const h = m / 60; return 'Через ' + h + ' ' + plural(h, 'час', 'часа', 'часов'); }
  return 'Через ' + m + ' ' + plural(m, 'минуту', 'минуты', 'минут');
}
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const okDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const okLink = (s) => typeof s === 'string' && /^https?:\/\/\S+$/i.test(s);
function occurs(e, d) {
  if (!okDate(e.date) || d < e.date) return false;
  if (okDate(e.until) && d > e.until) return false;
  if (e.repeat === 'daily') return true;
  if (e.repeat === 'weekly') return new Date(d + 'T00:00:00Z').getUTCDay() === new Date(e.date + 'T00:00:00Z').getUTCDay();
  return d === e.date;
}
// Starts of the event (ms) that a reminder could still concern: from yesterday to a month ahead.
function starts(e, tz, now) {
  const today = clock.parts(now, tz).d, time = /^\d{2}:\d{2}$/.test(e.time || '') ? e.time : '09:00', out = [];
  if (!e.repeat) { if (okDate(e.date) && e.date >= addDays(today, -1) && e.date <= addDays(today, 31)) out.push({ d: e.date, ms: clock.wallToMs(e.date, time, tz) }); return out; }
  for (let i = -1; i <= 31; i++) { const d = addDays(today, i); if (occurs(e, d)) out.push({ d, ms: clock.wallToMs(d, time, tz) }); }
  return out;
}
function offsetLabel(ms, tz) {
  const p = clock.parts(ms, tz), min = Math.round((Date.parse(p.d + 'T' + p.t + ':00Z') - ms) / 60000), a = Math.abs(min);
  return 'UTC' + (min < 0 ? '−' : '+') + Math.floor(a / 60) + (a % 60 ? ':' + String(a % 60).padStart(2, '0') : '');
}
const MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const dayLabel = (d) => +d.slice(8, 10) + ' ' + MON[+d.slice(5, 7) - 1];
function text(e, s, m, tz, project, guest) {
  const timed = /^\d{2}:\d{2}$/.test(e.time || '');
  return '⏰ ' + before(m) + ': <b>' + esc(e.title || 'Событие') + '</b>\n' + dayLabel(s.d) + (timed ? ', ' + e.time + (guest ? ' (' + offsetLabel(s.ms, tz) + ')' : '') : '') +
    (project && !guest ? ' · ' + esc(project) : '') + (okLink(e.link) && m <= 60 ? '\nСсылка: ' + esc(e.link) : '');
}
async function claim(key) {
  const r = await db.q('INSERT INTO sent_reminders (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key', [key]);
  return r.rowCount > 0;
}
// One pass: sends everything that is due. Returns how many messages went out.
async function tick(nowMs) {
  if (!cfg.botToken) return 0;
  const now = nowMs || Date.now(), tz = await clock.appTz(), owner = await auth.ownerId();
  const events = await db.listDocs('events');
  if (!events.length) return 0;
  const subs = await db.listDocs('evsubs'), projects = {};
  const chats = (await db.listDocs('chats')).filter((c) => c.data.on !== false && c.data.remind && c.data.project && /^-?\d{1,20}$/.test(String(c.data.tg || '')));
  for (const p of await db.listDocs('projects')) projects[p.id] = p.data.name;
  let sent = 0;
  for (const row of events) {
    const e = row.data, link = okLink(e.link);
    const to = [];
    if (owner) to.push({ chat: owner, rem: rules(e.rem), guest: false });
    for (const s of subs) if (s.data.event === row.id && /^\d{1,20}$/.test(String(s.data.tg || '')) && String(s.data.tg) !== String(owner)) to.push({ chat: String(s.data.tg), rem: rules(s.data.rem), guest: true });
    for (const c of chats) if (c.data.project === e.project) to.push({ chat: String(c.data.tg), rem: rules(e.rem), guest: true, group: true });
    if (!to.some((r) => r.rem.length) && !link) continue;
    for (const s of starts(e, tz, now)) {
      if (!isFinite(s.ms)) continue;
      for (const r of to) {
        const mins = link && !r.rem.includes(LINK_MIN) ? r.rem.concat([LINK_MIN]) : r.rem;
        for (const m of mins) {
          const at = s.ms - m * 60000;
          if (at > now || now - at >= GRACE || now >= s.ms + GRACE) continue;
          if (!(await claim(row.id + '|' + s.ms + '|' + m + '|' + r.chat))) continue;
          try {
            // in a chat everyone can ask for a reminder of their own, if the owner made a link for participants
            const own = r.group && botName() && /^[A-Za-z0-9_-]{8,60}$/.test(String(e.share || ''))
              ? { inline_keyboard: [[{ text: 'Напоминать мне лично', url: 'https://t.me/' + botName() + '?start=ev_' + e.share }]] } : undefined;
            await T.tg('sendMessage', { chat_id: r.chat, text: text(e, s, m, tz, projects[e.project], r.guest), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: own });
            sent++;
          } catch (err) { console.error('[remind] not delivered to ' + r.chat + ':', err.message); }
        }
      }
    }
  }
  return sent;
}
let timer = null, busy = false, pruned = 0;
let botName = () => '';
const use = (o) => { if (o && typeof o.bot === 'function') botName = o.bot; };
function start() {
  if (timer || !cfg.botToken) return;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await tick();
      if (Date.now() - pruned > 864e5) { pruned = Date.now(); await db.q("DELETE FROM sent_reminders WHERE at < now() - interval '45 days'"); }
    } catch (e) { console.error('[remind] pass failed:', e.message); } finally { busy = false; }
  }, 30000);
  timer.unref();
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }
module.exports = { tick, start, stop, use, rules, before, starts, occurs, offsetLabel, dayLabel, okLink };
