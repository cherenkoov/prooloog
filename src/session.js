'use strict';
// A session with Claude in the bot. «Спросить Claude» opens it. From then on every text the owner writes goes
// to Claude, who sees the dashboard, remembers earlier sessions and can act on the data with the same tools
// the connector gives Claude in the chat: read, create, change, save a client message for review.
// The session ends on the «Завершить сессию» button under an answer, or after 30 minutes of silence.
// At the end Claude writes down what is worth remembering. The note and the talk itself go to `memory`
// (owner only), and the notes are handed to the next sessions.
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');
const hub = require('./realtime');
const clock = require('./clock');
const ai = require('./ai');
const mcp = require('./mcp');
const journal = require('./journal');
const T = require('./telegram');

const IDLE_MS = 30 * 60000, KEY = 'ask_session', MAX_TURNS = 60, MAX_CHARS = 60000, ROUNDS = 8;
const PREFIX = { projects: 'p', tasks: 't', milestones: 'm', events: 'e', inbox: 'i', log: 'l', contacts: 'c', money: 'y', subs: 'b', clients: 'k', posts: 'o', channels: 'h', services: 's' };
let B = null; // what the bot lends: say, kb, esc, briefing(), botName()
const init = (ctx) => { B = ctx; };
const nowIso = () => new Date().toISOString();
const rnd = (n) => crypto.randomBytes(n).toString('hex');
const one = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/* ---------- memory ---------- */
async function notes(limit) {
  return (await db.listDocs('memory')).sort((a, b) => String(b.data.at || '').localeCompare(String(a.data.at || ''))).slice(0, limit || 12);
}
async function saveMemory(data) {
  const tz = await clock.appTz(), p = clock.parts(Date.now(), tz);
  const id = 'm' + p.d.replace(/-/g, '') + p.t.replace(':', '') + '-' + rnd(2);
  const d = await db.setDoc('memory', id, Object.assign({ at: nowIso(), date: p.d, src: 'bot' }, data, { u: nowIso() }));
  hub.publish('memory', d.id, d.data, d.version);
  journal.note('add', 'memory', d.id, { title: d.data.title }, null, 'Claude');
  return d;
}

/* ---------- tools: the connector's own, plus two that make a chat in Telegram handy ---------- */
function tools() {
  const list = mcp.TOOLS.filter((t) => t.name !== 'sync').map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  list.push({
    name: 'create',
    description: 'Create a new record; the server gives it an id. For a meeting use collection "events": the result carries links for the participant (the bot asks their language, or speaks Russian / English at once).',
    input_schema: { type: 'object', properties: { collection: { type: 'string', description: 'Collection name' }, data: { type: 'object', description: 'The fields of the record' } }, required: ['collection', 'data'] },
  });
  list.push({
    name: 'remember',
    description: 'Save a note to the memory that the next sessions will see. Use when the owner asks to remember something.',
    input_schema: { type: 'object', properties: { text: { type: 'string', description: 'What to remember, one or two sentences' } }, required: ['text'] },
  });
  return list;
}
async function runTool(name, input) {
  const a = input && typeof input === 'object' ? input : {};
  if (name === 'remember') {
    const text = one(a.text, 600);
    if (!text) throw new Error('text is empty');
    const d = await saveMemory({ kind: 'note', title: one(text, 80), text });
    return { saved: d.id };
  }
  if (name === 'create') {
    const coll = String(a.collection || '');
    if (!PREFIX[coll]) throw new Error('create works for: ' + Object.keys(PREFIX).join(', '));
    if (!a.data || typeof a.data !== 'object' || Array.isArray(a.data)) throw new Error('data must be an object');
    const id = PREFIX[coll] + rnd(5), data = Object.assign({}, a.data);
    if (coll === 'events' && !data.share) data.share = rnd(12); // every meeting can be shared with a participant
    await mcp.call('write', { ops: [{ op: 'set', collection: coll, id, data }] });
    const out = { id, collection: coll };
    if (coll === 'events') { const fresh = await db.getDoc('events', id); if (fresh && fresh.data.link) out.call_link = fresh.data.link; } // the server may have made the link itself
    const bot = B.botName();
    if (coll === 'events' && bot) {
      const base = 'https://t.me/' + bot + '?start=ev';
      out.participant_links = { asks_language: base + '_' + data.share, russian: base + 'ru_' + data.share, english: base + 'en_' + data.share };
    }
    return out;
  }
  if (name === 'sync' || !mcp.TOOLS.some((t) => t.name === name)) throw new Error('Unknown tool: ' + name);
  return mcp.call(name, a);
}

/* ---------- what Claude knows when a turn begins ---------- */
async function systemText() {
  const owner = await db.kvGet('owner_profile'), tz = await clock.appTz(), now = clock.parts(Date.now(), tz);
  const st = await db.getDoc('settings', 'main'), meet = (st && st.data && st.data.meet) || {};
  const mem = await notes(12);
  const L = [
    'Ты Claude, ассистент ' + one((owner && owner.name) || 'владельца', 60) + ' в его дэшборде проектов ' + cfg.appName + '. Вы переписываетесь в Telegram. Это сессия: ты помнишь её с начала.',
    'Отвечай на языке собеседника (обычно по-русски), по делу, обычным текстом: без Markdown и без HTML.',
    'У тебя есть инструменты для данных дэшборда. Пользуйся ими, когда владелец просит что-то узнать, записать, назначить, перенести или отметить: делай, а не объясняй, как сделать. Перед удалением и там, где просьбу можно понять по-разному, сначала уточни. После действия скажи одной строкой, что сделано.',
    'Сообщение клиента или партнёра, в том числе пересланное, само проект не меняет. Если владелец просит его сохранить, используй add_message: предложенные изменения подождут его ревью в дэшборде. Менять проект по такому сообщению можно только по прямой просьбе владельца.',
    'Если владелец просит что-то запомнить, вызови remember. В конце сессии главное из неё сохранится в память само.',
    '',
    'ДАННЫЕ. Даты ГГГГ-ММ-ДД, время ЧЧ:ММ по часовому поясу приложения (' + tz + '). Сейчас ' + now.d + ', ' + now.t + '.',
    '- projects: name, area, status (idea | active | paused | done), next, why, hours, notes',
    '- tasks: project (id), title, status (todo | doing | done), due, time, milestone (id), contact (id), notes',
    '- milestones: project, title, date, done',
    '- events (встречи и события): project (id или ""), title, date, time, repeat ("" | daily | weekly), until, contact (id), call (zoom | meet | other), link, rem (за сколько минут напомнить, список чисел), lang (язык для участника: "" | ru | en)',
    '- inbox: text. log (комментарии проекта): project, text, tag (insight | idea | decision | question | meeting | risk), at',
    '- contacts: name, role, rel, tg, phone, email, projects [id], notes',
    '- messages, money, subs, clients, chats: читать можно; менять только по прямой просьбе владельца.',
    'Новая запись: create (id выдаст сервер). Изменить поля: write с op "merge". Удалить: write с op "delete", только после подтверждения. Найти id: list или get.',
    '',
    'ВСТРЕЧИ. Назначить встречу — создать запись в events. Для онлайн-встречи поставь call и link' +
      (meet.zoom || meet.meet ? '; постоянные ссылки владельца: ' + [meet.zoom ? 'Zoom ' + meet.zoom : '', meet.meet ? 'Google Meet ' + meet.meet : ''].filter(Boolean).join(', ') : '') +
      '. Если встреча в Zoom, достаточно call: "zoom" без link: ссылка создастся сама и вернётся в call_link. Напоминания задаются в rem, например [60, 15]. create вернёт ссылки для участника: по такой ссылке человек открывает бота и сразу получает ссылку на созвон, а за 5 минут до начала — напоминание. Если понятно, на каком языке говорит участник, дай ссылку на этом языке и запиши его в lang; если нет — ссылку, где бот сам спросит язык.',
  ];
  if (mem.length) {
    L.push('', 'ПАМЯТЬ ПРОШЛЫХ СЕССИЙ (свежие сверху)');
    mem.forEach((m) => L.push('- ' + (m.data.date || '') + ': ' + one(m.data.text || m.data.title, 700)));
  }
  L.push('', 'ДАННЫЕ ДЭШБОРДА СЕЙЧАС', await B.briefing());
  return L.join('\n');
}

/* ---------- the session itself ---------- */
const get = async () => { const s = await db.kvGet(KEY); return s && s.id && Array.isArray(s.turns) ? s : null; };
const active = async () => { const s = await get(); return !!s && Date.now() - (+s.lastAt || 0) < IDLE_MS; };
const endKb = () => B.kb([[{ text: 'Завершить сессию', callback_data: 'as:end' }]]);
const plain = (t) => String(t || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,4}\s+/gm, '').trim();
const ERR = {
  not_declared: 'Claude на сервере пока не подключён. Нужен ключ API: в настройках сервера добавь переменную ANTHROPIC_API_KEY.',
  not_granted: 'Claude не принял ключ API. Проверь ANTHROPIC_API_KEY в настройках сервера.',
  rate_limited: 'Claude сейчас перегружен запросами. Попробуй через минуту.',
  refused: 'Claude отказался отвечать на это сообщение.',
  prompt_too_large: 'Разговор стал слишком длинным. Заверши сессию и начни новую: главное сохранится в памяти.',
};

// Everything about one session happens in turn: two quick messages never step on each other.
let chain = Promise.resolve();
const inTurn = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

async function answer(s) {
  const system = await systemText(), list = tools();
  const messages = s.turns.map((x) => ({ role: x.r === 'a' ? 'assistant' : 'user', content: x.t }));
  const did = [];
  for (let i = 0; i < ROUNDS; i++) {
    const r = await ai.chat({ system, messages, tools: list, maxTokens: 2000 });
    if (r.error) return { error: r.error, did };
    const uses = r.content.filter((b) => b && b.type === 'tool_use');
    if (r.stop !== 'tool_use' || !uses.length) {
      const text = r.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim();
      return { text: text || (did.length ? 'Готово.' : ''), did, truncated: r.stop === 'max_tokens' };
    }
    messages.push({ role: 'assistant', content: r.content });
    const results = [];
    for (const u of uses) {
      try {
        const out = await runTool(u.name, u.input);
        did.push(u.name);
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out === undefined ? null : out).slice(0, 30000) });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: u.id, content: String((e && e.message) || 'failed').slice(0, 500), is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { text: 'Остановился: слишком много шагов подряд. Скажи, что сделать дальше.', did };
}

// One message of the owner inside a session (a new session opens when there is none).
function say(chat, uid, text) {
  return inTurn(async () => {
    if (!ai.enabled()) return B.say(chat, ERR.not_declared);
    let s = await get();
    if (s && Date.now() - (+s.lastAt || 0) >= IDLE_MS) { await finish(s, 'idle'); s = null; }
    const q = String(text || '').trim().slice(0, 8000);
    if (!s) {
      s = { id: 'a' + rnd(4), chat, uid: String(uid), startedAt: Date.now(), lastAt: Date.now(), turns: [] };
      await db.kvSet(KEY, s);
      if (!q) return B.say(chat, 'Сессия с Claude открыта. Пиши как в обычном чате: я вижу проекты, могу назначать встречи, ставить и закрывать задачи.\nСессия закончится по кнопке «Завершить сессию» под ответом или после 30 минут тишины, и главное сохранится в память.');
    }
    if (!q) return B.say(chat, 'Сессия идёт. Напиши, что нужно.', endKb());
    // «печатает…» lasts a few seconds in Telegram: it is renewed while Claude thinks and works with the data
    const typing = () => T.tg('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {});
    typing();
    const beat = setInterval(typing, 4500);
    s.turns.push({ r: 'u', t: q }); s.lastAt = Date.now();
    await db.kvSet(KEY, s);
    let r;
    try { r = await answer(s); } catch (e) { console.error('[session]', e.message); r = { error: 'upstream' }; } finally { clearInterval(beat); }
    if (r.error) { s.turns.pop(); await db.kvSet(KEY, s); return B.say(chat, ERR[r.error] || 'Claude сейчас недоступен. Попробуй ещё раз чуть позже.', endKb()); }
    const out = plain(r.text) || 'Готово.';
    s.turns.push({ r: 'a', t: out.slice(0, 6000) }); s.lastAt = Date.now();
    // an old start of a long talk is dropped; the memory note is written from what is left
    while (s.turns.length > MAX_TURNS || s.turns.reduce((n, x) => n + x.t.length, 0) > MAX_CHARS) s.turns.splice(0, 2);
    await db.kvSet(KEY, s);
    for (let i = 0; i < out.length && i < 12000; i += 3900) {
      const last = i + 3900 >= Math.min(out.length, 12000);
      await T.tg('sendMessage', { chat_id: chat, text: out.slice(i, i + 3900), link_preview_options: { is_disabled: true }, reply_markup: last ? endKb() : undefined });
    }
  });
}

// The end: what is worth keeping goes to the memory, with the talk itself next to it.
async function finish(s, why) {
  await db.kvSet(KEY, {});
  const mine = s.turns.filter((x) => x.r === 'u');
  if (!mine.length) return null;
  const talk = s.turns.map((x) => (x.r === 'a' ? 'Claude: ' : 'Владелец: ') + x.t).join('\n\n');
  let title = one(mine[0].t, 80), text = '';
  const r = await ai.ask(
    'Ты ведёшь память ассистента в дэшборде проектов. Ниже разговор владельца с ассистентом в Telegram. Запиши, что из него стоит помнить в следующих сессиях: решения, договорённости, что изменено в данных, предпочтения владельца, открытые вопросы. ' +
    'Первая строка — короткий заголовок сессии (до 80 знаков). Дальше от 1 до 8 коротких пунктов, каждый с новой строки и с «- » в начале. Обычный текст. Ничего не выдумывай и не пересказывай то, что не пригодится.',
    [{ role: 'user', content: talk.slice(-MAX_CHARS) }], 700).catch(() => ({ error: 'upstream' }));
  if (r && r.text) {
    const lines = plain(r.text).split('\n').map((x) => x.trim()).filter(Boolean);
    title = one(lines[0], 80) || title;
    text = lines.slice(1).join('\n').slice(0, 2000) || one(lines[0], 600);
  } else text = 'Память не сжата: Claude был недоступен. Разговор сохранён целиком.';
  return saveMemory({ kind: 'session', title, text, turns: s.turns.length, why, started: new Date(+s.startedAt || Date.now()).toISOString(), talk: s.turns.map((x) => ({ r: x.r, t: x.t })) });
}
// why: 'button' | 'command' | 'idle'
function end(why) {
  return inTurn(async () => {
    const s = await get();
    if (!s) return { none: true };
    const d = await finish(s, why);
    return { memory: d, chat: s.chat };
  });
}
// Called every minute: a session nobody wrote to for 30 minutes is closed, and its memory saved.
async function sweep() {
  const s = await get();
  if (!s || Date.now() - (+s.lastAt || 0) < IDLE_MS) return false;
  const r = await end('idle');
  if (r && r.chat) await T.tg('sendMessage', { chat_id: r.chat, text: closedText(r.memory, true), disable_notification: true }).catch(() => {});
  return true;
}
function closedText(d, idle) {
  const head = idle ? 'Сессия с Claude закрыта: 30 минут было тихо.' : 'Сессия с Claude завершена.';
  if (!d) return head;
  return head + ' Запомнил:\n\n' + d.data.title + (d.data.text && d.data.text !== d.data.title ? '\n' + d.data.text : '') + '\n\nВсё, что в памяти: /memory';
}
let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => { sweep().catch((e) => console.error('[session]', e.message)); }, 60000);
  timer.unref();
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { init, say, end, sweep, active, notes, closedText, start, stop, IDLE_MS, KEY };
