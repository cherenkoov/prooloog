'use strict';
// The Telegram bot: opens the dashboard, signs people in, saves client replies for review, keeps backups.
const cfg = require('./config');
const db = require('./db');
const auth = require('./auth');
const hub = require('./realtime');
const T = require('./telegram');
const clock = require('./clock');
const ai = require('./ai');
const mcp = require('./mcp');
const usage = require('./usage');
const remind = require('./remind');

let botName = '';

const https = () => /^https:\/\//.test(cfg.baseUrl);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const now = () => Math.floor(Date.now() / 1000);
const day = (unix, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || cfg.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date((unix || now()) * 1000));
const appTz = clock.appTz;
const kb = (rows) => ({ inline_keyboard: rows });
const openBtn = (text, path) => (https() ? [{ text, web_app: { url: cfg.baseUrl + (path || '/') } }] : null);
const say = (chat, html, markup) => T.tg('sendMessage', { chat_id: chat, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup });
const UNSUPPORTED = 'Пока понимаю текст, пересланные сообщения, голосовые, аудио и файлы .txt.';

/* ---------- projects ---------- */
const pname = (p) => String((p && p.data && p.data.name) || 'Без названия');
async function projects() {
  const rank = { active: 0, idea: 1, paused: 2, done: 3 };
  const r = (p) => (rank[p.data.status] === undefined ? 1 : rank[p.data.status]);
  return (await db.listDocs('projects')).sort((a, b) => r(a) - r(b) || (+a.data.order || 0) - (+b.data.order || 0));
}
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim();
const stem = (w) => w.slice(0, Math.max(4, w.length - 2));
function tokensOf(p) { return (norm(pname(p)) + ' ' + norm(p.id.replace(/^p-/, ''))).split(' ').filter(Boolean); }
const hit = (t, toks) => toks.some((w) => w === t || (t.length >= 3 && w.startsWith(stem(t))) || (w.length >= 4 && t.startsWith(stem(w))));
// Finds the project a few words point at: «индия» -> «Кастинги в Индии». strict: every word must fit.
function matchProject(query, list, strict) {
  const qn = norm(query);
  if (!qn) return { best: null, cands: [] };
  const qt = qn.split(' ').filter((t) => t.length >= 2);
  const scored = [];
  for (const p of list) {
    const toks = tokensOf(p), name = norm(pname(p));
    let s = 0;
    if (name === qn) s += 20;
    else if (name.includes(qn)) s += 8;
    const hits = qt.filter((t) => hit(t, toks)).length;
    s += hits * 2;
    if (strict && hits < qt.length && name !== qn) continue;
    if (s > 0) scored.push({ p, s });
  }
  scored.sort((a, b) => b.s - a.s);
  const best = scored.length && (scored.length === 1 || scored[0].s > scored[1].s) ? scored[0].p : null;
  return { best, cands: scored.map((x) => x.p) };
}
function projectKb(list, cands) {
  const seen = new Set(), order = [];
  for (const p of (cands || []).concat(list)) { if (!seen.has(p.id)) { seen.add(p.id); order.push(p); } }
  const rows = [];
  order.filter((p) => Buffer.byteLength('p:' + p.id) <= 64).slice(0, 12).forEach((p, i) => {
    const b = { text: pname(p).slice(0, 30), callback_data: 'p:' + p.id };
    if (i % 2) rows[rows.length - 1].push(b); else rows.push([b]);
  });
  rows.push([{ text: 'Отмена', callback_data: 'x' }]);
  return kb(rows);
}

/* ---------- reading a message ---------- */
// «от Ravi, индия: текст» or «Ravi, индия» on the first line. Without «от» the second part must be a project.
function parseHeader(text, list) {
  const t = String(text || '');
  const nl = t.indexOf('\n');
  const first = (nl < 0 ? t : t.slice(0, nl)).trim(), rest = nl < 0 ? '' : t.slice(nl + 1);
  let m = /^от\s+(.{1,60}?)\s*,\s*([^:]{2,60}?)\s*(?::\s*(.*))?$/i.exec(first);
  const explicit = !!m;
  if (!m && first.length <= 90) m = /^(@?[^\s,:][^,:]{0,40}?)\s*,\s*([^:]{2,60}?)\s*(?::\s*(.*))?$/.exec(first);
  if (!m) return null;
  const mp = matchProject(m[2], list, !explicit);
  if (!explicit && !mp.best) return null;
  return {
    from: m[1].trim().slice(0, 60), projectQuery: m[2].trim(), project: mp.best ? mp.best.id : '', cands: mp.cands,
    body: [(m[3] || '').trim(), rest.trim()].filter(Boolean).join('\n'),
  };
}
function draftFrom(m, tz) {
  const o = m.forward_origin;
  const d = { mid: m.message_id, date: day(o && o.date ? o.date : m.date, tz), text: String(m.text || m.caption || '').slice(0, 12000), from: '', fromUser: '', fwd: !!o };
  if (o) {
    if (o.type === 'user' && o.sender_user) { d.from = auth.fullName(o.sender_user); d.fromUser = o.sender_user.username || ''; }
    else if (o.type === 'hidden_user') d.from = String(o.sender_user_name || '').slice(0, 80);
    else if (o.type === 'chat' && o.sender_chat) d.from = String(o.sender_chat.title || '').slice(0, 80);
    else if (o.type === 'channel' && o.chat) d.from = String(o.chat.title || '').slice(0, 80);
  }
  if (m.voice) d.file = { kind: 'audio', tg: m.voice.file_id, name: 'Голосовое ' + d.date + '.ogg', dur: +m.voice.duration || 0 };
  else if (m.audio) d.file = { kind: 'audio', tg: m.audio.file_id, name: String(m.audio.file_name || m.audio.title || 'Аудио').slice(0, 80), dur: +m.audio.duration || 0 };
  return d;
}

/* ---------- saving ---------- */
// A client reply is stored at once and tied to a project. The project itself is never touched here:
// that happens in the dashboard, after the owner has reviewed the message.
async function saveMessage(draft, projectId) {
  const contacts = await db.listDocs('contacts');
  const uname = String(draft.fromUser || (/^@/.test(draft.from || '') ? draft.from.slice(1) : '')).toLowerCase();
  const nm = norm(draft.from);
  const c = contacts.find((x) => (uname && String(x.data.tg || '').replace(/^@/, '').toLowerCase() === uname) || (nm && norm(x.data.name) === nm));
  const id = 'gt' + draft.mid;
  const data = {
    project: projectId, contact: c ? c.id : '', from: draft.from || (uname ? '@' + uname : ''), text: draft.text || '', summary: '',
    date: draft.date, channel: 'tg', review: 'pending', proposal: null, applied: [], src: 'bot', u: new Date().toISOString(),
  };
  if (draft.file) data.file = draft.file;
  const doc = await db.setDoc('messages', id, data);
  hub.publish('messages', id, doc.data, doc.version);
  return id;
}
async function finish(chat, uid, draft, projectId, reply) {
  const p = (await projects()).find((x) => x.id === projectId);
  await db.setState(uid, {});
  if (!p) return (reply || say)(chat, 'Этого проекта уже нет. Пришли сообщение ещё раз и выбери другой.');
  const id = await saveMessage(draft, projectId);
  const html = 'Сохранил в проект <b>' + esc(pname(p)) + '</b>' + (draft.from ? ' от <b>' + esc(draft.from) + '</b>' : '') + '.\n' +
    (draft.file && draft.file.kind === 'audio' && !draft.text ? 'Это аудио без расшифровки: текст можно вписать в дэшборде.\n' : '') +
    'Сам проект не менялся: сообщение ждёт твоего ревью.';
  const b = openBtn('Открыть ревью', '/?open=msg-' + id);
  return (reply || say)(chat, html, b ? kb([b]) : undefined);
}

async function route(m, draft, headerText) {
  const chat = m.chat.id, uid = m.from.id, list = await projects(), st = await db.getState(uid);
  const hdr = headerText ? parseHeader(headerText, list) : null;
  if (hdr) {
    if (headerText === draft.text) draft.text = hdr.body;
    draft.from = hdr.from;
    if (!draft.text && !draft.file) {
      if (hdr.project) {
        await db.setState(uid, { hdr: { from: hdr.from, project: hdr.project, until: now() + 600 } });
        return say(chat, 'Жду сообщение или голосовое от <b>' + esc(hdr.from) + '</b> для проекта <b>' + esc(pname(list.find((p) => p.id === hdr.project))) + '</b>. Перешли его в ближайшие 10 минут.', kb([[{ text: 'Отмена', callback_data: 'x' }]]));
      }
      await db.setState(uid, { hdrPending: { from: hdr.from, until: now() + 600 }, want: 'project' });
      return say(chat, 'Не нашёл проект «' + esc(hdr.projectQuery) + '». Выбери проект, и я подожду сообщение от <b>' + esc(hdr.from) + '</b>:', projectKb(list, hdr.cands));
    }
    if (hdr.project) return finish(chat, uid, draft, hdr.project);
    await db.setState(uid, { draft, want: 'project' });
    return say(chat, 'Не нашёл проект «' + esc(hdr.projectQuery) + '». В какой сохранить?', projectKb(list, hdr.cands));
  }
  if (st.hdr && st.hdr.until > now()) {
    if (st.hdr.from) draft.from = st.hdr.from;
    return finish(chat, uid, draft, st.hdr.project);
  }
  if (draft.fwd || draft.file) {
    await db.setState(uid, { draft, want: 'project' });
    return say(chat, (draft.from ? 'От: <b>' + esc(draft.from) + '</b>\n' : '') + 'В какой проект сохранить?', projectKb(list, []));
  }
  await db.setState(uid, { draft, want: 'kind' });
  return say(chat, 'Что сделать с этим текстом?', kb([[{ text: 'Ответ клиента', callback_data: 'k:m' }, { text: 'Во входящие', callback_data: 'k:i' }]].concat(ai.enabled() ? [[{ text: 'Спросить Claude', callback_data: 'k:a' }]] : [], [[{ text: 'Отмена', callback_data: 'x' }]])));
}
async function intake(m) {
  const st0 = await db.getState(m.from.id);
  if (st0.want === 'ask' && st0.until > now() && m.text && !m.forward_origin) { await db.setState(m.from.id, {}); return askClaude(m.chat.id, m.from.id, m.text); }
  const draft = draftFrom(m, await appTz());
  if (!draft.text && !draft.file) return say(m.chat.id, UNSUPPORTED);
  return route(m, draft, draft.fwd ? '' : draft.text);
}

/* ---------- files: text, backups ---------- */
async function onDocument(m, cmd) {
  const d = m.document, name = String(d.file_name || 'file'), chat = m.chat.id;
  if (/\.json$/i.test(name) && (cmd === 'restore' || /prooloog-backup/i.test(name))) return askRestore(m);
  if (/^text\//.test(d.mime_type || '') || /\.(txt|md|log|csv)$/i.test(name)) {
    if ((+d.file_size || 0) > 512 * 1024) return say(chat, 'Файл больше 512 КБ. Пришли текст покороче или вставь его сообщением.');
    const text = (await T.readFile(d.file_id, 512 * 1024)).toString('utf8').replace(/\u0000/g, '').trim();
    if (!text) return say(chat, 'В файле нет текста.');
    const draft = draftFrom(Object.assign({}, m, { text: undefined, caption: undefined }), await appTz());
    draft.text = text.slice(-8000);
    draft.file = { kind: 'text', name: name.slice(0, 80) };
    return route(m, draft, String(m.caption || ''));
  }
  return say(chat, UNSUPPORTED);
}
function countDocs(docs) { return Object.keys(docs || {}).reduce((n, c) => n + (docs[c] && typeof docs[c] === 'object' ? Object.keys(docs[c]).length : 0), 0); }
async function readBackup(fileId) {
  let j;
  try { j = JSON.parse((await T.readFile(fileId, 20 * 1024 * 1024)).toString('utf8')); } catch (e) { return null; }
  if (!j || j.app !== 'prooloog' || !j.docs || typeof j.docs !== 'object' || Array.isArray(j.docs)) return null;
  return { docs: j.docs, n: countDocs(j.docs), at: String(j.exportedAt || '') };
}
async function askRestore(m) {
  const chat = m.chat.id, d = m.document;
  if ((+d.file_size || 0) > 20 * 1024 * 1024) return say(chat, 'Файл больше 20 МБ, такую копию я не приму.');
  const b = await readBackup(d.file_id);
  if (!b || !b.n) return say(chat, 'Это не похоже на копию данных ' + esc(cfg.appName) + '.');
  await db.setState(m.from.id, { restore: { file: d.file_id, until: now() + 600 } });
  return say(chat, 'Копия' + (/^\d{4}-\d{2}-\d{2}/.test(b.at) ? ' от ' + b.at.slice(0, 10) : '') + ': записей ' + b.n + '.\n<b>Все текущие данные дэшборда будут заменены этой копией.</b> Продолжить?',
    kb([[{ text: 'Да, заменить данные', callback_data: 'rs:y' }], [{ text: 'Отмена', callback_data: 'x' }]]));
}
async function sendBackup(chat, manual) {
  const docs = await db.exportAll();
  const body = Buffer.from(JSON.stringify({ app: 'prooloog', version: 1, exportedAt: new Date().toISOString(), docs }));
  await T.sendDocument(chat, 'prooloog-backup-' + day(0, await appTz()) + '.json', body,
    (manual ? 'Копия данных' : 'Плановая копия данных') + ': записей ' + countDocs(docs) + '. Чтобы восстановить, пришли этот файл мне с подписью /restore.');
  await db.kvSet('last_backup', { at: Date.now() });
}
let backupBusy = false;
// Called after activity: once in BACKUP_DAYS the owner gets a fresh copy in the chat.
async function maybeBackup() {
  if (!cfg.backupDays || backupBusy || !cfg.botToken) return;
  backupBusy = true;
  try {
    const owner = await auth.ownerId();
    if (!owner) return;
    const last = await db.kvGet('last_backup');
    if (!last) { await db.kvSet('last_backup', { at: Date.now() }); return; }
    if (Date.now() - (+last.at || 0) < cfg.backupDays * 864e5) return;
    if (!(await db.countDocs())) return;
    await sendBackup(owner, false);
  } catch (e) { console.error('[bot] backup failed:', e.message); } finally { backupBusy = false; }
}

/* ---------- a meeting participant: reminders by the event's link ---------- */
const GUEST_RULES = [5, 15, 60, 1440];
const ruleName = (m) => (m === 5 ? 'за 5 минут' : m === 15 ? 'за 15 минут' : m === 60 ? 'за час' : 'за день');
async function eventByShare(tok) {
  if (!/^[A-Za-z0-9_-]{12,48}$/.test(tok)) return null;
  return (await db.listDocs('events')).find((e) => e.data.share === tok) || null;
}
function guestKb(evId, rem) {
  return kb([GUEST_RULES.slice(0, 2), GUEST_RULES.slice(2)].map((row) => row.map((m) => ({ text: (rem.includes(m) ? '✓ ' : '') + ruleName(m), callback_data: 'er:' + evId + ':' + m }))));
}
async function guestText(e, rem, tz) {
  const s = remind.starts(e.data, tz, Date.now()).filter((x) => x.ms > Date.now() - 600000)[0];
  const timed = /^\d{2}:\d{2}$/.test(e.data.time || '');
  return '<b>' + esc(e.data.title || 'Встреча') + '</b>\n' + (s ? remind.dayLabel(s.d) + (timed ? ', ' + e.data.time + ' (' + remind.offsetLabel(s.ms, tz) + ')' : '') : 'дата уточняется') +
    '\n\n' + (rem.length ? 'Напомню ' + rem.slice().sort((a, b) => a - b).map(ruleName).join(', ') + '.' : 'Напоминания выключены.') +
    (remind.okLink(e.data.link) ? ' Ссылку на созвон пришлю за 5 минут до начала.' : '') + '\nКнопками ниже можно выбрать, когда напоминать.';
}
async function guestJoin(m, tok) {
  const e = await eventByShare(tok), chat = m.chat.id;
  if (!e) return say(chat, 'Эта ссылка на встречу больше не действует. Попроси у организатора новую.');
  const id = (e.id + '-' + m.from.id).slice(0, 64), cur = await db.getDoc('evsubs', id);
  const rem = cur ? remind.rules(cur.data.rem) : [5];
  const d = await db.setDoc('evsubs', id, { event: e.id, tg: String(m.from.id), name: auth.fullName(m.from), username: m.from.username || '', rem, u: new Date().toISOString() });
  hub.publish('evsubs', d.id, d.data, d.version);
  return say(chat, await guestText(e, rem, await appTz()), guestKb(e.id, rem));
}
async function guestToggle(cq, evId, min) {
  const id = (evId + '-' + cq.from.id).slice(0, 64), cur = await db.getDoc('evsubs', id), e = await db.getDoc('events', evId);
  const ack = (t) => T.tg('answerCallbackQuery', { callback_query_id: cq.id, text: t }).catch(() => {});
  if (!cur || !e || !GUEST_RULES.includes(min)) return ack('Эта встреча больше не доступна');
  const old = remind.rules(cur.data.rem), rem = old.includes(min) ? old.filter((x) => x !== min) : old.concat([min]);
  const d = await db.setDoc('evsubs', id, Object.assign({}, cur.data, { rem: remind.rules(rem), u: new Date().toISOString() }));
  hub.publish('evsubs', d.id, d.data, d.version);
  await ack(rem.includes(min) ? 'Напомню ' + ruleName(min) : 'Убрал напоминание');
  const msg = cq.message;
  if (msg && msg.chat) await T.tg('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: await guestText(e, d.data.rem, await appTz()), parse_mode: 'HTML', reply_markup: guestKb(evId, d.data.rem) }).catch(() => {});
}

/* ---------- a question to Claude, with the dashboard in view ---------- */
async function briefing() {
  const docs = await db.exportAll(), tz = await appTz(), now = clock.parts(Date.now(), tz), L = [];
  const P = docs.projects || {}, name = (id) => (P[id] && P[id].name) || 'без проекта';
  const ST = { active: 'в работе', idea: 'идея', paused: 'на паузе', done: 'завершён' };
  L.push('Сегодня ' + now.d + ', ' + now.t + ' (' + tz + ').');
  L.push('Часов в неделю на проекты: ' + ((docs.settings && docs.settings.main && docs.settings.main.capacity) || 40) + '.');
  L.push('\nПРОЕКТЫ');
  Object.keys(P).sort((a, b) => (+P[a].order || 0) - (+P[b].order || 0)).forEach((id) => {
    const p = P[id];
    L.push('- ' + p.name + ' [' + (ST[p.status] || p.status || '') + (p.area ? ', ' + p.area : '') + (+p.hours ? ', ' + p.hours + ' ч/нед' : '') + ']' + (p.next ? ' дальше: ' + p.next : ''));
  });
  const tasks = Object.values(docs.tasks || {}).filter((t) => t.status !== 'done').sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999'))).slice(0, 60);
  if (tasks.length) { L.push('\nОТКРЫТЫЕ ЗАДАЧИ'); tasks.forEach((t) => L.push('- ' + t.title + ' (' + name(t.project) + (t.due ? ', срок ' + t.due + (t.time ? ' ' + t.time : '') : '') + (t.status === 'doing' ? ', в работе' : '') + ')')); }
  const ms = Object.values(docs.milestones || {}).filter((m) => !m.done).sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999'))).slice(0, 30);
  if (ms.length) { L.push('\nМАЙЛСТОУНЫ'); ms.forEach((m) => L.push('- ' + m.title + ' (' + name(m.project) + (m.date ? ', ' + m.date : ', без даты') + ')')); }
  const ev = Object.values(docs.events || {}).filter((e) => e.repeat || String(e.date || '') >= now.d).sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))).slice(0, 30);
  if (ev.length) { L.push('\nСОБЫТИЯ'); ev.forEach((e) => L.push('- ' + e.title + ' (' + (e.date || '') + (e.time ? ' ' + e.time : '') + (e.repeat === 'daily' ? ', каждый день' : e.repeat === 'weekly' ? ', каждую неделю' : '') + ', ' + name(e.project) + ')')); }
  const inbox = Object.values(docs.inbox || {}).slice(0, 20);
  if (inbox.length) { L.push('\nВХОДЯЩИЕ'); inbox.forEach((x) => L.push('- ' + String(x.text || '').slice(0, 200))); }
  const wait = Object.values(docs.messages || {}).filter((m) => m.review === 'pending').slice(0, 15);
  if (wait.length) { L.push('\nСООБЩЕНИЯ, ЖДУТ РЕВЬЮ'); wait.forEach((m) => L.push('- от ' + (m.from || 'кого-то') + ' (' + name(m.project) + ', ' + (m.date || '') + '): ' + String(m.summary || m.text || '').slice(0, 240))); }
  return L.join('\n').slice(0, 24000);
}
async function askClaude(chat, uid, question) {
  if (!ai.enabled()) return say(chat, 'Claude на сервере пока не подключён. Нужен ключ API: в настройках сервера добавь переменную ANTHROPIC_API_KEY.');
  const q = String(question || '').trim();
  if (!q) { await db.setState(uid, { want: 'ask', until: now() + 600 }); return say(chat, 'Что спросить у Claude? Напиши вопрос следующим сообщением.'); }
  T.tg('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {});
  const st = await db.getState(uid), hist = Array.isArray(st.chat) && st.chatAt > now() - 3600 ? st.chat.slice(-6) : [];
  const system = 'Ты ассистент владельца в его дэшборде проектов ' + cfg.appName + ' и отвечаешь ему в Telegram. Отвечай по-русски, коротко и по делу, обычным текстом без разметки. ' +
    'Опирайся на данные ниже; если их не хватает, скажи об этом прямо и ничего не выдумывай. Менять данные ты не можешь: предложи, что записать, а владелец сделает это сам.\n\nДАННЫЕ ДЭШБОРДА\n' + (await briefing());
  const r = await ai.ask(system, hist.concat([{ role: 'user', content: q.slice(0, 4000) }]), 1500);
  if (r.error) return say(chat, { not_granted: 'Claude не принял ключ API. Проверь ANTHROPIC_API_KEY в настройках сервера.', rate_limited: 'Claude сейчас перегружен запросами. Попробуй через минуту.', refused: 'Claude отказался отвечать на этот вопрос.' }[r.error] || 'Не получилось получить ответ от Claude. Попробуй ещё раз.');
  await db.setState(uid, { chat: hist.concat([{ role: 'user', content: q.slice(0, 2000) }, { role: 'assistant', content: r.text.slice(0, 3000) }]).slice(-6), chatAt: now() });
  for (let i = 0; i < r.text.length && i < 12000; i += 3900) await T.tg('sendMessage', { chat_id: chat, text: r.text.slice(i, i + 3900), link_preview_options: { is_disabled: true } });
}

/* ---------- commands ---------- */
function closedText(from) {
  return 'Это закрытый дэшборд ' + esc(cfg.appName) + '. Доступ даёт владелец.' +
    (from.username ? ' Попроси его отправить мне: /invite @' + esc(from.username) : ' Чтобы тебя можно было пригласить, задай имя пользователя в настройках Telegram.');
}
async function setMenu(chat) {
  if (!https()) return;
  try { await T.tg('setChatMenuButton', { chat_id: chat, menu_button: { type: 'web_app', text: cfg.appName, web_app: { url: cfg.baseUrl + '/' } } }); } catch (e) { console.error('[bot] menu button:', e.message); }
}
function helpText(role) {
  const n = esc(cfg.appName);
  if (role !== 'owner') return '<b>' + n + '</b>\n\nДэшборд открывается кнопкой ниже или кнопкой «' + n + '» рядом с полем ввода.\n/login — ссылка для входа в обычном браузере.';
  return '<b>' + n + '</b> на связи.\n\n' +
    '• Дэшборд: кнопка ниже или кнопка «' + n + '» рядом с полем ввода.\n' +
    '• Ответ клиента: перешли мне его сообщение или голосовое и выбери проект. Можно сразу написать «от имя, проект: текст».\n' +
    '• Заметка: любой текст можно отправить во входящие.\n' +
    '• /login — ссылка для входа в обычном браузере.\n' +
    '• /ask вопрос — спросить Claude, он видит проекты, задачи и события.\n' +
    '• /backup — копия всех данных файлом.\n' +
    '• /connect — адрес коннектора для Claude, /usage — расход API за месяц.\n' +
    '• /invite @имя editor или viewer — дать доступ, /members — кто в команде.\n\n' +
    'Ответ клиента я только сохраняю и привязываю к проекту. Сам проект меняется после твоего ревью в дэшборде.';
}
async function onCommand(m, role, cmd, arg) {
  const chat = m.chat.id, uid = m.from.id;
  if (!role) return say(chat, closedText(m.from));
  const owner = role === 'owner';
  if (cmd === 'start' || cmd === 'help') {
    if (cmd === 'start') await setMenu(chat);
    const b = openBtn('Открыть ' + cfg.appName);
    return say(chat, helpText(role), b ? kb([b]) : undefined);
  }
  if (cmd === 'login') {
    if (!https()) return say(chat, 'У сервера пока нет публичного адреса, ссылку выдать не могу.');
    const code = await db.createLoginCode(uid, 10);
    return say(chat, 'Ссылка для входа в браузере. Она срабатывает один раз и действует 10 минут. Никому её не пересылай.', kb([[{ text: 'Войти в браузере', url: cfg.baseUrl + '/?k=' + code }]]));
  }
  if (cmd === 'cancel') { await db.setState(uid, {}); return say(chat, 'Отменил.'); }
  if (!owner) return say(chat, 'Эта команда доступна только владельцу.');
  if (cmd === 'ask') return askClaude(chat, uid, arg);
  if (cmd === 'connect') {
    if (!https()) return say(chat, 'У сервера пока нет публичного адреса, коннектор выдать не могу.');
    const t = await mcp.token(/^(new|новый)$/i.test(arg));
    return say(chat, '<b>Коннектор для Claude</b>\n\nАдрес, никому его не пересылай: по нему открываются все данные дэшборда.\n<code>' + esc(cfg.baseUrl + '/mcp/' + t) + '</code>\n\n' +
      'В Claude: Customize → Connectors → Add custom connector. Название: <b>Prooloog</b>, адрес: строка выше, вход: No sign-in.\n\nЗаменить адрес и отключить старый: /connect new');
  }
  if (cmd === 'usage') {
    const tz = await appTz(), m = clock.parts(Date.now(), tz).d.slice(0, 7), u = await usage.month(m);
    return say(chat, !ai.enabled() ? 'Claude на сервере не подключён: в настройках сервера нет ключа ANTHROPIC_API_KEY.'
      : u.n ? 'Claude API за ' + m + ': запросов ' + u.n + ', токенов на вход ' + u.in + ', на выход ' + u.out + ', примерно ' + u.cost.toFixed(2) + ' $.\nЭто оценка по прайсу, точная сумма в консоли Anthropic.'
        : 'В этом месяце запросов к Claude с сервера ещё не было.');
  }
  if (cmd === 'backup') return sendBackup(chat, true);
  if (cmd === 'restore') return say(chat, 'Пришли файл копии (prooloog-backup-….json) с подписью /restore.');
  if (cmd === 'invite') {
    const mm = /^@?([A-Za-z][A-Za-z0-9_]{3,31})(?:\s+(editor|viewer|редактор|зритель))?$/i.exec(arg);
    if (!mm) return say(chat, 'Напиши так: /invite @имя editor или /invite @имя viewer.\neditor может менять данные, viewer только смотрит. Деньги, контакты и переписку видишь только ты.');
    const role2 = /^(editor|редактор)$/i.test(mm[2] || '') ? 'editor' : 'viewer';
    await db.setInvite(mm[1].toLowerCase(), role2);
    return say(chat, 'Пригласил @' + esc(mm[1]) + ' как ' + (role2 === 'editor' ? 'редактора' : 'зрителя') + '. Пусть откроет ' + (botName ? '@' + esc(botName) : 'бота') + ' и нажмёт /start.');
  }
  if (cmd === 'members') {
    const ms = await db.listMembers(), inv = await db.listInvites();
    const lines = ms.map((x) => '• ' + esc(x.name || 'без имени') + (x.username ? ' @' + esc(x.username) : '') + ': ' + (x.role === 'editor' ? 'редактор' : 'зритель'))
      .concat(inv.map((x) => '• @' + esc(x.username) + ': приглашён, ещё не зашёл'));
    return say(chat, lines.length ? 'Доступ есть у тебя и ещё:\n' + lines.join('\n') + '\n\nУбрать: /remove @имя' : 'Пока доступ есть только у тебя. Пригласить: /invite @имя editor');
  }
  if (cmd === 'remove') {
    const mm = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(arg);
    if (!mm) return say(chat, 'Напиши так: /remove @имя');
    const n = (await db.removeMemberByUsername(mm[1].toLowerCase())) + (await db.removeInvite(mm[1].toLowerCase()));
    return say(chat, n ? 'Убрал доступ у @' + esc(mm[1]) + '.' : 'Не нашёл @' + esc(mm[1]) + ' среди участников.');
  }
  return say(chat, 'Не знаю такую команду. Список: /help');
}

/* ---------- updates ---------- */
async function onMessage(m) {
  if (!m.chat || m.chat.type !== 'private' || !m.from || m.from.is_bot) return;
  const role = await auth.roleOf(m.from);
  const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(String(m.text || '').trim());
  const ev = cmd && cmd[1].toLowerCase() === 'start' ? /^ev_([A-Za-z0-9_-]+)$/.exec((cmd[2] || '').trim()) : null;
  if (ev) return guestJoin(m, ev[1]);
  if (cmd) return onCommand(m, role, cmd[1].toLowerCase(), (cmd[2] || '').trim());
  if (!role) return say(m.chat.id, closedText(m.from));
  if (role !== 'owner') return say(m.chat.id, 'Ответы клиентов и заметки принимаю только от владельца. Дэшборд открывается командой /start.');
  if (m.document) {
    const cap = /^\/([a-z_]+)/i.exec(String(m.caption || '').trim());
    return onDocument(m, cap ? cap[1].toLowerCase() : '');
  }
  return intake(m);
}
async function onCallback(cq) {
  const uid = cq.from.id, msg = cq.message, chat = msg && msg.chat && msg.chat.id, data = String(cq.data || '');
  const ack = (text) => T.tg('answerCallbackQuery', { callback_query_id: cq.id, text: text || undefined }).catch(() => {});
  const edit = (c, html, markup) => (msg && msg.message_id
    ? T.tg('editMessageText', { chat_id: c, message_id: msg.message_id, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup }).catch(() => say(c, html, markup))
    : say(c, html, markup));
  if (!chat) return ack();
  const er = /^er:([A-Za-z0-9_-]{1,40}):(\d{1,5})$/.exec(data);
  if (er) return guestToggle(cq, er[1], +er[2]);
  if ((await auth.roleOf(cq.from)) !== 'owner') return ack('Доступно только владельцу');
  const st = await db.getState(uid);
  const stale = async () => { await ack('Уже обработано'); return edit(chat, 'Здесь уже нечего сохранять. Пришли сообщение ещё раз.'); };

  if (data === 'x') { await db.setState(uid, {}); await ack('Отменил'); return edit(chat, 'Отменил. Ничего не сохранено.'); }
  if (data === 'k:i') {
    if (!st.draft || !st.draft.text) return stale();
    const id = 'it' + st.draft.mid;
    const doc = await db.setDoc('inbox', id, { text: st.draft.text.slice(0, 300), u: new Date().toISOString() });
    hub.publish('inbox', id, doc.data, doc.version);
    await db.setState(uid, {});
    await ack('Добавил');
    return edit(chat, 'Добавил во входящие.');
  }
  if (data === 'k:a') {
    if (!st.draft || !st.draft.text) return stale();
    await db.setState(uid, {});
    await ack('Спрашиваю');
    await edit(chat, 'Спрашиваю Claude…');
    return askClaude(chat, uid, st.draft.text);
  }
  if (data === 'k:m') {
    if (!st.draft) return stale();
    await db.setState(uid, { draft: st.draft, want: 'project' });
    await ack();
    return edit(chat, 'В какой проект сохранить?', projectKb(await projects(), []));
  }
  if (data.startsWith('p:')) {
    const pid = data.slice(2);
    if (st.draft && st.want === 'project') { await ack('Сохраняю'); return finish(chat, uid, st.draft, pid, edit); }
    if (st.hdrPending && st.hdrPending.until > now()) {
      const p = (await projects()).find((x) => x.id === pid);
      if (!p) return stale();
      await db.setState(uid, { hdr: { from: st.hdrPending.from, project: pid, until: now() + 600 } });
      await ack();
      return edit(chat, 'Жду сообщение или голосовое от <b>' + esc(st.hdrPending.from) + '</b> для проекта <b>' + esc(pname(p)) + '</b>. Перешли его в ближайшие 10 минут.');
    }
    return stale();
  }
  if (data === 'rs:y') {
    if (!st.restore || st.restore.until < now()) return stale();
    await ack('Восстанавливаю');
    const b = await readBackup(st.restore.file);
    await db.setState(uid, {});
    if (!b || !b.n) return edit(chat, 'Не получилось прочитать копию. Данные не менялись.');
    const n = await db.importAll(b.docs, cfg.collections, true);
    hub.reloadAll();
    return edit(chat, 'Готово: данные заменены копией, записей ' + n + '.');
  }
  return ack();
}
async function handleUpdate(u) {
  try {
    if (u && u.message) await onMessage(u.message);
    else if (u && u.callback_query) await onCallback(u.callback_query);
  } catch (e) {
    console.error('[bot] update failed:', e.message);
    const chat = (u.message && u.message.chat && u.message.chat.id) || (u.callback_query && u.callback_query.from && u.callback_query.from.id);
    if (chat) { try { await say(chat, 'Не получилось обработать сообщение. Попробуй ещё раз чуть позже.'); } catch (_) { /* nothing more to do */ } }
  }
  maybeBackup();
}

/* ---------- start ---------- */
async function setup() {
  if (!cfg.botToken) { console.warn('[bot] BOT_TOKEN is not set: the bot and Telegram sign-in are off'); return false; }
  try {
    const me = await T.tg('getMe');
    botName = me.username || '';
    if (!https()) { console.warn('[bot] no public https address: the webhook is not set'); return false; }
    await T.tg('setWebhook', { url: cfg.baseUrl + '/tg/' + cfg.webhookPath, secret_token: cfg.webhookSecret, allowed_updates: ['message', 'callback_query'] });
    await T.tg('setMyCommands', { commands: [
      { command: 'start', description: 'Открыть ' + cfg.appName },
      { command: 'login', description: 'Ссылка для входа в браузере' },
      { command: 'ask', description: 'Спросить Claude о проектах' },
      { command: 'backup', description: 'Копия данных файлом' },
      { command: 'help', description: 'Что умеет бот' },
    ] });
    const owner = await auth.ownerId();
    if (owner) await setMenu(owner);
    console.log('[bot] @' + botName + ' is listening');
    return true;
  } catch (e) { console.error('[bot] setup failed:', e.message); return false; }
}

module.exports = { setup, handleUpdate, maybeBackup, sendBackup, parseHeader, matchProject, name: () => botName, forgetTz: clock.forget };
