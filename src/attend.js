'use strict';
// Who of the team came to a call. A meeting marked «вся команда» (`team: true`) concerns everyone in the
// project's team: the bot reminds each of them and gives a button of their own into the call. The button leads
// through this server (/c/<event>/<telegram id>/<signature>), which notes the person as present and sends them
// on to the call. Before the meeting a person can also say whether they are coming.
// The marks live on the event: att[<date of the meeting>][<telegram id>] = { n: name, r: 'yes' | 'no', c: came,
// at: when they came in, by: 'bot' | 'hand' }.
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');
const hub = require('./realtime');
const auth = require('./auth');
const clock = require('./clock');
const remind = require('./remind');
const i18n = require('./i18n');

const EARLY = 30 * 60000, LATE = 4 * 3600000, KEEP = 60;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/, TG_RE = /^\d{1,20}$/, DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const timed = (e) => /^\d{2}:\d{2}$/.test(e.time || '');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/* ---------- the team ---------- */
// Loads what is needed once and answers for any project: [{ tg, name, username }], without the owner.
// A person is in the team when they went through the project's team form, or their card says so; a card that
// was moved to «Контакты» takes the person out.
async function teams() {
  const owner = await auth.ownerId(), join = require('./join');
  const cards = await db.listDocs('contacts'), joins = await db.listDocs('joins');
  const cardOf = new Map(cards.map((c) => [c.id, c.data]));
  const inTeam = (c, project) => Array.isArray(c.team) && c.team.includes(project);
  return (project) => {
    const out = new Map();
    if (!project) return [];
    for (const d of joins) {
      const x = d.data, tg = String(x.tg || '');
      if (x.project !== project || !x.core || !TG_RE.test(tg) || tg === owner || join.isCard(join.form(x.form))) continue;
      const c = cardOf.get('jn-' + tg);
      if (c && !inTeam(c, project)) continue;
      out.set(tg, { tg, name: String((c && c.name) || x.name || ''), username: String(x.username || '') });
    }
    for (const c of cards) {
      const m = /^jn-(\d{1,20})$/.exec(c.id);
      if (m && m[1] !== owner && inTeam(c.data, project) && !out.has(m[1])) out.set(m[1], { tg: m[1], name: String(c.data.name || ''), username: String(c.data.tg || '').replace(/^@/, '') });
    }
    return [...out.values()];
  };
}
const team = async (project) => (await teams())(project);

/* ---------- which meeting of a repeating event ---------- */
// The date of the meeting that is on now: from half an hour before the start to four hours after it;
// a meeting without a time lasts its whole day. '' when none is on.
function current(e, tz, now) {
  for (const s of remind.starts(e, tz, now)) {
    const from = timed(e) ? s.ms - EARLY : clock.wallToMs(s.d, '00:00', tz), to = timed(e) ? s.ms + LATE : from + 864e5;
    if (now >= from && now < to) return s.d;
  }
  return '';
}
// The date of the meeting people are asked about now: the one that is on, or the next one.
function next(e, tz, now) {
  const on = current(e, tz, now);
  if (on) return on;
  const s = remind.starts(e, tz, now).filter((x) => x.ms > now)[0];
  if (s) return s.d;
  return !e.repeat && DAY_RE.test(e.date || '') && e.date >= clock.parts(now, tz).d ? e.date : '';
}

/* ---------- marks ---------- */
async function mark(evId, date, tg, patch, name) {
  if (!ID_RE.test(String(evId)) || !DAY_RE.test(date) || !TG_RE.test(String(tg))) return null;
  const cur = await db.getDoc('events', String(evId));
  if (!cur) return null;
  const d = await db.mutateDoc('events', cur.id, (e) => {
    const att = isObj(e.att) ? e.att : {}, day = isObj(att[date]) ? att[date] : {}, was = isObj(day[tg]) ? day[tg] : {};
    day[tg] = Object.assign({}, was, patch, name ? { n: String(name).slice(0, 80) } : {});
    att[date] = day;
    const keys = Object.keys(att).sort();
    while (keys.length > KEEP) delete att[keys.shift()];
    return Object.assign(e, { att, u: new Date().toISOString() });
  });
  hub.publish('events', d.id, d.data, d.version, '', cur.data);
  return d;
}
const entry = (e, date, tg) => { const day = isObj(e.att) && isObj(e.att[date]) ? e.att[date] : {}; return isObj(day[tg]) ? day[tg] : {}; };

/* ---------- the personal way into the call ---------- */
const sign = (evId, tg) => crypto.createHmac('sha256', cfg.sessionSecret).update('att|' + evId + '|' + tg).digest('base64url').slice(0, 22);
// '' when the server has no public https address: then people get the call's own link and nobody is counted
const linkFor = (evId, tg) => (/^https:\/\//.test(cfg.baseUrl) && ID_RE.test(String(evId)) && TG_RE.test(String(tg)) ? cfg.baseUrl + '/c/' + evId + '/' + tg + '/' + sign(evId, tg) : '');
// Somebody opened their link. Returns { link } to send them on, or { error } in words.
async function open(evId, tg, sig, now) {
  const good = ID_RE.test(String(evId)) && TG_RE.test(String(tg)) && typeof sig === 'string' && sig.length === 22;
  if (!good || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(evId, tg)))) return { error: 'Эта ссылка не действует.' };
  const doc = await db.getDoc('events', String(evId));
  if (!doc) return { error: 'Этой встречи уже нет.' };
  const e = doc.data;
  if (!remind.okLink(e.link)) return { error: 'У встречи пока нет ссылки на созвон. Когда она появится, эта же кнопка откроет созвон.' };
  const date = current(e, await clock.appTz(), now || Date.now());
  if (date && !entry(e, date, tg).c) {
    const who = (await team(e.project)).find((x) => x.tg === String(tg));
    if (who) await mark(doc.id, date, String(tg), { c: true, at: new Date(now || Date.now()).toISOString(), by: 'bot' }, who.name || (who.username ? '@' + who.username : ''));
  }
  return { link: e.link };
}

/* ---------- what the bot sends to a person of the team ---------- */
// The buttons under a message about the meeting: the way in (o.join) and «Буду» / «Не смогу» (o.ask).
function memberKb(evId, e, tg, date, o) {
  const rows = [], url = o.join && remind.okLink(e.link) ? linkFor(evId, tg) : '', L = i18n.of(o.lang || 'ru');
  if (url) rows.push([{ text: L.enter, url }]);
  const base = 'at:' + evId + ':' + String(date || '').replace(/-/g, '') + ':';
  if (o.ask && DAY_RE.test(date || '') && Buffer.byteLength(base) <= 62) {
    const r = entry(e, date, tg).r;
    rows.push([{ text: (r === 'yes' ? '✓ ' : '') + L.going, callback_data: base + 'y' }, { text: (r === 'no' ? '✓ ' : '') + L.notGoing, callback_data: base + 'n' }]);
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}
const langOf = async (tg) => { const l = await db.kvGet('lang:' + tg); return i18n.ok(l) ? l : 'ru'; };
// «Буду» or «Не смогу» was pressed. Returns what to answer, and the new buttons.
async function rsvp(from, evId, ymd, yn, keepJoin) {
  const date = ymd.slice(0, 4) + '-' + ymd.slice(4, 6) + '-' + ymd.slice(6, 8), tg = String(from.id);
  const doc = await db.getDoc('events', String(evId));
  if (!doc) return { text: 'Этой встречи уже нет' };
  const who = (await team(doc.data.project)).find((x) => x.tg === tg), lang = await langOf(tg), L = i18n.of(lang);
  if (!who) return { text: L.notTeam };
  const d = await mark(doc.id, date, tg, { r: yn === 'y' ? 'yes' : 'no' }, who.name || auth.fullName(from));
  if (!d) return { text: L.goneShort };
  // the way in stays under the message when it was there: the meeting is within the hour or already on
  const tz = await clock.appTz(), s = remind.starts(d.data, tz, Date.now()).find((x) => x.d === date);
  const soon = !!s && s.ms - Date.now() <= 3600000;
  return { text: yn === 'y' ? L.saidYes : L.saidNo, kb: memberKb(doc.id, d.data, tg, date, { ask: true, join: soon || !!keepJoin, lang }) };
}

/* ---------- the report to those who run the project ---------- */
function reportText(e, date, people, project, tz) {
  const day = isObj(e.att) && isObj(e.att[date]) ? e.att[date] : {};
  const nm = (p) => esc(p.name || (p.username ? '@' + p.username : 'участник'));
  const came = people.filter((p) => isObj(day[p.tg]) && day[p.tg].c), rest = people.filter((p) => !came.includes(p));
  const w = timed(e) && tz ? clock.shown(e, clock.wallToMs(date, e.time, tz), tz, 'ru') : null;
  const when = w ? remind.dayLabel(w.d) + ' ' + w.t + (w.own ? ' (' + w.label + ')' : '') : remind.dayLabel(date) + (timed(e) ? ' ' + e.time : '');
  const why = (p) => { const r = isObj(day[p.tg]) ? day[p.tg].r : ''; return r === 'no' ? ' (ответ: не смогу)' : r === 'yes' ? ' (ответ: буду)' : ''; };
  return 'Созвон <b>' + esc(e.title || 'Встреча') + '</b>' + (project ? ' · ' + esc(project) : '') + ', ' + when +
    '\nПришли ' + came.length + ' из ' + people.length + (came.length ? ': ' + came.map(nm).join(', ') : '') + '.' +
    (rest.length ? '\nНе открывали ссылку: ' + rest.map((p) => nm(p) + why(p)).join(', ') + '.' : '') +
    '\n\nСчитаю тех, кто вошёл по своей кнопке от меня. Кто зашёл иначе или позже, отмечается в самой встрече в дэшборде.';
}

// GET /c/:event/:tg/:sig
async function handle(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const r = await open(req.params.event, req.params.tg, req.params.sig);
  if (r.link) return res.redirect(302, r.link);
  res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(cfg.appName) +
    '</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:480px;margin:18vh auto;padding:0 20px;color:#222"><p>' + esc(r.error) + '</p></body>');
}

module.exports = { teams, team, current, next, mark, entry, linkFor, open, memberKb, langOf, rsvp, reportText, handle, EARLY, LATE };
