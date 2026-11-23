'use strict';
// A project can be a game (project.game.on): weekly sprints, quests in three branches (spirit, soul, body),
// one report a day, XP counted by fixed rules. The rules are «Life Game 1.1»:
//   a quest finished in the week brings 10, 20 or 30 XP by its level (L1, L2, L3), once, when the player confirms it;
//   +30 when the quests of all three branches are finished; +5 for a day's report (a day of rest counts);
//   +10 for helping another player (three times a week at most); the team's quest: +20 for one's own part done,
//   +10 to everybody who took part when the team reached the goal.
// The marks of a day by branch are progress only: they bring no XP of their own.
// A player's own quests and reports are theirs to keep: they do not wait for a review, unlike everything else
// that reaches a project from a chat. Nobody but the player (and those who run the project) changes them.
// Records: `quests` (a quest of a player for a week, or an idea in the library: lib) and `checkins` (a report).
const db = require('./db');
const hub = require('./realtime');
const clock = require('./clock');
const auth = require('./auth');
const T = require('./telegram');
const journal = require('./journal');

const BR = ['spirit', 'soul', 'body'];
const BRN = { spirit: 'Дух', soul: 'Душа', body: 'Тело' };
const BRI = { spirit: '🜁', soul: '♡', body: '△' };
const BRK = { spirit: 'sp', soul: 'so', body: 'bo', party: 'pa' };
const LEVELS = [10, 20, 30];
const RULES = { report: 5, help: 10, helpMax: 3, all: 30, party: 20, team: 10 };
const STATUS = ['active', 'done', 'paused', 'adjusted'];
const MONG = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

let G = null; // what the work-chat module lends: send(ch, html, markup, extra), saveChat, person, esc, kb, botName()
const init = (ctx) => { G = ctx; };

const one = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const nowIso = () => new Date().toISOString();
const isOn = (p) => !!(p && p.game && p.game.on);
function rulesOf(p) {
  const r = Object.assign({}, RULES), o = p && p.game && p.game.rules;
  if (o && typeof o === 'object') for (const k of Object.keys(RULES)) if (isFinite(+o[k]) && +o[k] >= 0 && +o[k] <= 1000) r[k] = Math.round(+o[k]);
  return r;
}
// the Monday of the week a date belongs to: a sprint is named by it
function weekOf(d) {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
function weekLabel(w) {
  const a = new Date(w + 'T00:00:00Z'), b = new Date(addDays(w, 6) + 'T00:00:00Z');
  return a.getUTCMonth() === b.getUTCMonth() ? a.getUTCDate() + '–' + b.getUTCDate() + ' ' + MONG[b.getUTCMonth()] : a.getUTCDate() + ' ' + MONG[a.getUTCMonth()] + ' – ' + b.getUTCDate() + ' ' + MONG[b.getUTCMonth()];
}
const dayLabel = (d) => { const x = new Date(d + 'T00:00:00Z'); return x.getUTCDate() + ' ' + MONG[x.getUTCMonth()]; };

/* ---------- the count ---------- */
// The XP of one player in one week. quests: the player's quests of that week (a branch, or `party` for their part
// in the team's quest); checkins: their reports of that week; won: the team reached the goal of its quest.
function score(quests, checkins, rules, won) {
  const R = rules || RULES, out = { total: 0, spirit: 0, soul: 0, body: 0, bonus: 0, report: 0, help: 0, party: 0, team: 0, days: 0, marks: { spirit: 0, soul: 0, body: 0 } };
  let part = false;
  for (const q of quests || []) {
    if (!q || q.lib) continue;
    if (q.branch === 'party') { part = true; if (q.status === 'done') out.party = R.party; continue; }
    if (!BR.includes(q.branch) || q.status !== 'done') continue;
    out[q.branch] = Math.max(out[q.branch], LEVELS[Math.min(3, Math.max(1, Math.round(+q.level || 1))) - 1]); // one quest a branch
  }
  out.bonus = BR.every((b) => out[b] > 0) ? R.all : 0;
  out.team = part && won ? R.team : 0;
  const days = new Map(); // one report a day: the latest wins
  for (const c of checkins || []) {
    if (!c || !/^\d{4}-\d{2}-\d{2}$/.test(c.date || '')) continue;
    const cur = days.get(c.date);
    if (!cur || String(c.u || '') >= String(cur.u || '')) days.set(c.date, c);
  }
  let helps = 0;
  for (const c of days.values()) {
    out.days++; out.report += R.report;
    for (const b of BR) if (c[b] === true) out.marks[b]++;
    helps += Math.max(0, Math.min(R.helpMax, Math.round(+c.help || 0)));
  }
  out.help = Math.min(R.helpMax, helps) * R.help;
  out.total = out.spirit + out.soul + out.body + out.bonus + out.report + out.help + out.party + out.team;
  return out;
}
const wonOf = (p, week) => !!(p && p.game && p.game.partyDone && p.game.partyDone[week]);

/* ---------- who may write what ---------- */
// cur: the record now (or null), next: what it becomes (null for a deletion). Those who run the project change
// anything in its game; a player changes their own quests and reports and the library ideas they brought.
async function mayWrite(user, coll, cur, next) {
  const rec = next || cur;
  if (!rec || typeof rec.project !== 'string') return false;
  if (cur && next && cur.project !== next.project) return false;
  if (auth.manages(user, rec.project)) return true;
  const p = await db.getDoc('projects', rec.project);
  if (!p || !isOn(p.data)) return false;
  const mine = (r) => !r || String(r.lib ? r.by : r.player) === String(user.id);
  if (cur && next && !!cur.lib !== !!next.lib) return false;
  return mine(cur) && mine(next);
}

/* ---------- reading a message ---------- */
const BRW = { дух: 'spirit', душа: 'soul', тело: 'body' };
const KEYS = [
  ['title', /квест\s*:/i], ['result', /результат\s*:/i], ['action', /действие\s*:/i], ['min', /минимум\s*:/i],
  ['freq', /частота\s*:/i], ['level', /(?:сложность|уровень)\s*:/i], ['status', /статус\s*:/i], ['why', /зачем\s*:/i],
  ['party', /мо[её] участие\s*:/i], ['helpme', /(?:чем мне могут помочь|нужна помощь|тема группы)\s*:/i], ['first', /первый шаг\s*:/i],
];
const keyOf = (line) => { for (const [k, re] of KEYS) { const m = re.exec(line); if (m) return { k, v: line.slice(m.index + m[0].length).trim() }; } return null; };
const headOf = (line) => { const m = /^[^A-Za-zА-Яа-яЁё0-9:]*(дух|душа|тело)[^A-Za-zА-Яа-яЁё0-9:]*$/i.exec(line); return m ? BRW[m[1].toLowerCase()] : ''; };
function statusOf(v) {
  const s = String(v || '');
  const hit = [['done', /✅|COMPLETED|заверш/i], ['paused', /⏸|PAUSED|отлож|пауз/i], ['adjusted', /🔄|ADJUSTED|скоррект/i], ['active', /🎯|ACTIVE|в процессе/i]].filter((x) => x[1].test(s));
  return hit.length === 1 ? hit[0][0] : 'active';
}
function freqOf(v) {
  const s = String(v || '').toLowerCase();
  if (/кажд\S* день|ежедневно|7\s*\/\s*7/.test(s)) return 7;
  const m = /([1-7])/.exec(s);
  return m ? +m[1] : 0;
}
// A player's card from the Quest Board: the quests it names, by branch. Empty when the text is not a filled card.
function parseCard(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()), out = { quests: {}, party: '' };
  let br = '', last = null, stop = false;
  for (const line of lines) {
    if (/итог недели/i.test(line)) stop = true;
    if (stop) continue;
    if (/party\s+quest/i.test(line)) { br = ''; last = null; continue; }
    const h = headOf(line);
    if (h) { br = h; out.quests[br] = out.quests[br] || {}; last = null; continue; }
    const kv = keyOf(line);
    if (kv) {
      if (kv.k === 'party') { out.party = one(kv.v, 300); last = { o: out, k: 'party', n: 300 }; continue; }
      if (kv.k === 'helpme' || kv.k === 'first') { last = null; continue; }
      if (!br) { last = null; continue; }
      const q = out.quests[br];
      if (kv.k === 'freq') { q.freq = freqOf(kv.v); last = null; }
      else if (kv.k === 'level') { const l = kv.v.match(/L\s*([123])/gi) || []; q.level = l.length === 1 ? +l[0].replace(/\D/g, '') : 0; last = null; }
      else if (kv.k === 'status') { q.status = statusOf(kv.v); last = null; }
      else { q[kv.k] = one(kv.v, 300); last = { o: q, k: kv.k, n: 300 }; }
      continue;
    }
    // a value that went on to the next line
    if (last && line && !/^[⸻—–\-_=\s]+$/.test(line)) last.o[last.k] = one((last.o[last.k] ? last.o[last.k] + ' ' : '') + line, last.n);
    else if (!line || /^[⸻—–\-_=\s]+$/.test(line)) last = null;
  }
  for (const b of Object.keys(out.quests)) if (!out.quests[b].title) delete out.quests[b];
  if (/не определ|^[—–\-\s]*$/i.test(out.party)) out.party = '';
  return out;
}
const YES = /✅|✔|☑|🟩|\+/, NO = /❌|✖|✗|🟥/;
// A day's report written by the template: marks by branch, what was done, the day's discovery, the signal.
// A mark is null when the line is absent, holds a dash, or still holds the template's «✅ / ❌ / —».
function parseReport(text) {
  const out = { marks: {}, any: false, blank: false, text: '', insight: '', signal: '', help: 0, template: /daily\s*log/i.test(String(text || '')) };
  let unset = 0;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    const m = /^[^A-Za-zА-Яа-яЁё0-9]*(дух|душа|тело)\s*[:\-–—]\s*(.*)$/i.exec(line);
    if (m) {
      const y = YES.test(m[2]), n = NO.test(m[2]), b = BRW[m[1].toLowerCase()];
      if (y && n) { unset++; continue; }
      out.marks[b] = y ? true : n ? false : null;
      if (y || n) out.any = true;
      continue;
    }
    let f;
    if ((f = /что сделал[аи]?\s*:\s*(.*)$/i.exec(line))) out.text = one(f[1], 1500);
    else if ((f = /(?:открытие(?: дня)?|что заметила?)\s*:\s*(.*)$/i.exec(line))) out.insight = one(f[1], 600);
    else if ((f = /^[^A-Za-zА-Яа-яЁё0-9]*помо(?:г|гла|щь)[^:]*:\s*(.*)$/i.exec(line))) { if (f[1] && !/^[—–\-\s]*$/.test(f[1])) out.help = 1; }
    else if ((f = /статус\s*:\s*(.*)$/i.exec(line))) {
      const s = [['flow', /🟢|FLOW/i], ['stuck', /🟡|STUCK/i], ['help', /🔴|HELP/i]].filter((x) => x[1].test(f[1]));
      if (s.length === 1) out.signal = s[0][0];
    }
  }
  out.blank = out.template && !out.any && !out.text && !out.insight && unset > 0;
  return out;
}

/* ---------- records ---------- */
const checkId = (project, player, date) => ('k' + date.replace(/-/g, '') + '-' + player + '-' + project).slice(0, 64);
const questId = (project, player, week, branch) => ('q' + week.replace(/-/g, '') + '-' + player + '-' + BRK[branch] + '-' + project).slice(0, 64);
async function sprint(project, week) {
  const quests = (await db.listDocs('quests')).filter((d) => d.data.project === project && !d.data.lib && d.data.week === week);
  const checks = (await db.listDocs('checkins')).filter((d) => d.data.project === project && d.data.week === week);
  return { quests, checks };
}
// the players of a week with their XP, by name: the game does not rank people. all: XP of all the sprints.
async function table(p, week) {
  const R = rulesOf(p.data), by = new Map(), weeks = new Map();
  const quests = (await db.listDocs('quests')).filter((d) => d.data.project === p.id && !d.data.lib), checks = (await db.listDocs('checkins')).filter((d) => d.data.project === p.id);
  const of = (id, name) => { if (!by.has(id)) by.set(id, { player: id, name: '', quests: [], checks: [], all: 0 }); const x = by.get(id); if (name && !x.name) x.name = name; return x; };
  const wk = (id, w) => { const k = id + '|' + w; if (!weeks.has(k)) weeks.set(k, { id, w, q: [], c: [] }); return weeks.get(k); };
  for (const q of quests) { wk(String(q.data.player), q.data.week).q.push(q.data); if (q.data.week === week) of(String(q.data.player), q.data.name).quests.push(q.data); }
  for (const c of checks) { wk(String(c.data.player), c.data.week).c.push(c.data); if (c.data.week === week) of(String(c.data.player), c.data.name).checks.push(c.data); }
  for (const x of weeks.values()) if (by.has(x.id)) by.get(x.id).all += score(x.q, x.c, R, wonOf(p.data, x.w)).total;
  return [...by.values()].map((x) => Object.assign(x, { xp: score(x.quests, x.checks, R, wonOf(p.data, week)) })).sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
}
function xpParts(xp) {
  const parts = BR.filter((b) => xp[b]).map((b) => BRI[b] + ' ' + xp[b]);
  if (xp.bonus) parts.push('баланс ' + xp.bonus);
  if (xp.report) parts.push('отчёты ' + xp.report);
  if (xp.help) parts.push('помощь ' + xp.help);
  if (xp.party + xp.team) parts.push('общий квест ' + (xp.party + xp.team));
  return parts;
}
async function tableText(p, week) {
  const e = G.esc, rows = await table(p, week), party = p.data.game && p.data.game.party && p.data.game.party[week];
  const lines = ['🎮 <b>' + e(p.data.name || '') + '</b> · спринт ' + weekLabel(week)];
  if (party) lines.push('🌍 Общий квест: ' + e(one(party, 200)) + (wonOf(p.data, week) ? ' — цель достигнута' : ''));
  lines.push('');
  if (!rows.length) lines.push('На этой неделе пока нет ни квестов, ни отчётов. Карточку игрока публикуй в теме Quest Board, отчёт дня в Daily Log.');
  for (const r of rows) {
    const parts = xpParts(r.xp);
    lines.push('<b>' + e(r.name || 'Игрок') + '</b> — ' + r.xp.total + ' XP' + (parts.length ? ' (' + parts.join(' · ') + ')' : '') + (r.all !== r.xp.total ? ' · всего ' + r.all : ''));
  }
  return lines.join('\n');
}
function introText(p) {
  return ['🎮 В проекте <b>' + G.esc(p.data.name || '') + '</b> включена игра. Что я теперь делаю:',
    '• Карточку игрока из Quest Board сохраняю как квесты этой недели. Изменил карточку — я обновлю квесты.',
    '• Сообщение в Daily Log считаю отчётом дня: текст, голосовое или фото. Под отчётом появятся кнопки веток.',
    '• XP считаю сам по правилам 1.1: за завершённый квест по его уровню, за отчёт дня, за помощь и за общий квест. Квест завершает сам игрок кнопкой под своей карточкой: подтверждать его никому не нужно.',
    '• /game — команда недели и XP. /companion — личный AI-компаньон: поможет выбрать квесты и вести отчёты, не выходя из Telegram.'].join('\n');
}

/* ---------- a message of a player ---------- */
const topicName = (ch, m) => (m.is_topic_message && m.message_thread_id && ch.topics && ch.topics[String(m.message_thread_id)]) || '';
const isLogTopic = (name) => /daily|\blog\b|дневник|отч[её]т/i.test(name || '');
const isFireTopic = (name) => /campfire|кост[её]р|общени/i.test(name || '');
function mediaTag(m) {
  if (m.voice) return '[голосовое]';
  if (m.video_note) return '[видеосообщение]';
  if (m.photo) return '[фото]';
  if (m.video) return '[видео]';
  if (m.audio) return '[аудио]';
  if (m.document) return '[файл]';
  return '';
}
async function saveQuests(m, ch, p, card) {
  const tz = await clock.appTz(), day = clock.parts(m.date * 1000, tz).d, week = weekOf(day), player = String(m.from.id), name = G.person(m.from);
  const mine = (await db.listDocs('quests')).filter((d) => d.data.project === p.id && !d.data.lib && d.data.week === week && String(d.data.player) === player);
  const saved = [];
  for (const b of BR) {
    const q = card.quests[b];
    if (!q) continue;
    const cur = mine.find((d) => d.data.branch === b), id = cur ? cur.id : questId(p.id, player, week, b);
    const d = await db.mutateDoc('quests', id, (was) => Object.assign({ project: p.id, player, week, branch: b, level: 1, freq: 0, result: '', action: '', min: '', why: '' }, was, q.why !== undefined ? { why: q.why } : {}, {
      name, title: q.title, status: STATUS.includes(q.status) ? q.status : was.status || 'active', src: 'chat', msg: m.message_id, u: nowIso(),
    }, q.result !== undefined ? { result: q.result } : {}, q.action !== undefined ? { action: q.action } : {}, q.min !== undefined ? { min: q.min } : {}, q.freq ? { freq: q.freq } : {}, q.level ? { level: q.level } : {}));
    hub.publish('quests', d.id, d.data, d.version);
    if (!cur) journal.note('add', 'quests', d.id, d.data, null, 'чат «' + one(ch.title, 50) + '»: ' + name);
    saved.push(d.data);
  }
  if (card.party) {
    const cur = mine.find((d) => d.data.branch === 'party'), id = cur ? cur.id : questId(p.id, player, week, 'party');
    const d = await db.mutateDoc('quests', id, (was) => Object.assign({ project: p.id, player, week, branch: 'party', status: 'active' }, was, { name, title: card.party, src: 'chat', msg: m.message_id, u: nowIso() }));
    hub.publish('quests', d.id, d.data, d.version);
  }
  return { saved, week };
}
// The player's quests of a week as the chat sees them, with a button to finish each: a quest brings its XP once,
// when the player says the result is there.
const ZK = { s: 'spirit', o: 'soul', b: 'body', p: 'party' };
async function cardView(p, player, week) {
  const e = G.esc, R = rulesOf(p.data), all = (await db.listDocs('quests')).filter((d) => d.data.project === p.id && !d.data.lib && d.data.week === week && String(d.data.player) === player).map((d) => d.data);
  const order = BR.concat(['party']), qs = order.map((b) => all.find((q) => q.branch === b)).filter(Boolean);
  if (!qs.length) return null;
  const lines = ['📜 Квесты <b>' + e(qs[0].name || 'Игрок') + '</b> на спринт ' + weekLabel(week) + ':'];
  for (const q of qs) {
    const xp = q.branch === 'party' ? R.party : LEVELS[Math.min(3, Math.max(1, Math.round(+q.level || 1))) - 1];
    lines.push((q.branch === 'party' ? '🌍 Общий квест' : BRI[q.branch] + ' ' + BRN[q.branch]) + ': ' + e(q.title) + (q.branch === 'party' ? '' : ' · L' + (Math.round(+q.level) || 1)) + (q.status === 'done' ? ' — ✅ +' + xp + ' XP' : q.status === 'paused' ? ' — ⏸ отложен' : ''));
  }
  lines.push('Квест завершён? Отметь кнопкой: XP за него начисляется один раз. Отчёт дня — в Daily Log.');
  const key = week.replace(/-/g, '') + ':' + player;
  const row = qs.map((q) => ({ text: (q.status === 'done' ? '✅ ' : '') + (q.branch === 'party' ? '🌍 Общий' : BRI[q.branch] + ' ' + BRN[q.branch]), callback_data: 'gz:' + q.branch[0].replace('s', q.branch === 'soul' ? 'o' : 's') + ':' + key }));
  return { html: lines.join('\n'), kb: G.kb([row]) };
}
function reportKb(ch, c, has) {
  const key = c.date.replace(/-/g, '') + ':' + c.player, row = BR.filter((b) => has[b]).map((b) => ({ text: BRI[b] + ' ' + BRN[b] + (c[b] === true ? ' ✅' : ''), callback_data: 'gq:' + b[0] + (b === 'soul' ? 'o' : '') + ':' + key }));
  const rows = row.length ? [row] : [];
  rows.push([{ text: '🤝 Помог игроку' + (+c.help > 0 ? ': ' + (+c.help) : ''), callback_data: 'gq:h:' + key }]);
  return G.kb(rows);
}
async function reportView(p, c) {
  const e = G.esc, { quests, checks } = await sprint(p.id, c.week), R = rulesOf(p.data);
  const mq = quests.filter((d) => String(d.data.player) === String(c.player)).map((d) => d.data), mc = checks.filter((d) => String(d.data.player) === String(c.player)).map((d) => d.data);
  const has = {}; for (const q of mq) if (q.status !== 'paused') has[q.branch] = true;
  const week = score(mq, mc, R, wonOf(p.data, c.week)), help = Math.min(R.helpMax, Math.round(+c.help || 0));
  const lines = ['⚡ Отчёт: <b>' + e(c.name || 'Игрок') + '</b>, ' + dayLabel(c.date)];
  lines.push(BR.map((b) => BRI[b] + ' ' + BRN[b] + ' ' + (c[b] === true ? '✅' : c[b] === false ? '❌' : '—')).join(' · '));
  lines.push('+' + R.report + ' XP за отчёт' + (help ? ' · помощь: ' + help : '') + ' · ' + week.total + ' XP за спринт');
  if (!mq.some((q) => BR.includes(q.branch))) lines.push('Квестов на эту неделю у тебя пока нет: опубликуй карточку игрока в Quest Board.');
  if (c.signal === 'stuck') lines.push('🟡 Застрял: нужен совет. Откликнитесь ответом на отчёт.');
  if (c.signal === 'help') lines.push('🔴 Нужна помощь или совместная сессия. Откликнитесь ответом на отчёт.');
  return { html: lines.join('\n'), has };
}
async function showReport(ch, p, d, m, thread) {
  const c = d.data, v = await reportView(p, c), kb = reportKb(ch, c, v.has);
  if (c.ack && c.ack.id) {
    const ok = await T.tg('editMessageText', { chat_id: ch.tg, message_id: c.ack.id, text: v.html, parse_mode: 'HTML', reply_markup: kb }).then(() => true, (err) => /not modified/i.test(String(err && err.message)));
    if (ok) return;
  }
  const sent = await G.send(ch, v.html, kb, Object.assign({}, thread, m ? { reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } } : {})).catch(() => null);
  if (sent && sent.message_id) {
    const n = await db.updateDoc('checkins', d.id, { ack: { id: sent.message_id } });
    if (n) hub.publish('checkins', n.id, n.data, n.version);
  }
}
// A message in the chat of a game. Returns true when it was a card or a report.
async function onMessage(m, doc, thread, edited) {
  const ch = doc.data, p = await db.getDoc('projects', ch.project);
  if (!p || !isOn(p.data) || !m.from || m.from.is_bot) return false;
  const text = String(m.text || m.caption || ''), name = G.person(m.from), player = String(m.from.id);
  if (/^\//.test(text.trim())) return false;

  const card = parseCard(text);
  if (Object.keys(card.quests).length && (/player\s+card/i.test(text) || /квест\s*:/i.test(text))) {
    const r = await saveQuests(m, ch, p, card);
    const v = edited ? null : await cardView(p, player, r.week);
    if (v) await G.send(ch, v.html, v.kb, Object.assign({}, thread, { reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } })).catch(() => {});
    return true;
  }

  const rep = parseReport(text), inLog = isLogTopic(topicName(ch, m)), rt = m.reply_to_message;
  if (rep.blank) return false;
  // in the log's topic every message of a player is a report, except an answer to somebody else and a long text
  // without marks (the rules of the topic); elsewhere only a report written by the template
  const toOther = !!(rt && !rt.forum_topic_created && rt.from && String(rt.from.id) !== player);
  const byTemplate = rep.any || (rep.template && !!(rep.text || rep.insight));
  if (!byTemplate && !(inLog && !toOther && text.length <= 1200 && (text.trim() || mediaTag(m)))) return false;

  const tz = await clock.appTz(), day = clock.parts(m.date * 1000, tz).d, id = checkId(p.id, player, day);
  const body = byTemplate ? rep.text : one([mediaTag(m), text].filter(Boolean).join(' '), 1500);
  const d = await db.mutateDoc('checkins', id, (was) => {
    const parts = Object.assign({}, was.parts);
    if (body) parts[String(m.message_id)] = body;
    const keys = Object.keys(parts).slice(-12), kept = {};
    for (const k of keys) kept[k] = parts[k];
    const next = Object.assign({ project: p.id, player, date: day, week: weekOf(day), spirit: null, soul: null, body: null, text: '', insight: '', signal: '', help: 0 }, was, { name, parts: kept, chat: keys.map((k) => kept[k]).join('\n').slice(0, 3000), src: was.src || 'chat', u: nowIso() });
    for (const b of BR) if (rep.marks[b] !== undefined && rep.marks[b] !== null) next[b] = rep.marks[b];
    if (rep.insight) next.insight = rep.insight;
    if (rep.signal) next.signal = rep.signal;
    if (rep.help && !(+was.help > 0)) next.help = 1;
    return next;
  });
  hub.publish('checkins', d.id, d.data, d.version);
  await showReport(ch, p, d, m, thread);
  // a call for help reaches the place where people talk, when the bot knows it
  if (!edited && (rep.signal === 'stuck' || rep.signal === 'help')) {
    const fire = Object.keys(ch.topics || {}).find((k) => isFireTopic(ch.topics[k]));
    if (fire && String(m.message_thread_id || '') !== fire) {
      const link = /^-100\d+$/.test(String(ch.tg)) ? 'https://t.me/c/' + String(ch.tg).slice(4) + '/' + m.message_id : '';
      await G.send(ch, (rep.signal === 'help' ? '🔴 ' : '🟡 ') + '<b>' + G.esc(name) + '</b> ' + (rep.signal === 'help' ? 'просит помощи или совместной сессии.' : 'застрял и просит совета.') + (link ? ' <a href="' + link + '">Отчёт</a>' : ''), undefined, { message_thread_id: +fire }).catch(() => {});
    }
  }
  return true;
}

// gz:<s|o|b|p>:<yyyymmdd of the week>:<player> — the player finishes a quest (or takes it back) under their card
async function onQuestTap(cq, doc, ack) {
  const m = /^gz:([sobp]):(\d{8}):(\d{1,20})$/.exec(String(cq.data || ''));
  if (!m) return ack();
  if (String(cq.from.id) !== m[3]) return ack('Это квесты другого игрока: завершает их он сам.', true);
  const ch = doc.data, p = await db.getDoc('projects', ch.project);
  if (!p || !isOn(p.data)) return ack('Игра в этом проекте выключена.', true);
  const week = m[2].slice(0, 4) + '-' + m[2].slice(4, 6) + '-' + m[2].slice(6), b = ZK[m[1]];
  const q = (await db.listDocs('quests')).find((d) => d.data.project === p.id && !d.data.lib && d.data.week === week && String(d.data.player) === m[3] && d.data.branch === b);
  if (!q) return ack('Этого квеста уже нет.', true);
  const d = await db.updateDoc('quests', q.id, { status: q.data.status === 'done' ? 'active' : 'done', u: nowIso() });
  hub.publish('quests', d.id, d.data, d.version);
  await ack(d.data.status === 'done' ? 'Квест завершён: XP начислены' : 'Квест снова в процессе');
  const v = await cardView(p, m[3], week), msg = cq.message;
  if (v && msg) await T.tg('editMessageText', { chat_id: ch.tg, message_id: msg.message_id, text: v.html, parse_mode: 'HTML', reply_markup: v.kb }).catch(() => {});
}
// gq:<s|so|b|h>:<yyyymmdd>:<player> — the player marks a branch or a help under their report
async function onCallback(cq, doc, ack) {
  if (/^gz:/.test(String(cq.data || ''))) return onQuestTap(cq, doc, ack);
  const m = /^gq:(s|so|b|h):(\d{8}):(\d{1,20})$/.exec(String(cq.data || ''));
  if (!m) return ack();
  if (String(cq.from.id) !== m[3]) return ack('Это отчёт другого игрока: отметки ставит он сам.', true);
  const ch = doc.data, p = await db.getDoc('projects', ch.project);
  if (!p || !isOn(p.data)) return ack('Игра в этом проекте выключена.', true);
  const day = m[2].slice(0, 4) + '-' + m[2].slice(4, 6) + '-' + m[2].slice(6), id = checkId(p.id, m[3], day);
  if (!(await db.getDoc('checkins', id))) return ack('Этого отчёта уже нет.', true);
  const R = rulesOf(p.data), b = { s: 'spirit', so: 'soul', b: 'body' }[m[1]];
  const d = await db.mutateDoc('checkins', id, (was) => Object.assign({}, was, b ? { [b]: was[b] === true ? null : true } : { help: (Math.round(+was.help || 0) + 1) % (R.helpMax + 1) }, { u: nowIso() }));
  hub.publish('checkins', d.id, d.data, d.version);
  await ack(b ? BRN[b] + (d.data[b] === true ? ': отмечено' : ': отметка снята') : 'Помощь за день: ' + d.data.help);
  const msg = cq.message, thread = msg && msg.is_topic_message && msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {};
  if (msg && (!d.data.ack || d.data.ack.id !== msg.message_id)) d.data.ack = { id: msg.message_id };
  await showReport(ch, p, d, null, thread);
}

// The player's card goes to the chat of the game on the player's word: to the topic of the quest board when the
// bot knows it. Returns true when it was sent.
async function postCard(p, player, week) {
  const v = await cardView(p, player, week);
  if (!v) return false;
  for (const c of await db.listDocs('chats')) {
    if (c.data.project !== p.id || c.data.on === false) continue;
    const t = Object.keys(c.data.topics || {}).find((k) => /quest\s*board|доска/i.test(c.data.topics[k]));
    const sent = await G.send(c.data, v.html, v.kb, t ? { message_thread_id: +t } : {}).catch(() => null);
    if (sent) return true;
  }
  return false;
}
// /companion in the chat: the way into the private talk with the AI companion
async function sayCompanion(ch, thread) {
  const p = await db.getDoc('projects', ch.project), name = G.me().name;
  if (!p || !isOn(p.data)) return G.send(ch, 'Игра в этом проекте не включена. Её включают те, кто ведёт проект: в дэшборде, в карточке проекта.', undefined, thread).catch(() => {});
  if (!name) return;
  return G.send(ch, '🧭 <b>AI-компаньон игры</b>\nЛичный помощник в чате со мной: знает действующие правила, помогает выбрать квесты и уровень, сохраняет карточку и отчёт дня. Никуда выходить из Telegram не нужно.\nРазговор видит только сам игрок; в игру попадают лишь квесты и отчёты, которые он попросит сохранить.', G.kb([[{ text: 'Открыть компаньона', url: 'https://t.me/' + name + '?start=gm_' + p.id }]]), thread).catch(() => {});
}
async function sayTable(ch, thread) {
  const p = await db.getDoc('projects', ch.project);
  if (!p || !isOn(p.data)) return G.send(ch, 'Игра в этом проекте не включена. Её включают те, кто ведёт проект: в дэшборде, в карточке проекта.', undefined, thread).catch(() => {});
  const tz = await clock.appTz(), week = weekOf(clock.parts(Date.now(), tz).d);
  return G.send(ch, await tableText(p, week), undefined, thread).catch(() => {});
}
// the game was switched on: the chats of the project hear what the bot now keeps
async function announce(projectId) {
  const p = await db.getDoc('projects', projectId);
  if (!p || !isOn(p.data)) return;
  for (const c of await db.listDocs('chats')) {
    if (c.data.project !== projectId || c.data.on === false) continue;
    await G.send(c.data, introText(p)).catch((err) => console.error('[game] not announced:', err.message));
  }
}

module.exports = { init, isOn, score, LEVELS, wonOf, postCard, sayCompanion, weekOf, weekLabel, parseCard, parseReport, mayWrite, onMessage, onCallback, sayTable, announce, table, introText, RULES, BR, checkId, questId, isLogTopic };
