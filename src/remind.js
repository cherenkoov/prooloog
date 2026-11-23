'use strict';
// Reminders from the bot. An event carries its rules in `rem` (minutes before the start); an event with a call
// link also gets the link five minutes before. A meeting participant who opened the bot by the event's link
// is reminded too, by rules of their own.
const cfg = require('./config');
const db = require('./db');
const auth = require('./auth');
const T = require('./telegram');
const clock = require('./clock');
const i18n = require('./i18n');

const GRACE = 10 * 60000, LINK_MIN = 5, REPORT = 15 * 60000;
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
const offsetLabel = clock.offsetLabel;
const MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const dayLabel = (d) => +d.slice(8, 10) + ' ' + MON[+d.slice(5, 7) - 1];
// lang: the language of the one who gets the reminder; the owner reads Russian
function text(e, s, m, tz, project, guest, lang) {
  const timed = /^\d{2}:\d{2}$/.test(e.time || ''), L = i18n.of(guest ? lang : 'ru');
  // a meeting set in a zone of its own is told in that zone, to everybody
  const w = timed ? clock.shown(e, s.ms, tz, guest ? lang : 'ru') : { d: s.d };
  return '⏰ ' + L.before(m) + ': <b>' + esc(e.title || L.meeting) + '</b>\n' + L.day(w.d) + (timed ? ', ' + w.t + (guest || w.own ? ' (' + w.label + ')' : '') : '') +
    (project && !guest ? ' · ' + esc(project) : '') + (okLink(e.link) && m <= 60 ? '\n' + L.link + ': ' + esc(e.link) : '');
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
  // a meeting of the whole team: everyone in the project's team is reminded by the meeting's own rules and gets
  // a button of their own into the call, which is how the server sees who came (attend.js)
  const attend = require('./attend');
  const teamOf = events.some((r) => r.data.team && r.data.project) ? await attend.teams() : null;
  let sent = 0;
  for (const row of events) {
    const e = row.data, link = okLink(e.link);
    const to = [], members = teamOf && e.team && e.project ? teamOf(e.project) : [], inTeam = new Set(members.map((x) => x.tg));
    if (owner) to.push({ chat: owner, rem: rules(e.rem), guest: false });
    for (const s of subs) if (s.data.event === row.id && /^\d{1,20}$/.test(String(s.data.tg || '')) && String(s.data.tg) !== String(owner)) to.push({ chat: String(s.data.tg), rem: rules(s.data.rem), guest: true, lang: i18n.ok(s.data.lang) ? s.data.lang : 'ru', member: inTeam.has(String(s.data.tg)) });
    for (const x of members) if (!to.some((r) => r.chat === x.tg)) to.push({ chat: x.tg, rem: rules(e.rem), guest: true, member: true });
    // a chat hears the reminder in the language the organizer fixed for this meeting, Russian otherwise
    const fixed = i18n.ok(e.lang) ? e.lang : '';
    for (const c of chats) if (c.data.project === e.project) to.push({ chat: String(c.data.tg), rem: rules(e.rem), guest: true, group: true, lang: fixed || 'ru' });
    if (!to.some((r) => r.rem.length) && !link) continue; // without a link there is no report either
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
              ? { inline_keyboard: [[{ text: i18n.of(r.lang).mine, url: 'https://t.me/' + botName() + '?start=ev' + fixed + '_' + e.share }]] } : undefined;
            // a person of the team gets the way in as a button of their own instead of the bare link
            let body = e, markup = own, lang = r.lang;
            if (r.member) {
              lang = lang || await attend.langOf(r.chat);
              const mine = link && attend.linkFor(row.id, r.chat), came = !!attend.entry(e, s.d, r.chat).c;
              if (mine) body = Object.assign({}, e, { link: '' });
              markup = attend.memberKb(row.id, e, r.chat, s.d, { join: !!mine && m <= 60, ask: !!mine && !came && m > LINK_MIN, lang });
            }
            await T.tg('sendMessage', { chat_id: r.chat, text: text(body, s, m, tz, projects[e.project], r.guest, lang) + (body !== e && m <= 60 ? '\n' + i18n.of(lang).enterHint : ''), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup });
            sent++;
          } catch (err) { console.error('[remind] not delivered to ' + r.chat + ':', err.message); }
        }
      }
    }
    // a quarter of an hour into the call of the whole team, those who run the project hear who came
    if (members.length && link && /^\d{2}:\d{2}$/.test(e.time || '') && attend.linkFor(row.id, members[0].tg)) {
      for (const s of starts(e, tz, now)) {
        const at = s.ms + REPORT;
        if (!isFinite(s.ms) || at > now || now - at >= GRACE) continue;
        if (!(await claim(row.id + '|' + s.ms + '|rep'))) continue;
        const fresh = await db.getDoc('events', row.id);
        if (!fresh) continue;
        const heads = [...new Set([owner].concat(await auth.managersOf(e.project)).filter(Boolean).map(String))];
        for (const h of heads) {
          try { await T.tg('sendMessage', { chat_id: h, text: attend.reportText(fresh.data, s.d, members, projects[e.project], tz), parse_mode: 'HTML', link_preview_options: { is_disabled: true } }); sent++; }
          catch (err) { console.error('[remind] report not delivered to ' + h + ':', err.message); }
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
