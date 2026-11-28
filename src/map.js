'use strict';
// The map of a project: one page a whole team opens instead of reading a hundred new messages. It has three parts:
// the overview (what matters now, the streams of the project with what is there, what is in work and what is not
// decided, what comes next), a poll (where the project should go, what each one brings) and a lesson (how to fill
// in the records of the project's base, with a trainer that checks a card and keeps nothing).
//
// Somebody who runs a project sends the bot a .json file with the caption «/map проект»; the bot keeps it, shows
// how it looks and sends it to the project's work chat when told to. A project has one map: a new file replaces
// the content, the link and the answers of the poll stay, so a message pinned in the chat always opens the
// current picture.
//
// The map lives in the server's own collection `maps` (id mp<10 hex>): the page of the dashboard never reads it,
// a backup carries it. It opens by its token and only inside Telegram, so every answer has a name.
const crypto = require('crypto');
const express = require('express');
const cfg = require('./config');
const db = require('./db');
const auth = require('./auth');
const hub = require('./realtime');
const T = require('./telegram');
const clock = require('./clock');
const journal = require('./journal');
const join = require('./join');

let B = null; // what the bot lends: say, kb, esc, projects, pname, mine, matchProject, me, botName
const init = (ctx) => { B = ctx; };

const MAX_FILE = 100 * 1024, MAX_TEXT = 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{16}$/, ID_RE = /^mp[0-9a-f]{10}$/, KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,23}$/i;
const STATES = ['ok', 'work', 'open', 'idea'];
const https = () => /^https:\/\//.test(cfg.baseUrl);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const one = (s, n) => String(s == null ? '' : s).replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const person = (u) => auth.fullName(u || {}) || (u && u.username ? '@' + u.username : 'Без имени');
const bad = (why) => Object.assign(new Error(why), { code: 'shape', why });

/* ---------- the file ---------- */
const lines = (v, max, len) => (Array.isArray(v) ? v : []).map((x) => one(x, len || 300)).filter(Boolean).slice(0, max);
// ids of streams, questions, types and fields: given in the file or made from the place in the list
function keyOf(v, prefix, i, seen, what) {
  const k = v == null || v === '' ? prefix + (i + 1) : String(v);
  if (!KEY_RE.test(k)) throw bad(what + ': id «' + one(k, 30) + '» должен состоять из латинских букв, цифр, точки, дефиса или подчёркивания (до 24 знаков)');
  if (seen.has(k)) throw bad(what + ': id «' + k + '» повторяется');
  seen.add(k);
  return k;
}
// What the file says, cleaned and cut to size. Whatever is wrong is said in the words of the one who wrote the file.
function shape(src) {
  if (!isObj(src)) throw bad('В файле должен быть объект JSON: { "title": …, "streams": […] }');
  const m = { title: one(src.title, 120), lead: one(src.lead, 500), updated: one(src.updated, 40), now: lines(src.now, 6), streams: [], next: [], poll: null, learn: null };
  if (!m.title) throw bad('Нет названия карты: поле "title"');
  let seen = new Set();
  for (const [i, s] of (Array.isArray(src.streams) ? src.streams : []).slice(0, 16).entries()) {
    if (!isObj(s) || !one(s.name, 60)) throw bad('Направление №' + (i + 1) + ': нужно поле "name"');
    const state = s.state == null ? 'work' : String(s.state);
    if (!STATES.includes(state)) throw bad('Направление «' + one(s.name, 60) + '»: "state" бывает ok, work, open или idea');
    m.streams.push({ id: keyOf(s.id, 's', i, seen, 'Направление «' + one(s.name, 60) + '»'), name: one(s.name, 60), state, sum: one(s.sum, 240), who: one(s.who, 160), have: lines(s.have, 10), doing: lines(s.doing, 10), open: lines(s.open, 10) });
  }
  if (!m.streams.length) throw bad('В карте нет направлений: список "streams"');
  m.next = (Array.isArray(src.next) ? src.next : []).filter(isObj).map((n) => ({ when: one(n.when, 40), text: one(n.text, 300) })).filter((n) => n.text).slice(0, 8);
  if (isObj(src.poll)) {
    const p = { title: one(src.poll.title, 120) || 'Опрос', intro: one(src.poll.intro, 500), qs: [] };
    seen = new Set();
    for (const [i, q] of (Array.isArray(src.poll.qs) ? src.poll.qs : []).slice(0, 10).entries()) {
      if (!isObj(q) || !one(q.label, 240)) throw bad('Вопрос №' + (i + 1) + ': нужно поле "label"');
      const what = 'Вопрос «' + one(q.label, 40) + '»', t = q.t == null ? 'one' : String(q.t);
      if (!['one', 'many', 'text'].includes(t)) throw bad(what + ': "t" бывает one, many или text');
      const out = { id: keyOf(q.id, 'q', i, seen, what), t, label: one(q.label, 240), s: one(q.s, 30), hint: one(q.hint, 300), req: q.req === true };
      if (t === 'text') out.ph = one(q.ph, 160);
      else {
        out.opts = [...new Set(lines(q.opts, 12, 120))];
        if (out.opts.length < 2) throw bad(what + ': нужно хотя бы два варианта в "opts"');
        if (t === 'many') out.max = Math.min(out.opts.length, Math.max(1, Math.floor(+q.max) || out.opts.length));
      }
      p.qs.push(out);
    }
    if (p.qs.length) m.poll = p;
  }
  if (isObj(src.learn)) {
    const l = { title: one(src.learn.title, 120) || 'Обучение', intro: one(src.learn.intro, 600), rules: lines(src.learn.rules, 8), types: [] };
    seen = new Set();
    for (const [i, t] of (Array.isArray(src.learn.types) ? src.learn.types : []).slice(0, 12).entries()) {
      if (!isObj(t) || !one(t.name, 60)) throw bad('Тип записи №' + (i + 1) + ': нужно поле "name"');
      const what = 'Тип записи «' + one(t.name, 60) + '»', fseen = new Set();
      const fields = (Array.isArray(t.fields) ? t.fields : []).slice(0, 20).map((f, k) => {
        if (!isObj(f) || !one(f.label, 80)) throw bad(what + ', поле №' + (k + 1) + ': нужно поле "label"');
        return { id: keyOf(f.id, 'f', k, fseen, what + ', поле «' + one(f.label, 40) + '»'), label: one(f.label, 80), req: f.req === true, long: f.long === true, hint: one(f.hint, 300), ex: one(f.ex, 300) };
      });
      if (!fields.length) throw bad(what + ': нужен список полей "fields"');
      l.types.push({ id: keyOf(t.id, 't', i, seen, what), name: one(t.name, 60), what: one(t.what, 300), where: one(t.where, 300), fields, mistakes: lines(t.mistakes, 8) });
    }
    if (l.types.length) m.learn = l;
  }
  return m;
}
function parse(text) {
  let j;
  try { j = JSON.parse(String(text || '').replace(/^﻿/, '')); } catch (e) { throw bad('Файл не читается как JSON: ' + one(e.message, 120)); }
  return shape(j);
}

/* ---------- storage ---------- */
const all = async () => (await db.listDocs('maps')).filter((d) => d.data && d.data.token);
const byToken = async (token) => (TOKEN_RE.test(String(token || '')) ? (await all()).find((d) => d.data.token === token) || null : null);
const ofProject = async (project) => (await all()).find((d) => d.data.project === project) || null;
// one map per project: a new file changes what the map says; its link and the answers people gave stay
async function save(project, def, by) {
  const at = new Date().toISOString(), cur = await ofProject(project);
  if (cur) return { doc: await db.mutateDoc('maps', cur.id, (d) => { d.def = def; d.at = at; d.by = one(by, 80); return d; }), fresh: false };
  const id = 'mp' + crypto.randomBytes(5).toString('hex');
  return { doc: await db.setDoc('maps', id, { project, def, token: crypto.randomBytes(12).toString('base64url'), at, by: one(by, 80), sent: [], answers: {} }), fresh: true };
}
const answersOf = (o) => (isObj(o.answers) ? Object.values(o.answers).filter((a) => a && isObj(a.a)) : []).sort((a, b) => String(a.at).localeCompare(String(b.at)));
// Who chose what. An answer to a question that the new file no longer has, or an option it no longer offers, is not counted.
function tally(o) {
  const poll = o.def && o.def.poll, list = answersOf(o);
  if (!poll) return { n: 0, qs: [] };
  const live = (q, a) => { const v = a.a[q.id]; return q.t === 'text' ? (typeof v === 'string' && v ? v : '') : (Array.isArray(v) ? v : v ? [v] : []).filter((x) => q.opts.includes(x)); };
  const said = list.filter((a) => poll.qs.some((q) => { const v = live(q, a); return q.t === 'text' ? !!v : v.length > 0; }));
  return {
    n: said.length,
    qs: poll.qs.map((q) => (q.t === 'text'
      ? { id: q.id, texts: said.map((a) => ({ name: a.name, text: live(q, a) })).filter((x) => x.text) }
      : { id: q.id, opts: q.opts.map((opt) => ({ opt, who: said.filter((a) => live(q, a).includes(opt)).map((a) => a.name) })) })),
  };
}
const short = (q) => q.s || one(q.label.replace(/[?!.:]+$/, ''), 40);
const flat = (v) => (Array.isArray(v) ? v.join('; ') : String(v == null ? '' : v));
function answersText(o) {
  const poll = o.def && o.def.poll;
  if (!poll) return 'В этой карте нет опроса.';
  const t = tally(o);
  if (!t.n) return 'На опрос пока никто не ответил.';
  const out = ['Ответили: <b>' + t.n + '</b>'];
  poll.qs.forEach((q, i) => {
    const r = t.qs[i];
    if (r.opts) out.push('<b>' + esc(short(q)) + '</b>\n' + r.opts.map((x) => '• ' + esc(x.opt) + ': ' + (x.who.length ? x.who.length + ' (' + esc(x.who.join(', ')) + ')' : '0')).join('\n'));
    else if (r.texts.length) out.push('<b>' + esc(short(q)) + '</b>\n' + r.texts.slice(-15).map((x) => '• ' + esc(x.name) + ': ' + esc(one(x.text, 400))).join('\n'));
  });
  return out.join('\n\n').slice(0, 3900);
}

/* ---------- the bot: those who run the project ---------- */
const url = (o) => 'https://t.me/' + B.botName() + '?start=mp_' + o.token;
const parts = (def) => ['обзор проекта'].concat(def.poll ? ['опрос'] : [], def.learn ? ['обучение'] : []);
const chatText = (o) => '<b>' + esc(o.def.title) + '</b>' + (o.def.lead ? '\n\n' + esc(o.def.lead) : '') +
  '\n\nОткройте карту кнопкой ниже. Внутри: ' + parts(o.def).join(', ') + '. Ссылка постоянная: карта обновляется, а сообщение можно закрепить.';
const chatsOf = async (project) => (await db.listDocs('chats')).filter((d) => d.data.project === project && d.data.on !== false && d.data.tg);
async function card(chat, doc, head) {
  const o = doc.data, p = await db.getDoc('projects', o.project), chats = await chatsOf(o.project), rows = [], d = o.def;
  if (https()) rows.push([{ text: 'Открыть карту', web_app: { url: cfg.baseUrl + '/m/' + o.token } }]);
  chats.slice(0, 6).forEach((c) => rows.push([{ text: ('Отправить в чат «' + one(c.data.title, 30) + '»').slice(0, 60), callback_data: 'mp:s:' + doc.id + ':' + c.id }]));
  rows.push([{ text: 'Ответы опроса', callback_data: 'mp:a:' + doc.id }, { text: 'Удалить карту', callback_data: 'mp:d:' + doc.id }]);
  const inside = 'направлений: ' + d.streams.length + (d.poll ? ', вопросов в опросе: ' + d.poll.qs.length : ', опроса нет') + (d.learn ? ', типов записей в обучении: ' + d.learn.types.length : ', обучения нет');
  return B.say(chat, (head || 'Карта') + ' <b>«' + esc(d.title) + '»</b>, проект <b>' + esc(p ? B.pname(p) : '') + '</b>. Внутри ' + inside + '.\n\n' +
    'Открой её кнопкой ниже: так её увидит команда. Ответы на опрос видит вся команда; каждый ответ я пришлю координаторам проекта и сохраню в его переписке. Тренажёр в обучении ничего не сохраняет.\n\n' +
    'Чтобы обновить карту, пришли новый файл с той же подписью: ссылка и ответы останутся.\n\n' +
    (chats.length ? 'Сообщение для чата будет таким:' : 'У проекта нет рабочего чата со мной. Добавь меня в чат команды (страница проекта → «Рабочие чаты») или перешли людям эту ссылку сам:\n' + esc(url(o)) + '\n\nСообщение для чата было бы таким:') +
    '\n<blockquote>' + chatText(o) + '</blockquote>', B.kb(rows));
}
// A .json file with the caption «/map проект».
async function fromFile(m) {
  const chat = m.chat.id, d = m.document, query = (/^\/map(?:@\w+)?[ \t]*([^\n]*)/i.exec(String(m.caption || '').trim()) || [])[1] || '';
  if (!/\.json$/i.test(String(d.file_name || '')) && !/json/.test(d.mime_type || '')) return B.say(chat, 'Карту проекта принимаю файлом .json.');
  if ((+d.file_size || 0) > MAX_FILE) return B.say(chat, 'Файл больше 100 КБ. Сократи карту.');
  const list = await B.projects(), mp = query.trim() ? B.matchProject(query.trim(), list, false) : { best: list.length === 1 ? list[0] : null };
  if (!mp.best) return B.say(chat, query.trim() ? 'Не нашёл проект «' + esc(query.trim()) + '». Пришли файл ещё раз с подписью: /map название проекта' : 'К какому проекту относится карта? Пришли файл ещё раз с подписью: /map название проекта');
  let def;
  try { def = parse((await T.readFile(d.file_id, MAX_FILE)).toString('utf8')); }
  catch (e) { if (e.code !== 'shape') throw e; return B.say(chat, 'Карту не сохранил. ' + esc(e.why) + '.'); }
  const r = await save(mp.best.id, def, B.me().name);
  journal.event('bulk', 'Карта проекта «' + def.title + '» ' + (r.fresh ? 'создана' : 'обновлена') + ': проект «' + B.pname(mp.best) + '»', B.me().name || 'бот');
  return card(chat, r.doc, r.fresh ? 'Сохранил карту' : 'Обновил карту');
}
// «/map» without a file: the maps of my projects and how to add one
async function list(chat) {
  const mine = (await all()).filter((d) => B.mine(d.data.project)).sort((a, b) => String(b.data.at).localeCompare(String(a.data.at)));
  const how = 'Чтобы сделать или обновить карту проекта, пришли мне файл .json с подписью:\n<code>/map название проекта</code>\nВ карте три части: обзор (что сейчас есть в проекте), опрос и обучение. У проекта одна карта: новый файл заменяет содержание, ссылка и ответы остаются.';
  if (!mine.length) return B.say(chat, 'Карт проектов пока нет.\n\n' + how);
  const ps = await B.projects(), rows = mine.slice(0, 8).map((d) => [{ text: one(d.data.def.title, 44), callback_data: 'mp:c:' + d.id }]);
  const out = mine.slice(0, 8).map((d) => { const p = ps.find((x) => x.id === d.data.project); return '• <b>' + esc(d.data.def.title) + '</b>' + (p ? ', ' + esc(B.pname(p)) : '') + ': ответили на опрос ' + tally(d.data).n; });
  return B.say(chat, 'Карты проектов:\n' + out.join('\n') + '\n\nНажми на карту, чтобы открыть её, отправить в чат или посмотреть ответы.\n\n' + how, B.kb(rows));
}
// mp:c:<id> the card, mp:s:<id>:<chat> send to a work chat, mp:a:<id> the answers, mp:d:<id> / mp:D:<id> delete
async function onCallback(cq, data, chat, ack, edit) {
  const m = /^mp:([csadD]):(mp[0-9a-f]{10})(?::(g\d{1,20}))?$/.exec(data);
  if (!m) return ack();
  const doc = await db.getDoc('maps', m[2]);
  if (!doc || !doc.data.token || !B.mine(doc.data.project)) { await ack('Этой карты уже нет'); return undefined; }
  const o = doc.data, title = o.def.title;
  if (m[1] === 'c') { await ack(); return card(chat, doc); }
  if (m[1] === 'a') { await ack(); return B.say(chat, '<b>«' + esc(title) + '»</b>\n\n' + answersText(o)); }
  if (m[1] === 'd') { await ack(); return B.say(chat, 'Удалить карту «' + esc(title) + '» вместе с ответами опроса? Ссылка на неё перестанет открываться.', B.kb([[{ text: 'Да, удалить', callback_data: 'mp:D:' + doc.id }], [{ text: 'Отмена', callback_data: 'x' }]])); }
  if (m[1] === 'D') {
    await db.deleteDoc('maps', doc.id);
    journal.event('bulk', 'Карта проекта «' + title + '» удалена', B.me().name || 'бот');
    await ack('Удалил');
    return edit(chat, 'Карта «' + esc(title) + '» удалена. Сообщения в переписке проекта остались.');
  }
  const ch = m[3] ? (await chatsOf(o.project)).find((c) => c.id === m[3]) : null;
  if (!ch) return ack('Этот чат больше не привязан к проекту');
  if (!B.botName()) return ack('Бот ещё не готов, попробуй через минуту');
  try {
    await T.tg('sendMessage', { chat_id: ch.data.tg, text: chatText(o), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[{ text: 'Открыть карту проекта', url: url(o) }]] } });
  } catch (e) {
    await ack('Не отправилось');
    return B.say(chat, 'Не получилось написать в чат «' + esc(ch.data.title || '') + '»: ' + esc(e.message) + '. Проверь, что я всё ещё в этом чате и могу там писать.');
  }
  const kept = await db.mutateDoc('maps', doc.id, (cur) => { if (cur.token) cur.sent = (Array.isArray(cur.sent) ? cur.sent : []).concat([{ chat: ch.id, at: new Date().toISOString(), by: B.me().name || '' }]).slice(-20); return cur; });
  if (!kept.data.token) await db.deleteDoc('maps', doc.id); // deleted while the message was on its way
  journal.event('bulk', 'Карта «' + title + '» отправлена в чат «' + one(ch.data.title, 50) + '»', B.me().name || 'бот');
  await ack('Отправил');
  return B.say(chat, 'Отправил карту «' + esc(title) + '» в чат «' + esc(ch.data.title || '') + '». Сообщение стоит закрепить: ссылка постоянная. Ответы на опрос буду присылать сюда; все сразу: /map.');
}

/* ---------- the bot: anybody with the link ---------- */
// «/start mp_<token>»: the button under the message in the work chat leads here
async function start(m, token) {
  const doc = await byToken(token);
  if (!doc) return B.say(m.chat.id, 'Эта карта больше не доступна. Попросите у организатора новую ссылку.');
  const d = doc.data.def;
  return B.say(m.chat.id, '<b>' + esc(d.title) + '</b>' + (d.lead ? '\n\n' + esc(d.lead) : '') +
    (https() ? '\n\nКарта открывается прямо здесь, в Telegram. Внутри: ' + parts(d).join(', ') + '.' : '\n\nУ сервера пока нет публичного адреса, карту открыть нельзя.'),
  https() ? { inline_keyboard: [[{ text: 'Открыть карту проекта', web_app: { url: cfg.baseUrl + '/m/' + doc.data.token } }]] } : undefined);
}

/* ---------- the page ---------- */
function stateFor(doc, user, p) {
  const o = doc.data, mine = isObj(o.answers) ? o.answers[String(user.id)] : null;
  return {
    map: o.def, project: p ? String(p.data.name || '') : '', app: cfg.appName, at: o.at, by: o.by || '',
    user: { name: person(user) }, mine: mine && isObj(mine.a) ? { a: mine.a, at: mine.at } : null, results: tally(o),
  };
}
// The answers of one person, checked against the poll as it is now. Returns { a } or { errors: { id: words } }.
function clean(poll, input) {
  const a = {}, errors = {}, src = isObj(input) ? input : {};
  for (const q of poll.qs) {
    const v = src[q.id];
    if (q.t === 'text') {
      const s = String(v == null ? '' : v).replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);
      if (s) a[q.id] = s; else if (q.req) errors[q.id] = 'Напишите хотя бы пару слов';
    } else if (q.t === 'one') {
      if (typeof v === 'string' && q.opts.includes(v)) a[q.id] = v; else if (q.req) errors[q.id] = 'Выберите вариант';
    } else {
      const l = [...new Set(Array.isArray(v) ? v : [])].filter((x) => typeof x === 'string' && q.opts.includes(x));
      if (l.length > q.max) errors[q.id] = 'Можно выбрать не больше ' + q.max;
      else if (l.length) a[q.id] = l; else if (q.req) errors[q.id] = 'Выберите хотя бы один вариант';
    }
  }
  return Object.keys(errors).length ? { errors } : { a };
}
async function answer(doc, user, a) {
  const tg = String(user.id), at = new Date().toISOString(), o = doc.data, poll = o.def.poll;
  const entry = { tg, name: person(user), username: String(user.username || '').slice(0, 40), a, at };
  let was = null, same = false;
  const next = await db.mutateDoc('maps', doc.id, (cur) => {
    if (!cur.token) return cur; // deleted meanwhile
    if (!isObj(cur.answers)) cur.answers = {};
    was = cur.answers[tg] || null;
    // the base does not keep the order of keys: the answers are compared question by question
    same = !!was && isObj(was.a) && poll.qs.every((q) => JSON.stringify(was.a[q.id] == null ? null : was.a[q.id]) === JSON.stringify(a[q.id] == null ? null : a[q.id]));
    if (!same) cur.answers[tg] = entry;
    return cur;
  });
  if (!next.data.token) { await db.deleteDoc('maps', doc.id); return null; }
  if (same) return next;
  // the answer of a person is kept in the project's messages and waits for review, as every reply does
  const said = poll.qs.filter((q) => a[q.id] != null).map((q) => [short(q), flat(a[q.id])]);
  const tz = await clock.appTz(), id = 'mp' + crypto.randomBytes(6).toString('hex'), head = (was ? 'Изменил ответы на опрос' : 'Ответил на опрос') + ' «' + poll.title + '»';
  const msg = await db.setDoc('messages', id, {
    project: o.project, contact: '', from: entry.name + (entry.username ? ' (@' + entry.username + ')' : ''), text: head + '.\n' + said.map((x) => x[0] + ': ' + x[1]).join('\n'), summary: '',
    date: clock.parts(Date.now(), tz).d, channel: 'tg', review: 'pending', proposal: null, applied: [], src: 'map', u: at,
  });
  hub.publish('messages', id, msg.data, msg.version);
  journal.note('add', 'messages', id, msg.data, null, 'бот');
  const news = '<b>' + esc(entry.name) + '</b>' + (entry.username ? ' (@' + esc(entry.username) + ')' : '') + ': ' + esc(head.charAt(0).toLowerCase() + head.slice(1)) + '.\n' +
    '<blockquote>' + said.map((x) => '<b>' + esc(x[0]) + ':</b> ' + esc(one(x[1], 500))).join('\n') + '</blockquote>';
  if (cfg.botToken) await join.tell(o.project, tg, news.slice(0, 3900)).catch((e) => console.error('[map] not told:', e.message));
  return next;
}
function router(botName) {
  const r = express.Router();
  const ctx = async (req, res) => {
    const doc = await byToken(req.params.token), p = doc && await db.getDoc('projects', doc.data.project);
    if (!doc || !p) { res.status(404).json({ error: 'link_closed' }); return null; }
    const user = auth.checkInitData(req.body && req.body.initData);
    if (!user) { res.status(401).json({ error: 'unauthorized' }); return null; }
    return { doc, p, user };
  };
  // outside Telegram the page learns only where to go: the map itself is for people with a name
  r.get('/:token', async (req, res) => {
    const doc = await byToken(req.params.token);
    if (!doc) return res.status(404).json({ error: 'link_closed' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ title: doc.data.def.title, app: cfg.appName, bot: botName(), start: 'mp_' + doc.data.token });
  });
  r.post('/:token/me', async (req, res) => {
    const c = await ctx(req, res); if (!c) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json(stateFor(c.doc, c.user, c.p));
  });
  r.post('/:token/answer', async (req, res) => {
    const c = await ctx(req, res); if (!c) return;
    const poll = c.doc.data.def.poll;
    if (!poll) return res.status(400).json({ error: 'no_poll' });
    const v = clean(poll, req.body.a);
    if (v.errors) return res.status(400).json({ error: 'invalid', errors: v.errors });
    if (!Object.keys(v.a).length) return res.status(400).json({ error: 'empty' });
    const next = await answer(c.doc, c.user, v.a);
    if (!next) return res.status(404).json({ error: 'link_closed' });
    res.json(stateFor(next, c.user, c.p));
  });
  return r;
}

module.exports = { init, router, start, fromFile, list, onCallback, shape, parse, save, byToken, tally, clean, ID_RE };
