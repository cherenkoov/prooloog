'use strict';
// The Telegram bot: opens the dashboard, signs people in, saves client replies for review, keeps backups.
const cfg = require('./config');
const db = require('./db');
const auth = require('./auth');
const hub = require('./realtime');
const T = require('./telegram');
const clock = require('./clock');
const groups = require('./groups');
const journal = require('./journal');
const i18n = require('./i18n');
const asks = require('./session');
const ai = require('./ai');
const mcp = require('./mcp');
const usage = require('./usage');
const remind = require('./remind');
const join = require('./join');
const google = require('./google');
const calls = require('./calls');

let botName = '', botId = 0, botReadsAll = false;

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
  journal.note('add', 'messages', id, doc.data, null, 'бот');
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
  // a session with Claude is open: the text goes there, a forwarded message goes with its author
  if (m.text && (await asks.active())) {
    const d = m.forward_origin ? draftFrom(m, await appTz()) : null;
    return askClaude(m.chat.id, m.from.id, d ? 'Пересланное сообщение' + (d.from ? ' от ' + d.from : '') + ':\n' + d.text : m.text);
  }
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
async function eventByShare(tok) {
  if (!/^[A-Za-z0-9_-]{12,48}$/.test(tok)) return null;
  return (await db.listDocs('events')).find((e) => e.data.share === tok) || null;
}
// A participant talks to the bot in their own language. Where it comes from, in this order:
// the language the organizer fixed in the link, the one this person chose before, a question with the likely one first.
const langOf = async (uid) => { const v = await db.kvGet('lang:' + uid); return i18n.ok(v) ? v : ''; };
// link: the call link of the meeting, when it has one: the participant can open it straight from the message
function guestKb(evId, rem, lang, link) {
  const L = i18n.of(lang);
  return kb((remind.okLink(link) ? [[{ text: L.join, url: link }]] : []).concat([GUEST_RULES.slice(0, 2), GUEST_RULES.slice(2)].map((row) => row.map((m) => ({ text: (rem.includes(m) ? '✓ ' : '') + L.rules[m], callback_data: 'er:' + evId + ':' + m }))))
    .concat([[{ text: L.langBtn, callback_data: 'el:' + evId + ':ask' }]]));
}
const langKb = (evId, code) => kb([i18n.offer(code).map((x) => ({ text: i18n.LANGS[x], callback_data: 'el:' + evId + ':' + x }))]);
async function guestText(e, rem, tz, lang) {
  const L = i18n.of(lang);
  const timed = /^\d{2}:\d{2}$/.test(e.data.time || '');
  let s = remind.starts(e.data, tz, Date.now()).filter((x) => x.ms > Date.now() - 600000)[0];
  // a meeting further than a month ahead still has its date
  if (!s && !e.data.repeat && /^\d{4}-\d{2}-\d{2}$/.test(e.data.date || '')) {
    const ms = clock.wallToMs(e.data.date, timed ? e.data.time : '09:00', tz);
    if (ms > Date.now() - 600000) s = { d: e.data.date, ms };
  }
  return '<b>' + esc(e.data.title || L.meeting) + '</b>\n' + (s ? L.dayFull(s.d, clock.parts(Date.now(), tz).d.slice(0, 4)) + (timed ? ', ' + e.data.time + ' (' + remind.offsetLabel(s.ms, tz) + ')' : '') : L.tbd) +
    (remind.okLink(e.data.link) ? '\n\n' + L.linkNow(esc(e.data.link)) : '') +
    '\n\n' + (rem.length ? L.will(rem.slice().sort((a, b) => a - b).map((m) => L.rules[m] || '').filter(Boolean).join(', ')) : L.off) + '\n' + L.choose;
}
// fixed: the language the organizer put into the link ('' when the participant is to choose)
async function guestJoin(m, tok, fixed) {
  const e = await eventByShare(tok), chat = m.chat.id, code = m.from.language_code, uid = m.from.id;
  const known = i18n.ok(fixed) ? fixed : await langOf(uid);
  if (!e) return say(chat, i18n.of(known || i18n.guess(code)).gone);
  const id = (e.id + '-' + uid).slice(0, 64), cur = await db.getDoc('evsubs', id);
  const rem = cur ? remind.rules(cur.data.rem) : [5];
  // until the person chooses, reminders go out in the likely language: nobody is left without them
  const lang = known || (cur && i18n.ok(cur.data.lang) ? cur.data.lang : i18n.guess(code));
  const settled = !!known || !!(cur && cur.data.asked);
  const d = await db.setDoc('evsubs', id, { event: e.id, tg: String(uid), name: auth.fullName(m.from), username: m.from.username || '', rem, lang, asked: settled, u: new Date().toISOString() });
  hub.publish('evsubs', d.id, d.data, d.version);
  if (!settled) return say(chat, '<b>' + esc(e.data.title || '') + '</b>\n' + i18n.PICK, langKb(e.id, code));
  return say(chat, await guestText(e, rem, await appTz(), lang), guestKb(e.id, rem, lang, e.data.link));
}
async function guestToggle(cq, evId, min) {
  const id = (evId + '-' + cq.from.id).slice(0, 64), cur = await db.getDoc('evsubs', id), e = await db.getDoc('events', evId);
  const ack = (t) => T.tg('answerCallbackQuery', { callback_query_id: cq.id, text: t }).catch(() => {});
  const lang = cur && i18n.ok(cur.data.lang) ? cur.data.lang : i18n.guess(cq.from.language_code), L = i18n.of(lang);
  if (!cur || !e || !GUEST_RULES.includes(min)) return ack(L.goneShort);
  const old = remind.rules(cur.data.rem), rem = old.includes(min) ? old.filter((x) => x !== min) : old.concat([min]);
  const d = await db.setDoc('evsubs', id, Object.assign({}, cur.data, { rem: remind.rules(rem), u: new Date().toISOString() }));
  hub.publish('evsubs', d.id, d.data, d.version);
  await ack(rem.includes(min) ? L.on(L.rules[min]) : L.removed);
  const msg = cq.message;
  if (msg && msg.chat) await T.tg('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: await guestText(e, d.data.rem, await appTz(), lang), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: guestKb(evId, d.data.rem, lang, e.data.link) }).catch(() => {});
}
// el:<event>:ask shows the languages again; el:<event>:<lang> sets one, for this meeting and for the next links
async function guestLang(cq, evId, want) {
  const id = (evId + '-' + cq.from.id).slice(0, 64), cur = await db.getDoc('evsubs', id), e = await db.getDoc('events', evId), msg = cq.message;
  const ack = (t) => T.tg('answerCallbackQuery', { callback_query_id: cq.id, text: t || undefined }).catch(() => {});
  const edit = (html, markup) => (msg && msg.chat ? T.tg('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup }).catch(() => {}) : null);
  if (!cur || !e) return ack(i18n.of(cur && cur.data.lang ? cur.data.lang : i18n.guess(cq.from.language_code)).goneShort);
  if (want === 'ask') { await ack(); return edit('<b>' + esc(e.data.title || '') + '</b>\n' + i18n.PICK, langKb(evId, cur.data.lang || cq.from.language_code)); }
  if (!i18n.ok(want)) return ack();
  const d = await db.setDoc('evsubs', id, Object.assign({}, cur.data, { lang: want, asked: true, u: new Date().toISOString() }));
  hub.publish('evsubs', d.id, d.data, d.version);
  await db.kvSet('lang:' + cq.from.id, want);
  await ack(i18n.of(want).saved);
  return edit(await guestText(e, remind.rules(d.data.rem), await appTz(), want), guestKb(evId, remind.rules(d.data.rem), want, e.data.link));
}

/* ---------- an invite link: access to chosen projects ---------- */
async function inviteJoin(m, tok) {
  const chat = m.chat.id, id = String(m.from.id);
  if (!/^[A-Za-z0-9_-]{12,40}$/.test(tok)) return say(chat, 'Эта ссылка-приглашение не действует.');
  if ((await auth.roleOf(m.from)) === 'owner') return say(chat, 'Это твоя собственная ссылка-приглашение. Отправь её тому, кому хочешь открыть доступ.');
  const inv = await db.useInviteLink(tok, id);
  if (!inv) return say(chat, 'Эта ссылка-приглашение уже использована или устарела. Попроси у владельца новую.');
  const role = inv.role === 'editor' ? 'editor' : 'viewer', cur = await db.getMember(id);
  let list = Array.isArray(inv.projects) ? inv.projects : null;
  // someone who already has access keeps it: the project lists add up
  if (cur) list = list === null || !Array.isArray(cur.projects) ? null : [...new Set(cur.projects.concat(list))];
  await db.upsertMember(id, m.from.username || '', auth.fullName(m.from), cur && cur.role === 'editor' ? 'editor' : role);
  await db.setMemberAccess(id, cur && cur.role === 'editor' ? 'editor' : role, list);
  hub.setAccess(id, cur && cur.role === 'editor' ? 'editor' : role, list);
  const all = await projects(), names = list === null ? 'все проекты' : all.filter((p) => list.includes(p.id)).map(pname).join(', ') || 'выбранные проекты';
  const what = role === 'editor' ? 'можно смотреть и менять' : 'можно смотреть';
  await setMenu(chat);
  const b = openBtn('Открыть ' + cfg.appName);
  await say(chat, 'Тебе открыт доступ в ' + esc(cfg.appName) + ': <b>' + esc(names) + '</b>, ' + what + '.', b ? kb([b]) : undefined);
  journal.event('acc', 'Вход по приглашению: ' + (auth.fullName(m.from) || 'без имени') + (m.from.username ? ' (@' + m.from.username + ')' : '') + ' — ' + names + ', ' + (role === 'editor' ? 'редактор' : 'зритель'));
  const owner = await auth.ownerId();
  if (owner) await say(owner, esc(auth.fullName(m.from) || 'Кто-то') + (m.from.username ? ' (@' + esc(m.from.username) + ')' : '') + ': вход по приглашению. ' + esc(names) + ', ' + (role === 'editor' ? 'редактор' : 'зритель') + '.').catch(() => {});
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
// «Спросить Claude» opens a session: see session.js. The first message may come with it.
const askClaude = (chat, uid, question) => asks.say(chat, uid, question);
async function memoryText() {
  const list = await asks.notes(8), all = (await db.listDocs('memory')).length;
  if (!all) return 'В памяти Claude пока пусто. Она пополняется, когда завершается сессия («Спросить Claude»), и когда ты просишь что-то запомнить.';
  return '<b>Память Claude</b>: записей ' + all + '. Последние:\n\n' + list.map((m) => '• <b>' + esc(m.data.date || '') + '</b> ' + esc(m.data.title || '') + (m.data.text && m.data.text !== m.data.title ? '\n' + esc(String(m.data.text).slice(0, 500)) : '')).join('\n\n') +
    '\n\nСтереть всю память: /forget';
}
async function forget(chat, arg) {
  const docs = await db.listDocs('memory');
  if (!docs.length) return say(chat, 'В памяти Claude и так пусто.');
  if (!/^(да|yes)$/i.test(arg)) return say(chat, 'В памяти Claude записей: ' + docs.length + '. Стереть всё? Тогда напиши: /forget да');
  for (const d of docs) { await db.deleteDoc('memory', d.id); hub.publish('memory', d.id, null, 0); }
  journal.event('bulk', 'Память Claude стёрта: записей ' + docs.length);
  return say(chat, 'Стёр память Claude: записей ' + docs.length + '.');
}

/* ---------- Google Meet: the owner's sign-in ---------- */
async function googleCmd(chat, arg) {
  const st = await google.status();
  if (!st.configured) {
    return say(chat, 'Чтобы комнаты Google Meet создавались сами, серверу нужны ключи Google. Один раз, минут на десять:\n\n' +
      '1. console.cloud.google.com → создать проект.\n' +
      '2. «APIs & Services» → «Library» → включить <b>Google Meet REST API</b>.\n' +
      '3. «OAuth consent screen»: тип External, добавить разрешение <code>' + google.SCOPE + '</code>, затем «Publish app» (в режиме Testing вход слетает каждые 7 дней).\n' +
      '4. «Credentials» → «Create credentials» → «OAuth client ID», тип Web application, в «Authorized redirect URIs» вставить:\n<code>' + esc(st.redirect) + '</code>\n' +
      '5. Client ID и Client secret записать в Render: сервис → Environment → <code>GOOGLE_CLIENT_ID</code> и <code>GOOGLE_CLIENT_SECRET</code>.\n\n' +
      'Когда сервер перезапустится, напиши /google ещё раз: пришлю кнопку входа.');
  }
  if (/^(off|выкл|стоп)$/i.test(arg)) {
    await google.disconnect();
    return say(chat, 'Google отключён: ключ входа с сервера удалён. Уже созданные ссылки Meet продолжают работать. Доступ приложения целиком отзывается на myaccount.google.com/permissions.');
  }
  if (st.connected) return say(chat, 'Google подключён' + (st.at ? ' ' + esc(st.at.slice(0, 10)) : '') + ': у встречи с созвоном Google Meet без ссылки комната создаётся сама.\nОтключить: /google off');
  if (!/^https:\/\//.test(cfg.baseUrl)) return say(chat, 'У сервера нет публичного адреса https, Google на него не вернётся.');
  return say(chat, (st.broken ? 'Google перестал принимать прежний вход. ' : '') + 'Войди в Google тем аккаунтом, от имени которого будут создаваться встречи. Сервер получит одно разрешение: создавать встречи Meet и видеть те, что создал сам. Ссылка действует 15 минут.',
    { inline_keyboard: [[{ text: 'Войти в Google', url: await google.startUrl() }]] });
}
// Called when Google has sent the owner back with the access: fills in the links that were waiting.
async function googleConnected() {
  const owner = await auth.ownerId();
  if (!owner) return;
  const got = await calls.fill(), list = await join.announceable(), rows = [];
  got.forEach((d) => { const a = list.find((x) => x.id === d.id); if (a && Buffer.byteLength('an:' + d.id) <= 64) rows.push([{ text: 'Разослать команде: ' + String(d.data.title || 'Встреча').slice(0, 30) + ' (' + a.n + ')', callback_data: 'an:' + d.id }]); });
  await say(owner, 'Google подключён: комнаты Meet теперь создаются сами.' + (got.length ? '\n\nСсылки получили встречи:\n' + got.map((d) => '• ' + esc(d.data.title || 'Встреча') + ': ' + esc(d.data.link)).join('\n') : '\n\nВстреч Google Meet без ссылки сейчас нет.'),
    rows.length ? { inline_keyboard: rows } : undefined);
}

/* ---------- onboarding: one link for a whole chat ---------- */
// «/onboard проект» gives the link, «/onboard off проект» switches it off, «/onboard» lists the live ones.
async function onboard(chat, arg) {
  const list = await projects();
  if (!join.teamForm()) return say(chat, 'На сервере нет ни одной анкеты.');
  if (!botName) return say(chat, 'Бот ещё не подключён, ссылку выдать не могу.');
  const off = /^(off|выкл|стоп)\s+/i.test(arg), query = arg.replace(/^(off|выкл|стоп)\s+/i, '').trim();
  if (!query) {
    const links = await db.listJoinLinks(), lines = [];
    for (const l of links) {
      const p = list.find((x) => x.id === l.project), f = join.form(l.form);
      if (p && f && !join.isCard(f)) lines.push('• <b>' + esc(pname(p)) + '</b>, анкета «' + esc(f.title) + '», заполнили: ' + (await join.entries(f)).filter((d) => d.data.core && d.data.project === l.project).length + '\n' + join.url(botName, l.token));
    }
    return say(chat, (lines.length ? 'Ссылки онбординга:\n' + lines.join('\n') + '\n\n' : '') + 'Выключить ссылку: /onboard off название проекта\nОтветы таблицей: /answers, голоса: /votes\n\nДля какого проекта создать ссылку?', onboardKb(list, []));
  }
  const mp = matchProject(query, list, false);
  if (!mp.best) return say(chat, 'Не нашёл проект «' + esc(query) + '». ' + (off ? 'Напиши название точнее.' : 'Выбери его из списка:'), off ? undefined : onboardKb(list, mp.cands));
  if (off) {
    const n = await db.revokeJoinLinks(mp.best.id, join.forms().filter((f) => !join.isCard(f)).map((f) => f.id));
    return say(chat, n ? 'Ссылка онбординга в <b>' + esc(pname(mp.best)) + '</b> выключена. Те, кто уже вошёл, остаются в проекте: убрать можно в окне «Доступ».' : 'У проекта <b>' + esc(pname(mp.best)) + '</b> нет активной ссылки онбординга.');
  }
  return onboardLink(chat, mp.best);
}
function onboardKb(list, cands) {
  const k = projectKb(list, cands);
  k.inline_keyboard.forEach((row) => row.forEach((b) => { if (b.callback_data.startsWith('p:')) b.callback_data = 'ob:' + b.callback_data.slice(2); }));
  k.inline_keyboard = k.inline_keyboard.map((row) => row.filter((b) => Buffer.byteLength(b.callback_data) <= 64)).filter((row) => row.length);
  return k;
}
async function onboardLink(chat, p) {
  const f = join.teamForm(), link = join.url(botName, await join.linkFor(p.id, f.id));
  await say(chat, 'Ссылка онбординга в <b>' + esc(pname(p)) + '</b>, анкета «' + esc(f.title) + '». Работает для любого числа людей, пока её не выключить.\n\n' +
    'Каждый, кто заполнит основную часть, сразу получает доступ только к этому проекту с правом вести задачи и попадает в его контакты. Тебе придёт сообщение о каждом.\n\nТекст для чата ниже, его можно переслать как есть.');
  return say(chat, 'Коллеги, анкету «' + esc(f.title) + '» можно заполнить в Telegram: ' + esc(f.coreTime || 'пара минут') + ', вопросы с вариантами ответа.' +
    ((f.polls || []).length ? ' После анкеты можно ' + esc(f.pollsNote || 'проголосовать') + ': видно, кто за что проголосовал.' : '') + '\n\n' + link);
}

/* ---------- the invitation: a standing link and a QR code for meeting people in person ---------- */
// «/club проект» gives the link, the QR code and two ready texts (for a guest and for a master);
// «/club off проект» switches the link off. Whoever fills in the form becomes a contact of the project
// and sees its showcase: no access to the project itself.
async function club(chat, arg) {
  const list = await projects(), f = join.cardForm();
  if (!f) return say(chat, 'На сервере нет анкеты-приглашения.');
  if (!botName) return say(chat, 'Бот ещё не подключён, ссылку выдать не могу.');
  const off = /^(off|выкл|стоп)\s+/i.test(arg), query = arg.replace(/^(off|выкл|стоп)\s+/i, '').trim();
  const kb = (cands) => { const k = onboardKb(list, cands || []); k.inline_keyboard.forEach((row) => row.forEach((x) => { if (x.callback_data.startsWith('ob:')) x.callback_data = 'cl:' + x.callback_data.slice(3); })); return k; };
  if (!query) {
    const live = (await db.listJoinLinks()).filter((l) => join.isCard(join.form(l.form)) && list.some((x) => x.id === l.project));
    if (live.length === 1) return clubLink(chat, list.find((x) => x.id === live[0].project));
    return say(chat, 'Для какого проекта приглашение?', kb());
  }
  const mp = matchProject(query, list, false);
  if (!mp.best) return say(chat, 'Не нашёл проект «' + esc(query) + '». ' + (off ? 'Напиши название точнее.' : 'Выбери его из списка:'), off ? undefined : kb(mp.cands));
  if (off) {
    const n = await db.revokeJoinLinks(mp.best.id, join.forms().filter((x) => join.isCard(x)).map((x) => x.id));
    return say(chat, n ? 'Приглашение в <b>' + esc(pname(mp.best)) + '</b> выключено: ссылка и QR-код больше не работают. Карточки тех, кто уже заполнил анкету, остаются.' : 'У проекта <b>' + esc(pname(mp.best)) + '</b> нет активного приглашения.');
  }
  return clubLink(chat, mp.best);
}
async function clubLink(chat, p) {
  const f = join.cardForm(), link = join.url(botName, await join.linkFor(p.id, f.id)), t = join.inviteTexts(f, link);
  await say(chat, 'Приглашение в <b>' + esc(pname(p)) + '</b>, анкета «' + esc(f.title) + '». Ссылка постоянная, для любого числа людей:\n' + esc(link) + '\n\n' +
    'Кто заполнит анкету, попадает в контакты проекта (мастера с пометкой «Мастер») и видит витрину проекта; задач и внутренних записей не видит. Тебе придёт сообщение о каждом.\n\nНиже QR-код и два текста: участнику и мастеру. Их можно переслать как есть. Выключить: /club off ' + esc(pname(p)));
  try { await T.sendPhoto(chat, 'invite-' + p.id + '.png', await join.qrPng(link), 'QR-код приглашения «' + pname(p) + '»: камера телефона открывает бота.'); } catch (e) { console.error('[club] qr failed:', e.message); }
  await say(chat, esc(t.guest));
  return say(chat, esc(t.master));
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
    '• Рабочий чат: добавь меня в группу и выбери проект. Буду сохранять переписку на ревью, отвечать участникам по кнопкам и принимать от них задачи.\n' +
    '• /login — ссылка для входа в обычном браузере.\n' +
    '• /ask — сессия с Claude: пишешь как в обычном чате, он видит проекты, назначает встречи, ставит и закрывает задачи. Завершается кнопкой под ответом, командой /end или после 30 минут тишины; главное сохраняется в память (/memory).\n' +
    '• /backup — копия всех данных файлом.\n' +
    '• /connect — адрес коннектора для Claude, /usage — расход API за месяц.\n' +
    '• /google — подключить Google, чтобы комнаты Meet создавались сами. /announce — разослать встречу со ссылкой команде проекта.\n' +
    '• /onboard проект — ссылка-анкета для командного чата: человек заполняет её и сразу попадает в проект. /answers — ответы таблицей (все анкеты), /answers проект и /answers json проект — выгрузка одного проекта в CSV или JSON, /votes — голоса.\n' +
    '• /club проект — приглашение для личных встреч: постоянная ссылка, QR-код и тексты для участника и мастера. Человек заполняет анкету и попадает в контакты проекта.\n' +
    '• /invite @имя editor или viewer — дать доступ ко всем проектам, /members — кто в команде. Доступ к выбранным проектам: значок «поделиться» рядом с «Данные» в дэшборде.\n\n' +
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
  if (cmd === 'end') {
    const r = await asks.end('command');
    return say(chat, r.none ? 'Сессии с Claude сейчас нет. Начать: /ask' : asks.closedText(r.memory, false));
  }
  if (cmd === 'memory') return say(chat, await memoryText());
  if (cmd === 'forget') return forget(chat, arg);
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
  if (cmd === 'onboard') return onboard(chat, arg);
  if (cmd === 'club') return club(chat, arg);
  if (cmd === 'google') return googleCmd(chat, arg);
  if (cmd === 'announce') {
    const list = await join.announceable();
    if (!list.length) return say(chat, 'Рассылать пока нечего: нужна предстоящая встреча со ссылкой на созвон в проекте, где есть команда.');
    return say(chat, 'Какую встречу разослать команде?', { inline_keyboard: list.slice(0, 8).map((x) => [{ text: (x.title + ' · ' + x.when).slice(0, 60), callback_data: 'an:' + x.id }]).filter((r) => Buffer.byteLength(r[0].callback_data) <= 64) });
  }
  if (cmd === 'votes') return say(chat, await join.votesText());
  if (cmd === 'answers') {
    // «/answers проект» or «/answers json проект»: everything the onboarding of one project gathered, as one file
    const fmt = /^json(\s+|$)/i.test(arg) ? 'json' : 'csv', q = arg.replace(/^(json|csv)(\s+|$)/i, '').trim();
    if (q || fmt === 'json') {
      const list = await projects(), mp = q ? matchProject(q, list, false) : { best: null };
      if (!mp.best) return say(chat, q ? 'Не нашёл проект «' + esc(q) + '». Напиши название точнее.' : 'Для какого проекта? Напиши так: /answers json название проекта');
      const x = await join.exportProject(mp.best.id, fmt);
      if (!x.n) return say(chat, 'В проекте <b>' + esc(pname(mp.best)) + '</b> анкету пока никто не заполнил.');
      return T.sendDocument(chat, x.filename, x.body, 'Онбординг проекта «' + pname(mp.best) + '»: ответов ' + x.n + (fmt === 'csv' ? '. Открывается в Excel и Google Таблицах.' : ', формат JSON.'));
    }
    let sent = 0;
    for (const f of join.forms()) {
      const t = await join.csv(f);
      if (!t.n) continue;
      await T.sendDocument(chat, 'answers-' + f.id + '-' + day(0, await appTz()) + '.csv', t.body, 'Анкета «' + f.title + '»: ответов ' + t.n + '. Открывается в Excel и Google Таблицах.');
      sent++;
    }
    return sent ? undefined : say(chat, 'Анкету пока никто не заполнил.');
  }
  if (cmd === 'backup') return sendBackup(chat, true);
  if (cmd === 'restore') return say(chat, 'Пришли файл копии (prooloog-backup-….json) с подписью /restore.');
  if (cmd === 'invite') {
    const mm = /^@?([A-Za-z][A-Za-z0-9_]{3,31})(?:\s+(editor|viewer|редактор|зритель))?$/i.exec(arg);
    if (!mm) return say(chat, 'Напиши так: /invite @имя editor или /invite @имя viewer.\neditor может менять данные, viewer только смотрит. Деньги, контакты и переписку видишь только ты.');
    const role2 = /^(editor|редактор)$/i.test(mm[2] || '') ? 'editor' : 'viewer';
    await db.setInvite(mm[1].toLowerCase(), role2);
    journal.event('acc', 'Приглашён @' + mm[1] + ': ' + (role2 === 'editor' ? 'редактор' : 'зритель') + ', все проекты');
    return say(chat, 'Пригласил @' + esc(mm[1]) + ' как ' + (role2 === 'editor' ? 'редактора' : 'зрителя') + '. Пусть откроет ' + (botName ? '@' + esc(botName) : 'бота') + ' и нажмёт /start.');
  }
  if (cmd === 'members') {
    const ms = await db.listMembers(), inv = await db.listInvites(), all = await projects();
    const scope = (x) => !Array.isArray(x.projects) ? 'все проекты' : all.filter((p) => x.projects.includes(p.id)).map(pname).join(', ') || 'проекты удалены';
    const lines = ms.map((x) => '• ' + esc(x.name || 'без имени') + (x.username ? ' @' + esc(x.username) : '') + ': ' + (x.role === 'editor' ? 'редактор' : 'зритель') + ', ' + esc(scope(x)))
      .concat(inv.map((x) => '• @' + esc(x.username) + ': приглашён, ещё не зашёл'));
    return say(chat, lines.length ? 'Доступ есть у тебя и ещё:\n' + lines.join('\n') + '\n\nУбрать: /remove @имя' : 'Пока доступ есть только у тебя. Пригласить: /invite @имя editor');
  }
  if (cmd === 'remove') {
    const mm = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(arg);
    if (!mm) return say(chat, 'Напиши так: /remove @имя');
    const gone = await db.removeMemberByUsername(mm[1].toLowerCase());
    gone.forEach((x) => hub.dropUser(x));
    const n = gone.length + (await db.removeInvite(mm[1].toLowerCase()));
    if (n) journal.event('acc', 'Доступ закрыт: @' + mm[1]);
    return say(chat, n ? 'Убрал доступ у @' + esc(mm[1]) + '.' : 'Не нашёл @' + esc(mm[1]) + ' среди участников.');
  }
  return say(chat, 'Не знаю такую команду. Список: /help');
}

/* ---------- updates ---------- */
groups.init({ say, kb, esc, projects, pname, me: () => ({ id: botId, name: botName, readsAll: botReadsAll }) });
asks.init({ say, kb, esc, briefing, botName: () => botName });
async function onMessage(m) {
  if (groups.isGroup(m.chat)) return groups.onMessage(m);
  if (!m.chat || m.chat.type !== 'private' || !m.from || m.from.is_bot) return;
  const role = await auth.roleOf(m.from);
  const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(String(m.text || '').trim());
  // ev_<token>: the participant chooses the language; evru_<token>, even_<token>: the organizer has fixed it
  const ev = cmd && cmd[1].toLowerCase() === 'start' ? /^ev([a-z]{2})?_([A-Za-z0-9_-]+)$/.exec((cmd[2] || '').trim()) : null;
  if (ev) return guestJoin(m, ev[2], ev[1] || '');
  const inv = cmd && cmd[1].toLowerCase() === 'start' ? /^inv_([A-Za-z0-9_-]+)$/.exec((cmd[2] || '').trim()) : null;
  if (inv) return inviteJoin(m, inv[1]);
  const jn = cmd && cmd[1].toLowerCase() === 'start' ? /^join_([A-Za-z0-9_-]+)$/.exec((cmd[2] || '').trim()) : null;
  if (jn) return join.start(m, jn[1]);
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
  if (/^g[lp]:/.test(data)) return groups.onCallback(cq);
  const edit = (c, html, markup) => (msg && msg.message_id
    ? T.tg('editMessageText', { chat_id: c, message_id: msg.message_id, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup }).catch(() => say(c, html, markup))
    : say(c, html, markup));
  if (!chat) return ack();
  const er = /^er:([A-Za-z0-9_-]{1,40}):(\d{1,5})$/.exec(data);
  if (er) return guestToggle(cq, er[1], +er[2]);
  const el = /^el:([A-Za-z0-9_-]{1,40}):([a-z]{2,3})$/.exec(data);
  if (el) return guestLang(cq, el[1], el[2]);
  if ((await auth.roleOf(cq.from)) !== 'owner') return ack('Доступно только владельцу');
  const st = await db.getState(uid);
  const stale = async () => { await ack('Уже обработано'); return edit(chat, 'Здесь уже нечего сохранять. Пришли сообщение ещё раз.'); };

  if (data === 'x') { await db.setState(uid, {}); await ack('Отменил'); return edit(chat, 'Отменил. Ничего не сохранено.'); }
  if (data === 'as:end') {
    const r = await asks.end('button');
    await ack(r.none ? 'Сессии уже нет' : 'Завершил');
    if (msg && msg.message_id) await T.tg('editMessageReplyMarkup', { chat_id: chat, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    return say(chat, r.none ? 'Сессия с Claude уже завершена. Начать новую: /ask' : asks.closedText(r.memory, false));
  }
  if (data === 'k:i') {
    if (!st.draft || !st.draft.text) return stale();
    const id = 'it' + st.draft.mid;
    const doc = await db.setDoc('inbox', id, { text: st.draft.text.slice(0, 300), u: new Date().toISOString() });
    hub.publish('inbox', id, doc.data, doc.version);
    journal.note('add', 'inbox', id, doc.data, null, 'бот');
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
  if (data.startsWith('an:')) {
    await ack();
    const r = await join.announce(data.slice(3));
    if (r.error) return say(chat, esc(r.error));
    return say(chat, 'Разослал «' + esc(r.title) + '»: получили ' + r.sent + ' из ' + r.total + '.' + (r.sent < r.total ? ' Остальные не открывали бота или остановили его.' : ''));
  }
  if (data.startsWith('ob:')) {
    const p = (await projects()).find((x) => x.id === data.slice(3));
    await ack();
    if (!p || !botName || !join.teamForm()) return edit(chat, 'Этого проекта уже нет.');
    await edit(chat, 'Проект: <b>' + esc(pname(p)) + '</b>');
    return onboardLink(chat, p);
  }
  if (data.startsWith('cl:')) {
    const p = (await projects()).find((x) => x.id === data.slice(3));
    await ack();
    if (!p || !botName || !join.cardForm()) return edit(chat, 'Этого проекта уже нет.');
    await edit(chat, 'Проект: <b>' + esc(pname(p)) + '</b>');
    return clubLink(chat, p);
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
    const n = await db.importAll(b.docs, cfg.allCollections, true);
    journal.event('bulk', 'Данные заменены копией из файла: записей ' + n, 'бот');
    hub.reloadAll();
    return edit(chat, 'Готово: данные заменены копией, записей ' + n + '.');
  }
  return ack();
}
async function handleUpdate(u) {
  try {
    if (u && u.message) await onMessage(u.message);
    else if (u && u.callback_query) await onCallback(u.callback_query);
    else if (u && u.my_chat_member) await groups.onMember(u.my_chat_member);
  } catch (e) {
    console.error('[bot] update failed:', e.message);
    // a work chat is not the place for the bot's troubles: only a private chat hears about them
    const inGroup = (u.message && groups.isGroup(u.message.chat)) || (u.callback_query && u.callback_query.message && groups.isGroup(u.callback_query.message.chat)) || !!u.my_chat_member;
    const chat = inGroup ? 0 : (u.message && u.message.chat && u.message.chat.id) || (u.callback_query && u.callback_query.from && u.callback_query.from.id);
    if (chat) { try { await say(chat, 'Не получилось обработать сообщение. Попробуй ещё раз чуть позже.'); } catch (_) { /* nothing more to do */ } }
  }
  maybeBackup();
}

/* ---------- start ---------- */
async function setup() {
  if (!cfg.botToken) { console.warn('[bot] BOT_TOKEN is not set: the bot and Telegram sign-in are off'); return false; }
  try {
    const me = await T.tg('getMe');
    botName = me.username || ''; botId = +me.id || 0; botReadsAll = !!me.can_read_all_group_messages;
    if (!https()) { console.warn('[bot] no public https address: the webhook is not set'); return false; }
    await T.tg('setWebhook', { url: cfg.baseUrl + '/tg/' + cfg.webhookPath, secret_token: cfg.webhookSecret, allowed_updates: ['message', 'callback_query', 'my_chat_member'] });
    await T.tg('setMyCommands', { commands: [
      { command: 'start', description: 'Открыть ' + cfg.appName },
      { command: 'login', description: 'Ссылка для входа в браузере' },
      { command: 'ask', description: 'Сессия с Claude' },
      { command: 'backup', description: 'Копия данных файлом' },
      { command: 'help', description: 'Что умеет бот' },
    ] });
    await T.tg('setMyCommands', { scope: { type: 'all_group_chats' }, commands: [
      { command: 'project', description: 'Что сейчас по проекту' },
      { command: 'task', description: 'Предложить задачу' },
      { command: 'note', description: 'Оставить заметку' },
    ] }).catch((e) => console.warn('[bot] group commands are not set:', e.message));
    const owner = await auth.ownerId();
    if (owner) await setMenu(owner);
    console.log('[bot] @' + botName + ' is listening');
    return true;
  } catch (e) { console.error('[bot] setup failed:', e.message); return false; }
}

module.exports = { googleConnected, setup, handleUpdate, maybeBackup, sendBackup, parseHeader, matchProject, name: () => botName, readsAll: () => botReadsAll, forgetTz: clock.forget };
