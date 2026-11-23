'use strict';
// A document a team answers: an offer, terms, a plan. Somebody who runs a project sends the bot a text file with
// the caption «/offer проект»; the bot keeps it, shows how it looks and sends it to the project's work chat when
// told to. The page ends with two buttons: «Согласен с условиями» and «Хочу уточнить» (with a field for the
// question). Every answer is kept on the document, lands in the project's messages for review like any reply
// of a client, and those who run the project hear about it at once.
//
// The text lives in the server's own collection `offers` (id of<10 hex>): the page of the dashboard never reads
// it, a backup carries it. A document opens by its token and only inside Telegram, so every answer has a name.
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

let B = null; // what the bot lends: say, kb, esc, projects, pname, mine, matchProject, botName
const init = (ctx) => { B = ctx; };

const MAX_MD = 100 * 1024, MAX_ASK = 2000, MAX_ANSWERS = 400;
const TOKEN_RE = /^[A-Za-z0-9_-]{16}$/, ID_RE = /^of[0-9a-f]{10}$/;
const https = () => /^https:\/\//.test(cfg.baseUrl);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const one = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const plain = (s) => String(s || '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/`([^`]+)`/g, '$1');
const person = (u) => auth.fullName(u || {}) || (u && u.username ? '@' + u.username : 'Без имени');

/* ---------- the text ---------- */
// The title is the first heading; without one, the first line. The lead is the first paragraph under it.
function outline(md, fallback) {
  const lines = String(md || '').split('\n').map((l) => l.trim());
  let title = '', lead = '', at = -1;
  for (let i = 0; i < lines.length; i++) { const h = /^#{1,3}\s+(.+)$/.exec(lines[i]); if (h) { title = h[1]; at = i; break; } }
  if (!title) { at = lines.findIndex((l) => l); title = at >= 0 ? lines[at] : ''; }
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) { if (lead) break; continue; }
    if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>|```)/.test(l)) { if (lead) break; continue; }
    lead += (lead ? ' ' : '') + l;
  }
  return { title: one(plain(title), 120) || one(fallback, 120) || 'Документ', lead: one(plain(lead), 400) };
}
const url = (o) => 'https://t.me/' + B.botName() + '?start=of_' + o.token;
// what the work chat hears: the words of the one who sends it, or the title with the first paragraph
function chatText(o) {
  const body = o.note ? esc(o.note) : '<b>' + esc(o.title) + '</b>' + (o.lead ? '\n\n' + esc(o.lead) : '');
  return body + '\n\nОткройте документ кнопкой ниже. В конце две кнопки: «Согласен с условиями» и «Хочу уточнить».';
}

/* ---------- storage ---------- */
const all = async () => (await db.listDocs('offers')).filter((d) => d.data && d.data.token);
const byToken = async (token) => (TOKEN_RE.test(String(token || '')) ? (await all()).find((d) => d.data.token === token) || null : null);
async function create(project, md, extra) {
  const text = String(md || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw Object.assign(new Error('empty'), { code: 'empty' });
  if (Buffer.byteLength(text) > MAX_MD) throw Object.assign(new Error('too large'), { code: 'too_large' });
  const o = outline(text, extra && extra.name);
  const id = 'of' + crypto.randomBytes(5).toString('hex');
  return db.setDoc('offers', id, {
    project, title: o.title, lead: o.lead, md: text, note: one(extra && extra.note, 1200), token: crypto.randomBytes(12).toString('base64url'),
    at: new Date().toISOString(), by: one(extra && extra.by, 80), sent: [], answers: [],
  });
}
// the last word of everybody: who agreed, who asked what
function tally(o) {
  const yes = new Map(), asks = [];
  for (const a of Array.isArray(o.answers) ? o.answers : []) {
    if (a.kind === 'yes') yes.set(a.tg, a); else if (a.kind === 'ask') asks.push(a);
  }
  return { yes: [...yes.values()], asks };
}
const who = (a) => esc(a.name || 'Без имени') + (a.username ? ' (@' + esc(a.username) + ')' : '');
function answersText(o) {
  const t = tally(o), lines = [];
  lines.push(t.yes.length ? '<b>Согласны (' + t.yes.length + '):</b>\n' + t.yes.map((a) => '• ' + who(a)).join('\n') : 'Согласных пока нет.');
  if (t.asks.length) lines.push('<b>Вопросы (' + t.asks.length + '):</b>\n' + t.asks.slice(-12).map((a) => '• ' + who(a) + ': ' + esc(one(a.text, 500))).join('\n'));
  return lines.join('\n\n');
}

/* ---------- the bot: those who run the project ---------- */
const chatsOf = async (project) => (await db.listDocs('chats')).filter((d) => d.data.project === project && d.data.on !== false && d.data.tg);
async function card(chat, doc) {
  const o = doc.data, p = await db.getDoc('projects', o.project), chats = await chatsOf(o.project), rows = [];
  if (https()) rows.push([{ text: 'Открыть документ', web_app: { url: cfg.baseUrl + '/o/' + o.token } }]);
  chats.slice(0, 6).forEach((c) => rows.push([{ text: ('Отправить в чат «' + one(c.data.title, 30) + '»').slice(0, 60), callback_data: 'of:s:' + doc.id + ':' + c.id }]));
  rows.push([{ text: 'Ответы', callback_data: 'of:a:' + doc.id }, { text: 'Удалить документ', callback_data: 'of:d:' + doc.id }]);
  return B.say(chat, 'Документ <b>«' + esc(o.title) + '»</b> сохранён в проекте <b>' + esc(p ? B.pname(p) : '') + '</b>.\n\n' +
    'В конце страницы две кнопки: «Согласен с условиями» и «Хочу уточнить» с полем для вопроса. Каждый ответ я пришлю координаторам проекта и сохраню в его переписке.\n\n' +
    (chats.length ? 'Сообщение для чата будет таким:' : 'У проекта нет рабочего чата со мной. Добавь меня в чат команды (страница проекта → «Рабочие чаты») или перешли людям эту ссылку сам:\n' + esc(url(o)) + '\n\nСообщение для чата было бы таким:') +
    '\n<blockquote>' + chatText(o) + '</blockquote>', B.kb(rows));
}
// A text file with the caption «/offer проект»; the lines of the caption after the first one are the words for the chat.
async function fromFile(m) {
  const chat = m.chat.id, d = m.document, cap = String(m.caption || '').trim();
  const head = /^\/offer(?:@\w+)?[ \t]*([^\n]*)(?:\n([\s\S]*))?$/i.exec(cap) || [], query = (head[1] || '').trim(), note = (head[2] || '').trim();
  if (!/^text\//.test(d.mime_type || '') && !/\.(md|txt|markdown)$/i.test(String(d.file_name || ''))) return B.say(chat, 'Документ принимаю текстовым файлом: .md или .txt.');
  if ((+d.file_size || 0) > MAX_MD) return B.say(chat, 'Файл больше 100 КБ. Сократи документ или раздели его на два.');
  const list = await B.projects(), mp = query ? B.matchProject(query, list, false) : { best: list.length === 1 ? list[0] : null };
  if (!mp.best) return B.say(chat, query ? 'Не нашёл проект «' + esc(query) + '». Пришли файл ещё раз с подписью: /offer название проекта' : 'К какому проекту относится документ? Пришли файл ещё раз с подписью: /offer название проекта');
  const text = (await T.readFile(d.file_id, MAX_MD)).toString('utf8');
  let doc;
  try { doc = await create(mp.best.id, text, { name: String(d.file_name || '').replace(/\.[a-z]+$/i, ''), note, by: B.me().name }); }
  catch (e) { return B.say(chat, e.code === 'empty' ? 'В файле нет текста.' : 'Файл больше 100 КБ. Сократи документ или раздели его на два.'); }
  journal.event('bulk', 'Документ на согласование «' + doc.data.title + '»: проект «' + B.pname(mp.best) + '»', B.me().name || 'бот');
  return card(chat, doc);
}
// «/offer» without a file: the documents of my projects and how to add one
async function list(chat) {
  const mine = (await all()).filter((d) => B.mine(d.data.project)).sort((a, b) => String(b.data.at).localeCompare(String(a.data.at)));
  const how = 'Чтобы отправить команде документ на согласование, пришли мне файл .md или .txt с подписью:\n<code>/offer название проекта</code>\nСо второй строки подписи можно написать свой текст сообщения для чата.';
  if (!mine.length) return B.say(chat, 'Документов на согласование пока нет.\n\n' + how);
  const ps = await B.projects(), rows = mine.slice(0, 8).map((d) => [{ text: one(d.data.title, 44), callback_data: 'of:c:' + d.id }]);
  const lines = mine.slice(0, 8).map((d) => {
    const t = tally(d.data), p = ps.find((x) => x.id === d.data.project);
    return '• <b>' + esc(d.data.title) + '</b>' + (p ? ', ' + esc(B.pname(p)) : '') + ': согласны ' + t.yes.length + ', вопросов ' + t.asks.length;
  });
  return B.say(chat, 'Документы на согласование:\n' + lines.join('\n') + '\n\nНажми на документ, чтобы открыть его, отправить в чат или посмотреть ответы.\n\n' + how, B.kb(rows));
}
// of:c:<id> the card, of:s:<id>:<chat> send to a work chat, of:a:<id> the answers, of:d:<id> / of:D:<id> delete
async function onCallback(cq, data, chat, ack, edit) {
  const m = /^of:([csadD]):(of[0-9a-f]{10})(?::(g\d{1,20}))?$/.exec(data);
  if (!m) return ack();
  const doc = await db.getDoc('offers', m[2]);
  if (!doc || !B.mine(doc.data.project)) { await ack('Этого документа уже нет'); return undefined; }
  const o = doc.data;
  if (m[1] === 'c') { await ack(); return card(chat, doc); }
  if (m[1] === 'a') { await ack(); return B.say(chat, '<b>«' + esc(o.title) + '»</b>\n\n' + answersText(o)); }
  if (m[1] === 'd') { await ack(); return B.say(chat, 'Удалить документ «' + esc(o.title) + '» вместе с ответами? Ссылка на него перестанет открываться.', B.kb([[{ text: 'Да, удалить', callback_data: 'of:D:' + doc.id }], [{ text: 'Отмена', callback_data: 'x' }]])); }
  if (m[1] === 'D') {
    await db.deleteDoc('offers', doc.id);
    journal.event('bulk', 'Документ на согласование «' + o.title + '» удалён', B.me().name || 'бот');
    await ack('Удалил');
    return edit(chat, 'Документ «' + esc(o.title) + '» удалён. Сообщения в переписке проекта остались.');
  }
  // send: the work chat of this very project, the bot still in it
  const ch = m[3] ? (await chatsOf(o.project)).find((c) => c.id === m[3]) : null;
  if (!ch) return ack('Этот чат больше не привязан к проекту');
  if (!B.botName()) return ack('Бот ещё не готов, попробуй через минуту');
  try {
    await T.tg('sendMessage', { chat_id: ch.data.tg, text: chatText(o), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[{ text: 'Открыть документ', url: url(o) }]] } });
  } catch (e) {
    await ack('Не отправилось');
    return B.say(chat, 'Не получилось написать в чат «' + esc(ch.data.title || '') + '»: ' + esc(e.message) + '. Проверь, что я всё ещё в этом чате и могу там писать.');
  }
  const kept = await db.mutateDoc('offers', doc.id, (cur) => { if (cur.token) cur.sent = (Array.isArray(cur.sent) ? cur.sent : []).concat([{ chat: ch.id, at: new Date().toISOString(), by: B.me().name || '' }]).slice(-20); return cur; });
  if (!kept.data.token) await db.deleteDoc('offers', doc.id); // deleted while the message was on its way
  journal.event('bulk', 'Документ «' + o.title + '» отправлен в чат «' + one(ch.data.title, 50) + '»', B.me().name || 'бот');
  await ack('Отправил');
  return B.say(chat, 'Отправил «' + esc(o.title) + '» в чат «' + esc(ch.data.title || '') + '». Ответы буду присылать сюда; все сразу: /offer.');
}

/* ---------- the bot: anybody with the link ---------- */
// «/start of_<token>»: the button under the message in the work chat leads here
async function start(m, token) {
  const doc = await byToken(token);
  if (!doc) return B.say(m.chat.id, 'Этот документ больше не доступен. Попросите у организатора новую ссылку.');
  return B.say(m.chat.id, '<b>' + esc(doc.data.title) + '</b>' + (doc.data.lead ? '\n\n' + esc(doc.data.lead) : '') +
    (https() ? '\n\nДокумент открывается прямо здесь, в Telegram. В конце можно согласиться с условиями или задать вопрос.' : '\n\nУ сервера пока нет публичного адреса, документ открыть нельзя.'),
  https() ? { inline_keyboard: [[{ text: 'Открыть документ', web_app: { url: cfg.baseUrl + '/o/' + doc.data.token } }]] } : undefined);
}

/* ---------- the page ---------- */
function stateFor(doc, user, p) {
  const o = doc.data, tg = String(user.id), mine = (Array.isArray(o.answers) ? o.answers : []).filter((a) => a.tg === tg);
  const yes = mine.filter((a) => a.kind === 'yes').pop();
  return {
    title: o.title, md: o.md, project: p ? String(p.data.name || '') : '', app: cfg.appName, by: o.by || '', at: o.at,
    user: { name: person(user) },
    mine: { yes: yes ? yes.at : '', asks: mine.filter((a) => a.kind === 'ask').map((a) => ({ text: a.text, at: a.at })) },
  };
}
async function answer(doc, user, kind, text) {
  const tg = String(user.id), at = new Date().toISOString(), o = doc.data;
  const entry = { tg, name: person(user), username: String(user.username || '').slice(0, 40), kind, at };
  if (kind === 'ask') entry.text = text;
  let added = false;
  const next = await db.mutateDoc('offers', doc.id, (cur) => {
    if (!cur.token) return cur; // deleted meanwhile
    const list = Array.isArray(cur.answers) ? cur.answers : [];
    // «согласен» is said once; the same question twice in a row is a double tap
    const last = list.filter((a) => a.tg === tg).pop();
    if (kind === 'yes' ? list.some((a) => a.tg === tg && a.kind === 'yes') : !!last && last.kind === 'ask' && last.text === text) return cur;
    cur.answers = list.concat([entry]).slice(-MAX_ANSWERS);
    added = true;
    return cur;
  });
  if (!next.data.token) { await db.deleteDoc('offers', doc.id); return null; }
  if (!added) return next;
  // the reply of a person is kept in the project's messages and waits for review, as every reply does
  const tz = await clock.appTz(), id = 'of' + crypto.randomBytes(6).toString('hex');
  const body = kind === 'yes' ? 'Согласен с условиями документа «' + o.title + '».' : 'Вопрос по документу «' + o.title + '»: ' + text;
  const msg = await db.setDoc('messages', id, {
    project: o.project, contact: '', from: entry.name + (entry.username ? ' (@' + entry.username + ')' : ''), text: body, summary: '',
    date: clock.parts(Date.now(), tz).d, channel: 'tg', review: 'pending', proposal: null, applied: [], src: 'offer', u: at,
  });
  hub.publish('messages', id, msg.data, msg.version);
  journal.note('add', 'messages', id, msg.data, null, 'бот');
  const link = entry.username ? '@' + esc(entry.username) : '<a href="tg://user?id=' + tg + '">' + esc(entry.name) + '</a>';
  const news = kind === 'yes'
    ? '<b>' + esc(entry.name) + '</b>' + (entry.username ? ' (@' + esc(entry.username) + ')' : '') + ': согласен с условиями документа «' + esc(o.title) + '».'
    : '<b>' + esc(entry.name) + '</b>' + (entry.username ? ' (@' + esc(entry.username) + ')' : '') + ' хочет уточнить по документу «' + esc(o.title) + '»:\n<blockquote>' + esc(text) + '</blockquote>\nОтветить: ' + link;
  if (cfg.botToken) await join.tell(o.project, tg, news).catch((e) => console.error('[offer] not told:', e.message));
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
  // outside Telegram the page learns only where to go: the text itself is for people with a name
  r.get('/:token', async (req, res) => {
    const doc = await byToken(req.params.token);
    if (!doc) return res.status(404).json({ error: 'link_closed' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ title: doc.data.title, app: cfg.appName, bot: botName(), start: 'of_' + doc.data.token });
  });
  r.post('/:token/me', async (req, res) => {
    const c = await ctx(req, res); if (!c) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json(stateFor(c.doc, c.user, c.p));
  });
  r.post('/:token/answer', async (req, res) => {
    const c = await ctx(req, res); if (!c) return;
    const kind = req.body.kind === 'yes' ? 'yes' : req.body.kind === 'ask' ? 'ask' : '';
    const text = kind === 'ask' ? String(req.body.text == null ? '' : req.body.text).replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_ASK) : '';
    if (!kind || (kind === 'ask' && text.length < 2)) return res.status(400).json({ error: 'bad_request' });
    const next = await answer(c.doc, c.user, kind, text);
    if (!next) return res.status(404).json({ error: 'link_closed' });
    res.json(stateFor(next, c.user, c.p));
  });
  return r;
}

module.exports = { init, router, start, fromFile, list, onCallback, create, byToken, outline, tally, ID_RE };
