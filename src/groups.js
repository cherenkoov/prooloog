'use strict';
// The bot in a work chat. The owner ties the chat to a project; from then on the bot
//   - keeps what is said there in the project's correspondence (one record per chat per day),
//   - shows the members what is going on in the project, on buttons,
//   - takes their suggestions (a task, a note),
//   - can let them open the project in the app, to look only.
// Nothing here changes a project. Messages and suggestions land in `messages` with review "pending":
// the project changes after the owner has looked and confirmed, as with every client reply.
// A chat that is not tied to a project gets silence: nothing is saved, nothing is shown.
const cfg = require('./config');
const db = require('./db');
const auth = require('./auth');
const T = require('./telegram');
const hub = require('./realtime');
const clock = require('./clock');
const remind = require('./remind');
const journal = require('./journal');
const stt = require('./stt');
const game = require('./game');

let B = null; // what the bot lends: say, kb, esc, projects, pname, me()
const init = (ctx) => { B = ctx; game.init({ send, saveChat, person, esc: B.esc, kb: B.kb }); };

const PART = 7600; // characters in one part of a day's record: the dashboard's message form holds 8000
const ASK_MS = Math.max(0, +process.env.GROUP_ASK_MS || (process.env.GROUP_ASK_MS === '0' ? 0 : 2500));
const isGroup = (c) => !!c && (c.type === 'group' || c.type === 'supergroup');
const docId = (tgId) => 'g' + String(tgId).replace(/^-/, '');
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const person = (u) => auth.fullName(u || {}) || (u && u.username ? '@' + u.username : 'Без имени');
const one = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const STATUS = { idea: 'идея', active: 'в работе', paused: 'на паузе', done: 'завершён' };
const DEFAULTS = { title: '', project: '', collect: 'all', read: true, app: false, remind: false, on: true, admin: false, pub: false, n: 0 };

const sees = (ch) => !!ch.admin || !!B.me().readsAll;
// Who reads what the bot keeps from this chat, in words for the chat itself. Nobody is named: the owner
// is one of the project's coordinators to the people in the chat.
async function readers() {
  return 'видят только координаторы проекта';
}

/* ---------- the chat's record ---------- */
const chatOf = (tgId) => db.getDoc('chats', docId(tgId));
// patch: the fields to change, or a function of the current record that returns them
async function saveChat(tgId, patch) {
  const d = await db.mutateDoc('chats', docId(tgId), (cur) => Object.assign({}, DEFAULTS, { tg: String(tgId) }, cur, typeof patch === 'function' ? patch(cur) : patch, { u: nowIso() }));
  hub.publish('chats', d.id, d.data, d.version);
  return d;
}
const send = (ch, html, markup, extra) => T.tg('sendMessage', Object.assign({ chat_id: ch.tg, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup }, extra || {}));

/* ---------- what the members see ---------- */
// fresh: buttons under the greeting open a new card and leave the greeting as it is
function cardKb(ch, fresh) {
  if (!ch.read) return undefined;
  const rows = fresh ? [[{ text: 'Что по проекту', callback_data: 'gp:new' }]]
    : [[{ text: 'Задачи', callback_data: 'gp:tasks' }, { text: 'Вёрсты', callback_data: 'gp:ms' }, { text: 'События', callback_data: 'gp:ev' }]];
  const last = [{ text: 'Предложить задачу', callback_data: 'gp:sug' }];
  if (ch.app && B.me().name) last.push({ text: 'Открыть в ' + cfg.appName, callback_data: 'gp:app' });
  rows.push(last);
  return B.kb(rows);
}
const backKb = () => B.kb([[{ text: '← Проект', callback_data: 'gp:card' }]]);
const dl = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? remind.dayLabel(d) : '');

async function view(kind, ch) {
  const e = B.esc, p = (await B.projects()).find((x) => x.id === ch.project);
  if (!p) return null;
  const tz = await clock.appTz(), today = clock.parts(Date.now(), tz).d, head = '<b>' + e(B.pname(p)) + '</b>';
  const mine = (rows) => rows.filter((x) => x.data.project === p.id);
  const tasks = mine(await db.listDocs('tasks')).filter((x) => x.data.status !== 'done')
    .sort((a, b) => String(a.data.due || '9').localeCompare(String(b.data.due || '9')) || (+a.data.order || 0) - (+b.data.order || 0));
  const ms = mine(await db.listDocs('milestones')), open = ms.filter((x) => !x.data.done).sort((a, b) => String(a.data.date || '9').localeCompare(String(b.data.date || '9')));
  const evs = [];
  for (const row of mine(await db.listDocs('events'))) {
    for (let i = 0; i < 14; i++) {
      const d = new Date(Date.parse(today + 'T00:00:00Z') + i * 864e5).toISOString().slice(0, 10);
      if (remind.occurs(row.data, d)) evs.push({ d, t: /^\d{2}:\d{2}$/.test(row.data.time || '') ? row.data.time : '', title: row.data.title });
    }
  }
  evs.sort((a, b) => (a.d + (a.t || '99')).localeCompare(b.d + (b.t || '99')));

  if (kind === 'tasks') {
    const lines = tasks.slice(0, 15).map((x) => '• ' + (dl(x.data.due) ? dl(x.data.due) + (x.data.due < today ? ' (срок прошёл)' : '') + ' — ' : '') + e(one(x.data.title, 120) || 'Без названия') + (x.data.status === 'doing' ? ' <i>в работе</i>' : ''));
    return head + ' · задачи\n\n' + (lines.length ? lines.join('\n') + (tasks.length > 15 ? '\n… и ещё ' + (tasks.length - 15) : '') : 'Открытых задач нет.');
  }
  if (kind === 'ms') {
    const lines = open.slice(0, 12).map((x) => '• ' + (dl(x.data.date) ? dl(x.data.date) + ' — ' : '') + e(one(x.data.title, 120) || 'Без названия'));
    const done = ms.length - open.length;
    return head + ' · вёрсты\n\n' + (lines.length ? lines.join('\n') : 'Впереди вёрст нет.') + (done ? '\n\nПройдено: ' + done : '');
  }
  if (kind === 'ev') {
    const lines = evs.slice(0, 12).map((x) => '• ' + dl(x.d) + (x.t ? ', ' + x.t : '') + ' — ' + e(one(x.title, 120) || 'Событие'));
    return head + ' · события на две недели\n\n' + (lines.length ? lines.join('\n') + '\n\nВремя: ' + remind.offsetLabel(Date.now(), tz) : 'В ближайшие две недели событий нет.');
  }
  const doing = tasks.filter((x) => x.data.status === 'doing').length, lines = [head + ' · ' + (STATUS[p.data.status] || 'в работе')];
  if (one(p.data.next, 1)) lines.push('Следующий шаг: ' + e(one(p.data.next, 300)));
  if (open.length) lines.push('Ближайшая верста: ' + (dl(open[0].data.date) ? dl(open[0].data.date) + ' — ' : '') + e(one(open[0].data.title, 120)));
  if (evs.length) lines.push('Ближайшее событие: ' + dl(evs[0].d) + (evs[0].t ? ', ' + evs[0].t : '') + ' — ' + e(one(evs[0].title, 120)));
  lines.push(tasks.length ? 'Задач в работе: ' + doing + ', в очереди: ' + (tasks.length - doing) : 'Открытых задач нет.');
  return lines.join('\n');
}

async function aboutText(ch, p) {
  const e = B.esc, lines = ['Привет! Я бот ' + e(cfg.appName) + ' и помогаю вести проект <b>' + e(B.pname(p)) + '</b>.'];
  const rd = await readers(ch);
  if (ch.collect === 'all') lines.push(sees(ch) ? '• Сохраняю сообщения этого чата в переписку проекта. Их ' + rd + '.'
    : '• Сохраняю в переписку проекта то, что адресовано мне: команды и ответы на мои сообщения. Это ' + rd + '.');
  else if (ch.collect === 'ask') lines.push('• Сохраняю в переписку проекта только то, что адресовано мне: ответы на мои сообщения' + (sees(ch) ? ' и упоминания' : '') + '. Это ' + rd + '.');
  else lines.push('• Переписку этого чата не сохраняю.');
  if (ch.read) lines.push('• /project — что сейчас по проекту: задачи, вёрсты, события.');
  lines.push('• /task текст — предложить задачу, /note текст — оставить заметку. В проект они попадут, когда их подтвердит координатор.');
  if (game.isOn(p.data)) lines.push('• Игра: карточку игрока из Quest Board сохраняю как квесты недели, сообщение в Daily Log считаю отчётом дня и сам считаю XP. Квест завершает сам игрок кнопкой под карточкой; квесты и отчёты никто не подтверждает. /game — команда недели.');
  return lines.join('\n');
}
async function announce(doc) {
  const ch = doc.data, p = (await B.projects()).find((x) => x.id === ch.project);
  if (!p) return;
  await send(ch, await aboutText(ch, p), cardKb(ch, true)).catch((err) => console.error('[groups] greeting not sent:', err.message));
}

/* ---------- tying a chat to a project ---------- */
async function askOwner(doc, from) {
  const owner = await auth.ownerId();
  if (!owner) return;
  const rows = [];
  (await B.projects()).filter((p) => Buffer.byteLength('gl:' + doc.id + ':' + p.id) <= 64).slice(0, 12).forEach((p, i) => {
    const b = { text: B.pname(p).slice(0, 30), callback_data: 'gl:' + doc.id + ':' + p.id };
    if (i % 2) rows[rows.length - 1].push(b); else rows.push([b]);
  });
  rows.push([{ text: 'Не привязывать, выйти из чата', callback_data: 'gl:' + doc.id + ':-' }]);
  const who = from && String(from.id) !== String(owner) ? ' (добавил ' + B.esc(person(from)) + ')' : '';
  await B.say(owner, 'Меня добавили в чат <b>' + B.esc(doc.data.title || 'без названия') + '</b>' + who + '.\nК какому проекту его привязать? Пока проект не выбран, я в этом чате молчу и ничего не сохраняю.', B.kb(rows))
    .catch((err) => console.error('[groups] the owner was not asked:', err.message));
}
async function hintOwner(doc, asked) {
  const owner = await auth.ownerId(), ch = doc.data;
  if (!owner || ch.collect !== 'all' || sees(ch)) return;
  await B.say(owner, 'В чате <b>' + B.esc(ch.title || 'без названия') + '</b> я сейчас вижу только команды и ответы на мои сообщения: так Telegram защищает переписку в группах.\nЧтобы я собирал все сообщения, сделай меня администратором этого чата (права можно не давать).' +
    (asked ? '\nЕсли ты сам там не администратор: я попросил об этом в чате и приложил шаги. Повторить просьбу: команда /admin в чате.' : '')).catch(() => {});
}

/* ---------- the administrator's rights ---------- */
// Without them Telegram hands the bot only commands and replies to its own messages, so a chat it should
// collect from stays almost empty. The bot looks at its own rights and asks the chat, with the steps:
// when the chat is tied to a project, when it comes back after a restart, and again a few days later
// when somebody talks to it. Three requests at most, unless the owner asks for another one with /admin.
const ADMIN_GAP_MS = 3 * 864e5, ADMIN_ASKS = 3;
// what Telegram says right now: true, false, or null when it does not answer
async function adminNow(ch) {
  const me = B.me();
  if (!me.id) return null;
  try {
    const cm = await T.tg('getChatMember', { chat_id: ch.tg, user_id: me.id });
    return cm ? cm.status === 'administrator' || cm.status === 'creator' : null;
  } catch (e) { return null; }
}
// the people who can name an administrator: the creator and the administrators with that right
async function promoters(ch) {
  let list = [];
  try { const r = await T.tg('getChatAdministrators', { chat_id: ch.tg }); if (Array.isArray(r)) list = r; } catch (e) { /* the request goes without names */ }
  const e = B.esc;
  return list.filter((x) => x && x.user && !x.user.is_bot && (x.status === 'creator' || x.can_promote_members))
    .sort((a, b) => (a.status === 'creator' ? 0 : 1) - (b.status === 'creator' ? 0 : 1)).slice(0, 3)
    .map((x) => (x.user.username ? '@' + e(x.user.username) : '<a href="tg://user?id=' + (+x.user.id || 0) + '">' + e(person(x.user)) + '</a>'));
}
async function adminText(ch) {
  const e = B.esc, me = B.me(), p = (await B.projects()).find((x) => x.id === ch.project), who = await promoters(ch);
  return '🔑 <b>Мне нужны права администратора в этом чате</b>\n' +
    'Сейчас Telegram показывает мне только команды и ответы на мои сообщения. Переписка и голосовые в проект «' + e(p ? B.pname(p) : '') + '» не попадают, и ленту проекта собрать не из чего.\n\n' +
    'Выдать права может создатель чата или администратор' + (who.length ? ': ' + who.join(', ') : '') + '.\n' +
    '1. Нажмите на название чата вверху.\n' +
    '2. «Изменить» (значок карандаша) → «Администраторы» → «Добавить администратора».\n' +
    '3. Выберите ' + (me.name ? '@' + e(me.name) : 'меня') + ' в списке.\n' +
    '4. Все переключатели прав можно выключить: мне нужен только сам статус.\n' +
    '5. Нажмите «Готово».\n\n' +
    'После этого я сохраняю сообщения чата в переписку проекта: их ' + (await readers(ch)) + '. В самом чате я ничего не удаляю и не меняю.';
}
// force: the owner asked for it, the limits do not apply.
// Returns 'skip' (the chat does not need it), 'admin', 'unknown', 'asked' (recently, or often enough) or 'sent'.
async function askAdmin(doc, force, thread) {
  const ch = doc.data;
  if (!ch.project || ch.on === false || ch.collect !== 'all' || B.me().readsAll) return 'skip';
  const a = ch.adminAsk || {};
  if (!force && ((+a.n || 0) >= ADMIN_ASKS || Date.now() - (Date.parse(a.at || '') || 0) < ADMIN_GAP_MS)) return ch.admin ? 'admin' : 'asked';
  const now = await adminNow(ch);
  if (now === null) return 'unknown';
  if (now !== !!ch.admin) await saveChat(ch.tg, { admin: now }); // a change of rights that never reached the bot
  if (now) return 'admin';
  try { await send(ch, await adminText(ch), B.kb([[{ text: 'Проверить права', callback_data: 'gp:adm' }]]), thread); }
  catch (err) { console.error('[groups] the request for rights was not sent:', err.message); return 'unknown'; }
  await saveChat(ch.tg, (cur) => ({ adminAsk: { at: nowIso(), n: ((cur.adminAsk && +cur.adminAsk.n) || 0) + 1 }, last: nowIso() }));
  return 'sent';
}
// After a restart: every chat the bot should collect from hears the request once, if it never did.
async function sweep() {
  for (const doc of await db.listDocs('chats')) {
    if (doc.data.adminAsk) continue;
    try { await askAdmin(doc); } catch (e) { console.error('[groups] rights not checked:', e.message); }
  }
}
async function link(tgId, projectId) {
  const p = (await B.projects()).find((x) => x.id === projectId);
  if (!p) return null;
  const before = await chatOf(tgId);
  const doc = await saveChat(tgId, { project: projectId, on: true });
  journal.note(before ? 'upd' : 'add', 'chats', doc.id, doc.data, before && before.data, '');
  await announce(doc);
  await hintOwner(doc, (await askAdmin(doc)) === 'sent');
  return { doc, project: p };
}

// The bot was added to a chat, removed from it, or its rights there changed.
async function onMember(u) {
  const c = u.chat, st = u.new_chat_member && u.new_chat_member.status;
  if (!isGroup(c) || !st) return;
  const inside = st === 'member' || st === 'administrator' || st === 'creator' || (st === 'restricted' && u.new_chat_member.is_member !== false);
  const was = await chatOf(c.id);
  if (!inside) {
    if (was) { await saveChat(c.id, { on: false, admin: false }); if (was.data.on !== false) journal.event('bulk', 'Бот удалён из чата «' + one(was.data.title, 80) + '»'); }
    return;
  }
  const fresh = !was || was.data.on === false, admin = st === 'administrator' || st === 'creator';
  if (fresh) journal.event('bulk', 'Бот добавлен в чат «' + one(c.title, 80) + '»', person(u.from));
  const doc = await saveChat(c.id, {
    on: true, admin, title: one(c.title, 120), kind: c.type, pub: !!c.username,
    by: was && was.data.by ? was.data.by : { id: String((u.from && u.from.id) || ''), name: person(u.from) },
  });
  if (fresh) {
    // the «add to a chat» link from the dashboard names the project right away: give that message a moment to arrive
    if (ASK_MS) await sleep(ASK_MS);
    const cur = await chatOf(c.id);
    if (!cur || cur.data.on === false) return;
    if (!cur.data.project) return askOwner(cur, u.from);
    if (was && was.data.project) return announce(cur); // back in a chat it already knew
    return;
  }
  // it became an administrator of a chat it collects from: now it sees everything, and says so
  if (admin && !was.data.admin && !B.me().readsAll && doc.data.project && doc.data.collect === 'all') {
    await send(doc.data, 'Теперь я вижу все сообщения этого чата и сохраняю их в переписку проекта. Их ' + (await readers(doc.data)) + '.').catch(() => {});
  }
}
async function migrate(fromId, toId) {
  const old = await chatOf(fromId);
  if (!old) return;
  const data = Object.assign({}, old.data, { tg: String(toId), kind: 'supergroup', u: nowIso() });
  const d = await db.setDoc('chats', docId(toId), data);
  await db.deleteDoc('chats', old.id);
  hub.publish('chats', old.id, null, 0);
  hub.publish('chats', d.id, d.data, d.version);
}

/* ---------- keeping what is said ---------- */
function bodyOf(m) {
  const t = one(m.text || m.caption, 3500), tag = [];
  const mmss = (s) => Math.floor((+s || 0) / 60) + ':' + String((+s || 0) % 60).padStart(2, '0');
  if (m.voice) tag.push('[голосовое ' + mmss(m.voice.duration) + ']');
  else if (m.video_note) tag.push('[видеосообщение ' + mmss(m.video_note.duration) + ']');
  else if (m.audio) tag.push('[аудио' + (m.audio.file_name ? ' ' + one(m.audio.file_name, 60) : '') + ']');
  else if (m.photo) tag.push('[фото]');
  else if (m.video) tag.push('[видео]');
  else if (m.document) tag.push('[файл' + (m.document.file_name ? ' ' + one(m.document.file_name, 60) : '') + ']');
  else if (m.poll) tag.push('[опрос: ' + one(m.poll.question, 120) + ']');
  else if (m.location) tag.push('[геопозиция]');
  else if (m.sticker && m.sticker.emoji) tag.push('[стикер ' + m.sticker.emoji + ']');
  if (!t && !tag.length) return '';
  const to = m.reply_to_message && m.reply_to_message.from && !m.reply_to_message.from.is_bot ? '↪ ' + one(person(m.reply_to_message.from), 40) + ': ' : '';
  const src = originOf(m);
  return (m.forward_origin ? '[переслано' + (src ? ' от ' + src : '') + '] ' : '') + to + tag.concat(t ? [t] : []).join(' ');
}
// One record per chat per day. A part that the owner has already reviewed, or that is full, is left alone:
// what comes later starts the next part, so nothing reviewed changes and nothing new slips past the review.
// the author of a forwarded message, when Telegram names them
function originOf(m) {
  const o = m.forward_origin;
  if (!o) return '';
  if (o.type === 'user' && o.sender_user) return person(o.sender_user);
  if (o.type === 'hidden_user') return one(o.sender_user_name, 80);
  if (o.type === 'chat' && o.sender_chat) return one(o.sender_chat.title, 80);
  if (o.type === 'channel' && o.chat) return one(o.chat.title, 80);
  return '';
}
async function collect(m, doc) {
  const body = bodyOf(m);
  if (!body) return null;
  const ch = doc.data, tz = await clock.appTz(), p = clock.parts(m.date * 1000, tz), who = person(m.from);
  const line = '[' + p.t + '] ' + who + ': ' + body;
  const base = 'gc' + doc.id.slice(1) + '-' + p.d.replace(/-/g, '');
  let part = ch.cur && ch.cur.d === p.d ? Math.max(1, +ch.cur.part || 1) : 1, saved = null;
  for (let i = 0; i < 30 && !saved; i++, part++) {
    const id = base + (part > 1 ? '-' + part : '');
    let full = false, born = false;
    const d = await db.mutateDoc('messages', id, (cur) => {
      const fresh = !cur.src;
      born = fresh;
      if (!fresh && (cur.review !== 'pending' || cur.project !== ch.project || String(cur.text || '').length + line.length > PART)) { full = true; return cur; }
      const people = Array.isArray(cur.people) ? cur.people.slice() : [];
      if (!people.includes(who) && people.length < 30) people.push(who);
      const next = Object.assign({ project: ch.project, contact: '', summary: '', date: p.d, channel: 'tg', review: 'pending', proposal: null, applied: [], src: 'chat', chat: doc.id }, cur, {
        from: 'Чат «' + one(ch.title || 'без названия', 50) + '»' + (part > 1 ? ', часть ' + part : ''),
        text: (cur.text ? cur.text + '\n' : '') + line, count: (+cur.count || 0) + 1, people, u: nowIso(),
      });
      return next;
    });
    if (!full) {
      saved = d; hub.publish('messages', d.id, d.data, d.version);
      // the journal gets one line when a day's record begins, not one per message
      if (born) journal.note('add', 'messages', d.id, Object.assign({}, d.data, { text: '', summary: '' }), null, 'чат «' + one(ch.title, 50) + '»');
    }
  }
  if (saved) await saveChat(ch.tg, (cur) => ({ cur: { d: p.d, part: part - 1 }, n: (+cur.n || 0) + 1, last: nowIso() }));
  // Audio cannot live inside a text record: it gets a record of its own, with the player the dashboard already has.
  const au = m.voice || m.audio;
  if (saved && au && au.file_id) {
    const v = await db.setDoc('messages', 'gv' + doc.id.slice(1) + '-' + m.message_id, {
      project: ch.project, contact: await contactOf(m.from), from: who + (originOf(m) ? ' (переслано от ' + originOf(m) + ')' : ''), text: one(m.caption, 3500), summary: '', date: p.d, time: p.t, channel: 'tg', review: 'pending', proposal: null, applied: [],
      file: { kind: 'audio', tg: au.file_id, name: m.voice ? 'Голосовое ' + p.d + ' ' + p.t.replace(':', '-') + '.ogg' : one(au.file_name || au.title || 'Аудио', 80), dur: +au.duration || 0 },
      src: 'chat', chat: doc.id, u: nowIso(),
    });
    hub.publish('messages', v.id, v.data, v.version);
    journal.note('add', 'messages', v.id, Object.assign({}, v.data, { text: v.data.text || v.data.file.name }), null, 'чат «' + one(ch.title, 50) + '»: ' + who);
    stt.later(v.id); // the words of the voice message, when a speech-to-text key is set
  }
  return saved;
}

/* ---------- suggestions from the members ---------- */
async function contactOf(u) {
  const uname = String((u && u.username) || '').toLowerCase();
  if (!uname) return '';
  const c = (await db.listDocs('contacts')).find((x) => String(x.data.tg || '').replace(/^@/, '').toLowerCase() === uname);
  return c ? c.id : '';
}
async function suggest(m, doc, kind, body) {
  const ch = doc.data, tz = await clock.appTz(), at = nowIso(), text = String(body || '').trim().slice(0, 4000);
  if (!text) return;
  const item = kind === 'task' ? { t: 'task', title: one(text, 200), due: '' } : { t: 'cm', text: text.slice(0, 2000), tag: 'insight' };
  const id = 'gs' + doc.id.slice(1) + '-' + m.message_id;
  const d = await db.setDoc('messages', id, {
    project: ch.project, contact: await contactOf(m.from), from: person(m.from) + (m.from.username ? ' (@' + m.from.username + ')' : ''), text, summary: '',
    date: clock.parts(m.date * 1000, tz).d, channel: 'tg', review: 'pending', proposal: { items: [item], by: 'bot', at }, applied: [], src: 'chat', chat: doc.id, u: at,
  });
  hub.publish('messages', d.id, d.data, d.version);
  journal.note('add', 'messages', d.id, Object.assign({}, d.data, { from: '' }), null, 'чат «' + one(ch.title, 50) + '»: ' + person(m.from));
  await saveChat(ch.tg, { last: at });
  await send(ch, (kind === 'task' ? 'Записал задачу.' : 'Записал заметку.') + ' В проекте она появится, когда её подтвердит координатор.',
    undefined, { reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } }).catch(() => {});
}
// «Напиши ответом»: the answer reaches the bot even when Telegram hides the rest of the chat from it
async function prompt(ch, kind, user, replyTo, thread) {
  const p = (await B.projects()).find((x) => x.id === ch.project), e = B.esc;
  const who = user ? (user.username ? '@' + e(user.username) : '<a href="tg://user?id=' + (+user.id || 0) + '">' + e(person(user)) + '</a>') + ', ' : '';
  const html = (kind === 'task' ? '✍️ Задача' : '✍️ Заметка') + ' для проекта «' + e(p ? B.pname(p) : '') + '».\n' + who + 'напиши её ответом на это сообщение.';
  const extra = replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : Object.assign({}, thread);
  const force = { force_reply: true, selective: true, input_field_placeholder: kind === 'task' ? 'Что нужно сделать' : 'Что важно запомнить' };
  // the reply field opens by itself where Telegram allows it; the plain message works everywhere
  return send(ch, html, force, extra).catch(() => send(ch, html, undefined, extra)).catch(() => {});
}

/* ---------- a message in a chat ---------- */
async function onMessage(m) {
  const c = m.chat;
  if (!isGroup(c)) return;
  if (m.migrate_to_chat_id) return migrate(c.id, m.migrate_to_chat_id);
  if (m.migrate_from_chat_id || m.group_chat_created || m.supergroup_chat_created) return;
  const me = B.me();
  if (m.left_chat_member) { if (me.id && m.left_chat_member.id === me.id && (await chatOf(c.id))) await saveChat(c.id, { on: false, admin: false }); return; }
  if (m.new_chat_title) { if (await chatOf(c.id)) await saveChat(c.id, { title: one(m.new_chat_title, 120) }); return; }
  if (m.new_chat_members || !m.from || m.from.is_bot) return;

  const text = String(m.text || m.caption || '').trim();
  const cmd = /^\/([a-z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i.exec(text);
  if (cmd && cmd[2] && me.name && cmd[2].toLowerCase() !== me.name.toLowerCase()) return; // a command for another bot
  const isOwner = String(await auth.ownerId()) === String(m.from.id);
  const name = cmd ? cmd[1].toLowerCase() : '', arg = cmd ? (cmd[3] || '').trim() : '';

  // the owner came by the «add to a chat» link of a project, or ties the chat by hand
  const pm = name === 'start' ? /^p_([A-Za-z0-9_-]{1,60})$/.exec(arg) : null;
  if (pm && isOwner) {
    if (!(await chatOf(c.id))) await saveChat(c.id, { title: one(c.title, 120), kind: c.type, pub: !!c.username, by: { id: String(m.from.id), name: person(m.from) } });
    const r = await link(c.id, pm[1]);
    if (!r) await B.say(m.from.id, 'Проекта из ссылки уже нет. Привяжи чат к другому: напиши в нём /link.').catch(() => {});
    return;
  }
  let doc = await chatOf(c.id);
  if (name === 'link' && isOwner) {
    if (!doc) doc = await saveChat(c.id, { title: one(c.title, 120), kind: c.type, pub: !!c.username, by: { id: String(m.from.id), name: person(m.from) } });
    return askOwner(doc, m.from);
  }
  if (!doc || !doc.data.project || doc.data.on === false) return; // not tied to a project: silence
  if (!(await db.getDoc('projects', doc.data.project))) { await saveChat(c.id, { project: '' }); return; } // the project was deleted
  if (c.title && c.title !== doc.data.title) doc = await saveChat(c.id, { title: one(c.title, 120), pub: !!c.username });
  const ch = doc.data, rt = m.reply_to_message, toMe = !!(rt && rt.from && me.id && rt.from.id === me.id);
  const thread = m.is_topic_message && m.message_thread_id ? { message_thread_id: m.message_thread_id } : {};
  doc = await topicSeen(m, doc);
  try { return await heard(m, doc, { cmd, name, arg, text, isOwner, toMe, thread }); }
  // whatever reached the bot is a moment to ask for the rights again, when it is time (askAdmin keeps the limits)
  finally { if (!ch.admin && name !== 'admin' && name !== 'unlink') await askAdmin(doc, false, thread).catch(() => {}); }
}
// The names of the chat's topics, as Telegram tells them: when a topic is made or renamed, and with every
// message inside a topic (it carries the service message that opened the topic).
async function topicSeen(m, doc) {
  const id = m.message_thread_id ? String(m.message_thread_id) : '', rt = m.reply_to_message;
  const name = one((m.forum_topic_created && m.forum_topic_created.name) || (m.forum_topic_edited && m.forum_topic_edited.name) || (rt && rt.forum_topic_created && rt.forum_topic_created.name), 80);
  const known = doc.data.topics && doc.data.topics[id];
  // a quoted opening message keeps the first name of the topic: it only fills a gap
  if (!id || !name || known === name || (known && !m.forum_topic_created && !m.forum_topic_edited)) return doc;
  return saveChat(m.chat.id, (cur) => { const t = Object.assign({}, cur.topics); if (Object.keys(t).length < 60 || t[id]) t[id] = name; return { topics: t }; });
}
// A message was edited: a game follows the player's card and report, nothing else is read again.
async function onEdited(m) {
  if (!isGroup(m.chat) || !m.from || m.from.is_bot) return;
  const doc = await chatOf(m.chat.id);
  if (!doc || !doc.data.project || doc.data.on === false) return;
  const thread = m.is_topic_message && m.message_thread_id ? { message_thread_id: m.message_thread_id } : {};
  await game.onMessage(m, doc, thread, true);
}
async function heard(m, doc, { cmd, name, arg, text, isOwner, toMe, thread }) {
  const c = m.chat, ch = doc.data, me = B.me(), rt = m.reply_to_message;

  if (cmd) {
    if (name === 'unlink' && isOwner) { const off = await saveChat(c.id, { project: '' }); journal.note('upd', 'chats', off.id, off.data, ch, ''); return send(ch, 'Отвязал чат от проекта. Больше ничего здесь не сохраняю.', undefined, thread).catch(() => {}); }
    if (name === 'admin' && isOwner) {
      const r = await askAdmin(doc, true, thread);
      const html = r === 'admin' ? 'Права администратора у меня есть: я вижу все сообщения этого чата.'
        : r === 'skip' ? (me.readsAll ? 'Я и так вижу все сообщения этого чата.' : 'Этот чат настроен так, что я не сохраняю всю переписку: права администратора мне здесь не нужны.')
          : r === 'unknown' ? 'Telegram сейчас не отвечает, проверить права не получилось. Попробуй чуть позже.' : '';
      return html ? send(ch, html, undefined, thread).catch(() => {}) : undefined;
    }
    if (name === 'task' || name === 'note') {
      const quoted = rt && !toMe ? one(rt.text || rt.caption, 3500) : '';
      if (arg) return suggest(m, doc, name, arg + (quoted ? '\n\n' + person(rt.from) + ': ' + quoted : ''));
      if (quoted) return suggest(m, doc, name, (name === 'task' ? quoted : person(rt.from) + ': ' + quoted));
      return prompt(ch, name, m.from, m.message_id);
    }
    if (name === 'game' || name === 'xp') return game.sayTable(ch, thread);
    if (name === 'project' || name === 'status' || name === 'start' || name === 'help') {
      if (!ch.read) return send(ch, 'Здесь я веду записи по проекту для его координаторов. Предложить задачу: /task текст.', undefined, thread).catch(() => {});
      const html = name === 'help' ? await aboutText(ch, (await B.projects()).find((x) => x.id === ch.project) || { data: {} }) : await view('card', ch);
      if (html) return send(ch, html, cardKb(ch, name === 'help'), thread).catch((err) => console.error('[groups] card not sent:', err.message));
    }
    return; // other commands are not for here
  }
  // an answer to «напиши ответом на это сообщение»
  if (toMe && text) {
    const kind = /^✍️ Задача/.test(rt.text || '') ? 'task' : /^✍️ Заметка/.test(rt.text || '') ? 'note' : '';
    if (kind) return suggest(m, doc, kind, text);
  }
  const called = !!me.name && new RegExp('@' + me.name + '(?![A-Za-z0-9_])', 'i').test(text);
  if (ch.collect === 'all' || (ch.collect === 'ask' && (toMe || called))) await collect(m, doc);
  await game.onMessage(m, doc, thread).catch((err) => console.error('[game]', err.message));
  // the bot's name alone is a question: what is going on?
  if (called && ch.read && !text.replace(new RegExp('@' + me.name, 'ig'), '').trim()) {
    const html = await view('card', ch);
    if (html) await send(ch, html, cardKb(ch), thread).catch(() => {});
  }
}

/* ---------- buttons ---------- */
// A member of the chat opens the project in the app: to look only, and only this project.
async function openApp(cq, doc, ack) {
  const ch = doc.data, uid = String(cq.from.id), owner = String(await auth.ownerId()), me = B.me();
  const url = 'https://t.me/' + me.name + '?start=open';
  const go = () => T.tg('answerCallbackQuery', { callback_query_id: cq.id, url }).catch(() => ack('Открой @' + me.name + ' и нажми «Старт»: проект уже доступен.', true));
  if (uid === owner) return go();
  if (!ch.app || !me.name) return ack('Проект в приложении для этого чата не открыт.', true);
  let inside = null;
  try {
    const cm = await T.tg('getChatMember', { chat_id: ch.tg, user_id: cq.from.id });
    inside = !(cm.status === 'left' || cm.status === 'kicked' || (cm.status === 'restricted' && cm.is_member === false));
  } catch (e) { inside = null; }
  // Telegram answers for certain only to an administrator; in a closed chat the button itself is seen by members only
  if (inside === false || (inside === null && ch.pub)) return ack('Проект открывается только участникам этого чата.', true);
  const cur = await db.getMember(uid);
  if (cur && auth.memberRole(cur.role, cur.projects) === 'manager' && !cur.projects.includes(ch.project)) return ack('Этот проект координатору открывают в окне «Доступ», сам он этого сделать не может.', true);
  const role = cur && cur.role === 'editor' ? 'editor' : 'viewer';
  const list = !cur ? [ch.project] : Array.isArray(cur.projects) ? [...new Set(cur.projects.concat([ch.project]))] : null;
  if (!cur || (Array.isArray(cur.projects) && !cur.projects.includes(ch.project))) {
    await db.upsertMember(uid, cq.from.username || '', auth.fullName(cq.from), role);
    await db.setMemberAccess(uid, role, list);
    hub.setAccess(uid, role, list);
    const p = (await B.projects()).find((x) => x.id === ch.project);
    journal.event('acc', 'Доступ «смотреть» к проекту «' + (p ? B.pname(p) : '') + '» из чата «' + one(ch.title, 50) + '»: ' + person(cq.from) + (cq.from.username ? ' (@' + cq.from.username + ')' : ''));
    if (owner) await B.say(owner, B.esc(person(cq.from)) + (cq.from.username ? ' (@' + B.esc(cq.from.username) + ')' : '') + ': доступ «смотреть» к проекту <b>' + B.esc(p ? B.pname(p) : '') + '</b> из чата «' + B.esc(ch.title || '') + '». Закрыть его можно в окне «Доступ».').catch(() => {});
  }
  return go();
}
// gl:<chat>:<project> — the owner picks a project for a chat (in the private chat with the bot)
// gp:<what>          — a member presses a button under the bot's message in the chat
async function onCallback(cq) {
  const data = String(cq.data || ''), msg = cq.message, chat = msg && msg.chat;
  const ack = (text, alert) => T.tg('answerCallbackQuery', { callback_query_id: cq.id, text: text || undefined, show_alert: !!alert }).catch(() => {});
  const gl = /^gl:(g\d{1,20}):([A-Za-z0-9_-]{1,60})$/.exec(data);
  if (gl) {
    if (String(await auth.ownerId()) !== String(cq.from.id)) return ack('Привязка чата к проекту тебе не открыта');
    const doc = await db.getDoc('chats', gl[1]);
    const edit = (html) => T.tg('editMessageText', { chat_id: chat.id, message_id: msg.message_id, text: html, parse_mode: 'HTML' }).catch(() => B.say(chat.id, html));
    if (!doc) { await ack(); return edit('Этого чата у меня уже нет.'); }
    if (gl[2] === '-') {
      await T.tg('leaveChat', { chat_id: doc.data.tg }).catch(() => {});
      await saveChat(doc.data.tg, { on: false, admin: false, project: '' });
      await ack('Вышел');
      return edit('Вышел из чата «' + B.esc(doc.data.title || '') + '». Ничего не сохранял.');
    }
    const r = await link(doc.data.tg, gl[2]);
    await ack(r ? 'Привязал' : 'Проекта уже нет');
    return edit(r ? 'Чат «' + B.esc(doc.data.title || '') + '» привязан к проекту <b>' + B.esc(B.pname(r.project)) + '</b>. Я поздоровался там и рассказал, что делаю.\nНастройки чата: в дэшборде, на странице проекта, блок «Чаты».' : 'Этого проекта уже нет. Напиши в чате /link, чтобы выбрать другой.');
  }
  if (/^g[qz]:/.test(data)) {
    const gd = isGroup(chat) ? await chatOf(chat.id) : null;
    if (!gd || !gd.data.project || gd.data.on === false) return ack('Чат не привязан к проекту');
    return game.onCallback(cq, gd, ack);
  }
  const gp = /^gp:(card|new|tasks|ms|ev|sug|app|adm)$/.exec(data);
  if (!gp || !isGroup(chat)) return ack();
  const doc = await chatOf(chat.id);
  if (!doc || !doc.data.project || doc.data.on === false) return ack('Чат не привязан к проекту');
  const ch = doc.data, thread = msg.is_topic_message && msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {};
  if (gp[1] === 'app') return openApp(cq, doc, ack);
  if (gp[1] === 'sug') { await ack(); return prompt(ch, 'task', cq.from, 0, thread); }
  if (gp[1] === 'adm') {
    const now = await adminNow(ch);
    if (now === null) return ack('Telegram сейчас не отвечает. Попробуйте чуть позже.', true);
    if (!now) return ack('Прав администратора пока нет. Шаги в сообщении выше.', true);
    await ack('Права есть, спасибо!');
    if (!ch.admin) {
      // the same words the bot says when Telegram itself reports the change
      const d = await saveChat(ch.tg, { admin: true });
      if (!B.me().readsAll && d.data.collect === 'all') await send(d.data, 'Теперь я вижу все сообщения этого чата и сохраняю их в переписку проекта. Их ' + (await readers(d.data)) + '.', undefined, thread).catch(() => {});
    }
    return;
  }
  if (!ch.read) return ack('Проект для этого чата не открыт: это включают те, кто ведёт проект', true);
  const kind = gp[1] === 'new' ? 'card' : gp[1], html = await view(kind, ch);
  if (!html) return ack('Проекта уже нет');
  await ack();
  const markup = kind === 'card' ? cardKb(ch) : backKb();
  if (gp[1] === 'new') return send(ch, html, markup, thread).catch(() => {});
  return T.tg('editMessageText', { chat_id: chat.id, message_id: msg.message_id, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup }).catch(() => {});
}

/* ---------- from the dashboard ---------- */
const fail = (code) => Object.assign(new Error(code), { code });
// The owner changed a chat's record in the dashboard. When the chat gets a project, or the bot starts to keep more
// than before, the chat hears what the bot does there now: nobody is recorded without being told.
const WIDE = { off: 0, ask: 1, all: 2 };
async function onSettings(prev, doc) {
  const a = prev || {}, b = (doc && doc.data) || {}, wide = (x) => (WIDE[x.collect] === undefined ? 2 : WIDE[x.collect]);
  if (b.on === false || !b.project) return;
  if (a.project !== b.project) { await announce(doc); await hintOwner(doc, (await askAdmin(doc)) === 'sent'); }
  else if (wide(b) > wide(a)) { await announce(doc); await askAdmin(doc); }
}
async function post(id, text, withButtons) {
  const doc = await db.getDoc('chats', String(id));
  if (!doc || doc.data.on === false) throw fail('no_chat');
  const body = String(text || '').trim().slice(0, 3800);
  if (!body) throw fail('bad_request');
  await send(doc.data, B.esc(body), withButtons && doc.data.project ? cardKb(doc.data, true) : undefined);
  await saveChat(doc.data.tg, { last: nowIso() });
  return true;
}
async function leave(id) {
  const doc = await db.getDoc('chats', String(id));
  if (!doc) throw fail('no_chat');
  await T.tg('leaveChat', { chat_id: doc.data.tg }).catch(() => {});
  await saveChat(doc.data.tg, { on: false, admin: false });
  return true;
}

module.exports = { init, isGroup, onMessage, onEdited, onCallback, onMember, onSettings, post, leave, view, docId, sweep, askAdmin };
