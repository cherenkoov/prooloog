'use strict';
// End-to-end checks of the server against a real Postgres, with stand-ins for Telegram and the Claude API.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');

const PORT = 18080, BOT = '123456:TESTTOKEN', BASE = 'http://127.0.0.1:' + PORT;
const tgCalls = [], tgFiles = {}, tgMember = {};
let aiMode = 'ok';

function listen(handler) { return new Promise((res) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res(s)); }); }
function body(req) { return new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c))); }); }

let tgSrv, aiSrv, srv;

test.before(async () => {
  // Telegram stand-in: records every call, serves files the bot "received".
  tgSrv = await listen(async (req, res) => {
    const raw = await body(req);
    const m = /^\/bot[^/]+\/(\w+)/.exec(req.url);
    const f = /^\/file\/bot[^/]+\/(.+)$/.exec(req.url);
    if (f) { const b = tgFiles[decodeURIComponent(f[1])]; if (!b) { res.statusCode = 404; return res.end(); } return res.end(b); }
    if (!m) { res.statusCode = 404; return res.end(); }
    const method = m[1];
    let params = {};
    if (/multipart/.test(req.headers['content-type'] || '')) {
      const txt = raw.toString('utf8'), i = txt.indexOf('{"app"');
      params = { multipart: true, chat_id: (/name="chat_id"\r\n\r\n(\d+)/.exec(txt) || [])[1], caption: (/name="caption"\r\n\r\n([^\r]*)/.exec(txt) || [])[1], json: i >= 0 ? txt.slice(i, txt.lastIndexOf('}') + 1) : '' };
    } else { try { params = JSON.parse(raw.toString('utf8') || '{}'); } catch (e) { params = {}; } }
    tgCalls.push({ method, params });
    let result = true;
    if (method === 'getMe') result = { id: 1, is_bot: true, username: 'prooloog_test_bot' };
    if (method === 'getChatMember') {
      const st = tgMember[String(params.user_id)];
      if (st === 'error') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: member list is inaccessible' })); }
      result = { status: st || 'member', user: { id: params.user_id } };
    }
    if (method === 'sendMessage' || method === 'editMessageText' || method === 'sendDocument') result = { message_id: 1000 + tgCalls.length };
    if (method === 'getFile') result = { file_id: params.file_id, file_path: 'files/' + params.file_id, file_size: (tgFiles['files/' + params.file_id] || Buffer.alloc(0)).length };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result }));
  });
  // Claude API stand-in: one streamed answer in the documented event format.
  aiSrv = await listen(async (req, res) => {
    const raw = await body(req);
    aiSrv.last = { headers: req.headers, body: JSON.parse(raw.toString('utf8')) };
    if (aiMode === 'badkey') { res.statusCode = 401; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); }
    if (!aiSrv.last.body.stream) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ id: 'msg_2', type: 'message', role: 'assistant', model: aiSrv.last.body.model, content: [{ type: 'text', text: 'На этой неделе главное: пилот блога.' }], stop_reason: 'end_turn', usage: { input_tokens: 1200, output_tokens: 80 } }));
    }
    res.setHeader('content-type', 'text/event-stream');
    const ev = (name, data) => res.write('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n');
    ev('message_start', { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 100, output_tokens: 1 } } });
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev('ping', { type: 'ping' });
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'skip me' } });
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Привет' } });
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ', Алекс' } });
    if (aiMode === 'overloaded') ev('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    else ev('message_delta', { type: 'message_delta', delta: { stop_reason: aiMode === 'long' ? 'max_tokens' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    ev('message_stop', { type: 'message_stop' });
    res.end();
  });
  Object.assign(process.env, {
    PORT: String(PORT), DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://prooloog@127.0.0.1:54329/prooloog_test',
    BOT_TOKEN: BOT, TG_API_ROOT: 'http://127.0.0.1:' + tgSrv.address().port, APP_URL: 'https://prooloog.test',
    OWNER_USERNAME: 'Alex_Owner', SESSION_SECRET: 'test-session-secret', WEBHOOK_SECRET: 'test-hook+secret/=',
    ANTHROPIC_API_KEY: 'sk-test', AI_API_ROOT: 'http://127.0.0.1:' + aiSrv.address().port, BACKUP_DAYS: '7',
    SEED_FILE: path.join(__dirname, 'fixture-seed.json'), GROUP_ASK_MS: '0',
  });
  const db = require('../src/db');
  await db.init(process.env.DATABASE_URL);
  await db.q('DROP TABLE IF EXISTS docs, kv, members, invites, login_codes, bot_state, files, sent_reminders, invite_links');
  await db.close();
  srv = await require('../src/server').start();
  await new Promise((r) => setTimeout(r, 300));   // bot.setup() talks to the Telegram stand-in
});
test.after(async () => { await srv.stop(); tgSrv.close(); aiSrv.close(); });

/* ---------- helpers ---------- */
const cfg = () => require('../src/config');
function initData(user, ageSec = 0, token = BOT) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000) - ageSec), query_id: 'AAE', user: JSON.stringify(user), signature: 'abc' });
  const check = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}
async function call(method, url, { token, json, raw, type, headers } = {}) {
  const h = Object.assign({}, headers);
  if (token) h.authorization = 'Bearer ' + token;
  let b;
  if (json !== undefined) { b = JSON.stringify(json); h['content-type'] = 'application/json'; }
  if (raw) { b = raw; h['content-type'] = type; }
  const r = await fetch(BASE + url, { method, headers: h, body: b });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, json: j, text, headers: r.headers };
}
const OWNER = { id: 777001, first_name: 'Alex', last_name: 'Owner', username: 'alex_owner' };
const BOB = { id: 777002, first_name: 'Bob', username: 'bob_editor' };
const EVE = { id: 777003, first_name: 'Eve', username: 'eve_stranger' };
let mid = 100;
async function update(u) {
  const c = cfg();
  const r = await fetch(BASE + '/tg/' + c.webhookPath, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': c.webhookSecret }, body: JSON.stringify(u) });
  assert.equal(r.status, 200);
}
const msg = (from, extra) => ({ update_id: ++mid, message: Object.assign({ message_id: ++mid, date: Math.floor(Date.now() / 1000), chat: { id: from.id, type: 'private' }, from }, extra) });
const tap = (from, data) => ({ update_id: ++mid, callback_query: { id: 'cq' + (++mid), from, data, message: { message_id: 5000, chat: { id: from.id, type: 'private' } } } });
const lastSay = () => [...tgCalls].reverse().find((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
const sinceMark = (n, method) => tgCalls.slice(n).filter((c) => !method || c.method === method);
let ownerToken, bobToken;

/* ---------- tests ---------- */
test('page, health and the webhook lock', async () => {
  assert.equal((await call('GET', '/healthz')).text, 'ok');
  const p = await call('GET', '/');
  assert.match(p.text, /<title>Prooloog<\/title>/);
  assert.match(p.text, /telegram-web-app\.js[\s\S]*\/shim\.js[\s\S]*<\/head>/);
  assert.equal(p.headers.get('referrer-policy'), 'no-referrer');
  assert.match((await call('GET', '/shim.js')).text, /window\.claude/);
  const bad = await fetch(BASE + '/tg/' + cfg().webhookPath, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'nope' }, body: '{}' });
  assert.equal(bad.status, 404);
  assert.equal((await fetch(BASE + '/tg/wrong', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': cfg().webhookSecret }, body: '{}' })).status, 404);
  assert.match(cfg().webhookSecret, /^[A-Za-z0-9_-]+$/);
});

test('bot setup registers the webhook and commands', () => {
  const hook = tgCalls.find((c) => c.method === 'setWebhook');
  assert.ok(hook, 'setWebhook called');
  assert.equal(hook.params.url, 'https://prooloog.test/tg/' + cfg().webhookPath);
  assert.equal(hook.params.secret_token, cfg().webhookSecret);
  assert.ok(tgCalls.find((c) => c.method === 'setMyCommands'));
});

test('the first start brings in the seed data', async () => {
  const db = require('../src/db');
  assert.equal((await db.listDocs('projects')).length, 3);
  assert.ok(await db.kvGet('seeded'));
});

test('sign-in: forged data, strangers, the owner', async () => {
  assert.equal((await call('POST', '/api/auth/telegram', { json: { initData: 'user=%7B%7D&hash=00' } })).status, 401);
  assert.equal((await call('POST', '/api/auth/telegram', { json: { initData: initData(OWNER, 0, '999:OTHER') } })).status, 401, 'signed with another bot token');
  assert.equal((await call('POST', '/api/auth/telegram', { json: { initData: initData(OWNER, 90000) } })).status, 401, 'too old');
  const eve = await call('POST', '/api/auth/telegram', { json: { initData: initData(EVE) } });
  assert.equal(eve.status, 403); assert.equal(eve.json.error, 'no_access');
  const o = await call('POST', '/api/auth/telegram', { json: { initData: initData(OWNER) } });
  assert.equal(o.status, 200); assert.equal(o.json.role, 'owner'); assert.equal(o.json.user.name, 'Alex Owner'); assert.equal(o.json.caps.ai, true);
  ownerToken = o.json.token;
  // nobody else can take the owner seat afterwards, even with the same username
  const fake = await call('POST', '/api/auth/telegram', { json: { initData: initData({ id: 555, first_name: 'X', username: 'alex_owner' }) } });
  assert.equal(fake.status, 403);
  assert.equal((await call('GET', '/api/me', { token: ownerToken })).json.role, 'owner');
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/me', { token: ownerToken.slice(0, -2) + 'xx' })).status, 401);
});

test('documents: set, deep update, delete, limits', async () => {
  const t = ownerToken;
  assert.equal((await call('GET', '/api/db/projects', { token: t })).json.docs.length, 3);
  assert.equal((await call('PUT', '/api/db/posts/o1', { token: t, json: { data: { title: 'Пост', variants: { a: { text: 'x', st: 'draft' }, b: { text: 'y' } }, tags: [1, 2] } } })).json.version, 1);
  const up = await call('PATCH', '/api/db/posts/o1', { token: t, json: { data: { variants: { a: { st: 'ready' } }, tags: [3] } } });
  assert.equal(up.json.version, 2);
  const d = (await call('GET', '/api/db/posts', { token: t })).json.docs[0];
  assert.deepEqual(d.data, { title: 'Пост', variants: { a: { text: 'x', st: 'ready' }, b: { text: 'y' } }, tags: [3] });
  assert.equal((await call('PATCH', '/api/db/posts/missing', { token: t, json: { data: { a: 1 } } })).status, 404);
  assert.equal((await call('PUT', '/api/db/secrets/x', { token: t, json: { data: {} } })).status, 404);
  assert.equal((await call('PUT', '/api/db/posts/bad%20id', { token: t, json: { data: {} } })).status, 400);
  assert.equal((await call('PUT', '/api/db/posts/o2', { token: t, json: { data: [1] } })).status, 400);
  assert.equal((await call('PUT', '/api/db/posts/o2', { token: t, raw: '{"data":{"__proto__":{"polluted":1},"ok":2}}', type: 'application/json' })).status, 200);
  assert.equal(({}).polluted, undefined);
  assert.deepEqual((await call('GET', '/api/db/posts', { token: t })).json.docs.find((x) => x.id === 'o2').data, { ok: 2 });
  assert.equal((await call('PUT', '/api/db/posts/big', { token: t, json: { data: { x: 'я'.repeat(300000) } } })).status, 413);
  assert.equal((await call('DELETE', '/api/db/posts/o1', { token: t })).status, 200);
  assert.equal((await call('DELETE', '/api/db/posts/o2', { token: t })).status, 200);
  assert.equal((await call('GET', '/api/db/posts', { token: t })).json.docs.length, 0);
});

async function openStream(token) {
  const ac = new AbortController();
  const r = await fetch(BASE + '/api/stream?t=' + encodeURIComponent(token), { signal: ac.signal });
  assert.equal(r.status, 200);
  const events = [], reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '';
  (async () => { try { for (;;) { const x = await reader.read(); if (x.done) break; buf += dec.decode(x.value, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const e = (/^event: (.+)$/m.exec(b) || [])[1], d = (/^data: (.+)$/m.exec(b) || [])[1]; if (e) events.push({ event: e, data: JSON.parse(d) }); } } } catch (e) { /* aborted */ } })();
  await new Promise((r2) => setTimeout(r2, 100));
  return { events, close: () => ac.abort() };
}

test('the bot: start, strangers, one-time browser link', async () => {
  let n = tgCalls.length;
  await update(msg(EVE, { text: '/start' }));
  assert.match(lastSay().params.text, /закрытый дэшборд/);
  assert.match(lastSay().params.text, /\/invite @eve_stranger/);
  n = tgCalls.length;
  await update(msg(OWNER, { text: '/start' }));
  const start = sinceMark(n, 'sendMessage')[0];
  assert.deepEqual(start.params.reply_markup.inline_keyboard[0][0].web_app, { url: 'https://prooloog.test/' });
  assert.equal(sinceMark(n, 'setChatMenuButton')[0].params.menu_button.web_app.url, 'https://prooloog.test/');
  await update(msg(OWNER, { text: '/login' }));
  const url = lastSay().params.reply_markup.inline_keyboard[0][0].url;
  const code = /\?k=([\w-]+)$/.exec(url)[1];
  const a = await call('POST', '/api/auth/code', { json: { code } });
  assert.equal(a.status, 200); assert.equal(a.json.role, 'owner');
  assert.equal((await call('POST', '/api/auth/code', { json: { code } })).status, 401, 'the link works once');
  assert.equal((await call('POST', '/api/auth/code', { json: { code: 'x'.repeat(32) } })).status, 401);
});

test('a client reply is saved for review and the project stays untouched', async () => {
  const db = require('../src/db');
  const before = await db.getDoc('projects', 'p-india');
  const s = await openStream(ownerToken);
  // 1. everything in one message
  const u1 = msg(OWNER, { text: 'от Ravi Kumar, индия: Пришли визитку до пятницы.\nСъёмка 2 декабря.' });
  await update(u1);
  let m = await db.getDoc('messages', 'gt' + u1.message.message_id);
  assert.equal(m.data.project, 'p-india'); assert.equal(m.data.review, 'pending'); assert.equal(m.data.proposal, null);
  assert.equal(m.data.text, 'Пришли визитку до пятницы.\nСъёмка 2 декабря.'); assert.equal(m.data.from, 'Ravi Kumar');
  assert.equal(m.data.contact, 'c-ravi', 'matched the contact by name');
  assert.match(lastSay().params.text, /Кастинги в Индии[\s\S]*ждёт твоего ревью/);
  assert.equal(lastSay().params.reply_markup.inline_keyboard[0][0].web_app.url, 'https://prooloog.test/?open=msg-gt' + u1.message.message_id);
  // 2. a forwarded message: the bot asks for the project
  const u2 = msg(OWNER, { text: 'Can you send the showreel today?', forward_origin: { type: 'user', date: 1795000000, sender_user: { id: 9, first_name: 'Ravi', username: 'ravi_cast' } } });
  await update(u2);
  assert.match(lastSay().params.text, /В какой проект сохранить/);
  const keys = lastSay().params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(keys.includes('p:p-india') && keys.includes('x'));
  assert.equal(await db.getDoc('messages', 'gt' + u2.message.message_id), null, 'nothing saved before the project is chosen');
  await update(tap(OWNER, 'p:p-india'));
  m = await db.getDoc('messages', 'gt' + u2.message.message_id);
  assert.equal(m.data.from, 'Ravi'); assert.equal(m.data.contact, 'c-ravi', 'matched by Telegram username'); assert.equal(m.data.text, 'Can you send the showreel today?');
  assert.equal(lastSay().method, 'editMessageText');
  // 3. header first, then a voice message
  await update(msg(OWNER, { text: 'от Ravi, блог' }));
  assert.match(lastSay().params.text, /Жду сообщение[\s\S]*Личный блог/);
  const u3 = msg(OWNER, { voice: { file_id: 'VOICEFILE12345', duration: 14 } });
  await update(u3);
  m = await db.getDoc('messages', 'gt' + u3.message.message_id);
  assert.equal(m.data.project, 'p-blog'); assert.equal(m.data.file.kind, 'audio'); assert.equal(m.data.file.tg, 'VOICEFILE12345'); assert.equal(m.data.text, '');
  assert.match(lastSay().params.text, /аудио без расшифровки/);
  // 4. unknown project in the header
  const u4 = msg(OWNER, { text: 'от Мария, марс: привет' });
  await update(u4);
  assert.match(lastSay().params.text, /Не нашёл проект «марс»/);
  await update(tap(OWNER, 'p:p-hub'));
  m = await db.getDoc('messages', 'gt' + u4.message.message_id);
  assert.equal(m.data.project, 'p-hub'); assert.equal(m.data.from, 'Мария'); assert.equal(m.data.text, 'привет');
  // 5. a text file with the header in its caption
  tgFiles['files/TXTFILE1234567'] = Buffer.from('Первая строка письма.\nВторая строка.', 'utf8');
  const u5 = msg(OWNER, { caption: 'от Ravi, индия', document: { file_id: 'TXTFILE1234567', file_name: 'reply.txt', mime_type: 'text/plain', file_size: 60 } });
  await update(u5);
  m = await db.getDoc('messages', 'gt' + u5.message.message_id);
  assert.equal(m.data.text, 'Первая строка письма.\nВторая строка.'); assert.deepEqual(m.data.file, { kind: 'text', name: 'reply.txt' });
  // the project was never changed by any of this
  const after = await db.getDoc('projects', 'p-india');
  assert.equal(after.version, before.version); assert.deepEqual(after.data, before.data);
  // and the open dashboard heard about the new messages
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(s.events.filter((e) => e.event === 'doc' && e.data.coll === 'messages').length >= 5);
  s.close();
});

test('plain text goes to the inbox or becomes a client reply; cancel works', async () => {
  const db = require('../src/db');
  const u1 = msg(OWNER, { text: 'Ravi, блог нужен завтра' });      // looks like a header, is not one
  await update(u1);
  assert.match(lastSay().params.text, /Что сделать с этим текстом/);
  await update(tap(OWNER, 'k:i'));
  assert.equal((await db.getDoc('inbox', 'it' + u1.message.message_id)).data.text, 'Ravi, блог нужен завтра');
  const u2 = msg(OWNER, { text: 'Привет, как дела' });
  await update(u2);
  await update(tap(OWNER, 'k:m'));
  assert.match(lastSay().params.text, /В какой проект/);
  await update(tap(OWNER, 'x'));
  assert.match(lastSay().params.text, /Ничего не сохранено/);
  assert.equal(await db.getDoc('messages', 'gt' + u2.message.message_id), null);
  await update(tap(OWNER, 'p:p-india'));
  assert.match(lastSay().params.text, /нечего сохранять/);
  await update(msg(OWNER, { sticker: { file_id: 'S' } }));
  assert.match(lastSay().params.text, /Пока понимаю/);
});

test('team: invite, roles, owner-only data, removal', async () => {
  await update(msg(OWNER, { text: '/invite @Bob_Editor editor' }));
  assert.match(lastSay().params.text, /Пригласил @Bob_Editor как редактора/);
  const b = await call('POST', '/api/auth/telegram', { json: { initData: initData(BOB) } });
  assert.equal(b.json.role, 'editor'); bobToken = b.json.token;
  assert.equal((await call('PUT', '/api/db/tasks/t1', { token: bobToken, json: { data: { title: 'Задача Боба' } } })).status, 200);
  assert.equal((await call('GET', '/api/db/money', { token: bobToken })).status, 403);
  assert.equal((await call('GET', '/api/db/messages', { token: bobToken })).status, 403);
  assert.equal((await call('PUT', '/api/db/subs/s1', { token: bobToken, json: { data: { title: 'x' } } })).status, 403);
  assert.equal((await call('GET', '/api/export', { token: bobToken })).status, 403);
  // live updates: Bob never hears about owner-only collections
  const sb = await openStream(bobToken), so = await openStream(ownerToken);
  await call('PUT', '/api/db/money/m1', { token: ownerToken, json: { data: { amount: 5 } }, headers: { 'x-client': 'tab-1' } });
  await call('PUT', '/api/db/tasks/t2', { token: ownerToken, json: { data: { title: 'Общая' } }, headers: { 'x-client': 'tab-1' } });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(sb.events.map((e) => e.data.coll), ['tasks']);
  assert.deepEqual(so.events.map((e) => e.data.coll), ['money', 'tasks']);
  assert.equal(so.events[0].data.src, 'tab-1');
  sb.close(); so.close();
  // Bob's messages to the bot are not client replies
  await update(msg(BOB, { text: 'от Ravi, индия: тест' }));
  assert.match(lastSay().params.text, /только от владельца/);
  await update(msg(BOB, { text: '/backup' }));
  assert.match(lastSay().params.text, /только владельцу/);
  // viewer
  await update(msg(OWNER, { text: '/invite @eve_stranger' }));
  const e = await call('POST', '/api/auth/telegram', { json: { initData: initData(EVE) } });
  assert.equal(e.json.role, 'viewer');
  assert.equal((await call('PUT', '/api/db/tasks/t3', { token: e.json.token, json: { data: { title: 'x' } } })).status, 403);
  assert.equal((await call('GET', '/api/db/tasks', { token: e.json.token })).status, 200);
  await update(msg(OWNER, { text: '/members' }));
  assert.match(lastSay().params.text, /Bob[\s\S]*редактор[\s\S]*Eve[\s\S]*зритель/);
  await update(msg(OWNER, { text: '/remove @bob_editor' }));
  assert.equal((await call('GET', '/api/db/tasks', { token: bobToken })).status, 403, 'removed member loses access at once');
});

test('pictures: upload and public link', async () => {
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const up = await call('POST', '/api/files', { token: ownerToken, raw: jpg, type: 'image/jpeg' });
  assert.match(up.json.url, /^\/f\/[\w-]+$/);
  const r = await fetch(BASE + up.json.url);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), jpg);
  assert.equal((await call('POST', '/api/files', { token: ownerToken, raw: Buffer.from('<svg/>'), type: 'image/svg+xml' })).status, 400);
  assert.equal((await call('POST', '/api/files', { raw: jpg, type: 'image/jpeg' })).status, 401);
});

test('voice from Telegram is served to the owner only', async () => {
  tgFiles['files/VOICEFILE12345'] = Buffer.from('OggS-fake-audio');
  const r = await fetch(BASE + '/api/tg/file/VOICEFILE12345?t=' + encodeURIComponent(ownerToken));
  assert.equal(r.status, 200); assert.equal(Buffer.from(await r.arrayBuffer()).toString(), 'OggS-fake-audio');
  assert.equal((await fetch(BASE + '/api/tg/file/VOICEFILE12345')).status, 401);
});

test('backup to the chat and restore from the file', async () => {
  const db = require('../src/db');
  let n = tgCalls.length;
  await update(msg(OWNER, { text: '/backup' }));
  const doc = sinceMark(n, 'sendDocument')[0];
  assert.ok(doc, 'backup file sent'); assert.equal(doc.params.chat_id, String(OWNER.id));
  const backup = JSON.parse(doc.params.json);
  assert.equal(backup.app, 'prooloog'); assert.ok(backup.docs.messages && backup.docs.projects['p-india']);
  // change data after the backup, then restore
  await call('PUT', '/api/db/tasks/after-backup', { token: ownerToken, json: { data: { title: 'лишняя' } } });
  await call('DELETE', '/api/db/projects/p-blog', { token: ownerToken });
  tgFiles['files/BACKUPFILE12345'] = Buffer.from(doc.params.json, 'utf8');
  const s = await openStream(ownerToken);
  await update(msg(OWNER, { caption: '/restore', document: { file_id: 'BACKUPFILE12345', file_name: 'prooloog-backup-2026-11-18.json', mime_type: 'application/json', file_size: 1000 } }));
  assert.match(lastSay().params.text, /будут заменены/);
  assert.equal(await db.getDoc('projects', 'p-blog'), null, 'nothing changes before confirmation');
  await update(tap(OWNER, 'rs:y'));
  assert.match(lastSay().params.text, /данные заменены/);
  assert.ok(await db.getDoc('projects', 'p-blog'));
  assert.equal(await db.getDoc('tasks', 'after-backup'), null);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(s.events.some((e) => e.event === 'reload'));
  s.close();
  // not a backup
  tgFiles['files/JUNKFILE1234567'] = Buffer.from('{"hello":1}');
  await update(msg(OWNER, { caption: '/restore', document: { file_id: 'JUNKFILE1234567', file_name: 'x.json', mime_type: 'application/json', file_size: 11 } }));
  assert.match(lastSay().params.text, /не похоже на копию/);
  // export and import over the API
  const ex = await call('GET', '/api/export', { token: ownerToken });
  assert.equal(ex.json.app, 'prooloog');
  const imp = await call('POST', '/api/import', { token: ownerToken, json: { app: 'prooloog', docs: { inbox: { i9: { text: 'из импорта' } } }, mode: 'merge' } });
  assert.equal(imp.json.imported, 1);
  assert.ok(await db.getDoc('projects', 'p-india'), 'merge keeps the rest');
});

test('a deletion leaves a mark for later merges', async () => {
  assert.equal((await call('PUT', '/api/db/tasks/t-gone-1', { token: ownerToken, json: { data: { title: 'to delete', project: 'p-a', u: '2026-11-18T10:00:00.000Z' } } })).status, 200);
  assert.equal((await call('DELETE', '/api/db/tasks/t-gone-1', { token: ownerToken })).status, 200);
  const marks = (await call('GET', '/api/db/gone', { token: ownerToken })).json.docs;
  const m = marks.find((x) => x.id === 'tasks-t-gone-1');
  assert.ok(m, 'mark exists');
  assert.equal(m.data.c, 'tasks'); assert.equal(m.data.i, 't-gone-1'); assert.ok(m.data.at > '2026-11-18T10:00:00.000Z');
  // deleting something that is not there leaves nothing
  await call('DELETE', '/api/db/tasks/t-never-was', { token: ownerToken });
  assert.ok(!(await call('GET', '/api/db/gone', { token: ownerToken })).json.docs.some((x) => x.id === 'tasks-t-never-was'));
  // marks are the owner's only: Eve is a viewer
  const eve = await call('POST', '/api/auth/telegram', { json: { initData: initData(EVE) } });
  assert.equal(eve.json.role, 'viewer');
  assert.equal((await call('GET', '/api/db/gone', { token: eve.json.token })).status, 403);
});

test('the dashboard can ask the bot to send the copy to the chat', async () => {
  const n = tgCalls.length;
  assert.equal((await call('POST', '/api/backup/send', { token: ownerToken })).status, 200);
  const doc = sinceMark(n, 'sendDocument')[0];
  assert.equal(doc.params.chat_id, String(OWNER.id));
  assert.equal(JSON.parse(doc.params.json).app, 'prooloog');
  assert.equal((await call('POST', '/api/backup/send', {})).status, 401);
});

test('scheduled backup: once the period has passed', async () => {
  const db = require('../src/db'), bot = require('../src/bot');
  await db.kvSet('last_backup', { at: Date.now() - 8 * 864e5 });
  const n = tgCalls.length;
  await bot.maybeBackup();
  assert.equal(sinceMark(n, 'sendDocument').length, 1);
  await bot.maybeBackup();
  assert.equal(sinceMark(n, 'sendDocument').length, 1, 'not again until the next period');
});

test('Claude answers through the server', async () => {
  aiMode = 'ok';
  const r = await call('POST', '/api/ai', { token: ownerToken, json: { input: [{ role: 'user', content: 'Контекст' }, { role: 'user', content: 'Вопрос' }] } });
  assert.equal(r.status, 200);
  const lines = r.text.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ d: 'Привет' }, { d: ', Алекс' }, { done: true, truncated: false }]);
  assert.equal(aiSrv.last.headers.authorization, 'Bearer sk-test');
  assert.equal(aiSrv.last.headers['anthropic-version'], '2026-10-21');
  assert.equal(aiSrv.last.body.stream, true);
  assert.deepEqual(aiSrv.last.body.messages, [{ role: 'user', content: 'Контекст\n\nВопрос' }]);
  aiMode = 'long';
  assert.deepEqual(JSON.parse((await call('POST', '/api/ai', { token: ownerToken, json: { input: 'Привет' } })).text.trim().split('\n').pop()), { done: true, truncated: true });
  aiMode = 'overloaded';
  assert.deepEqual(JSON.parse((await call('POST', '/api/ai', { token: ownerToken, json: { input: 'Привет' } })).text.trim().split('\n').pop()), { error: 'upstream' });
  aiMode = 'badkey';
  const bad = await call('POST', '/api/ai', { token: ownerToken, json: { input: 'Привет' } });
  assert.equal(bad.status, 502); assert.equal(bad.json.error, 'not_granted');
  assert.equal((await call('POST', '/api/ai', { token: ownerToken, json: { input: '' } })).status, 400);
  assert.equal((await call('POST', '/api/ai', { json: { input: 'x' } })).status, 401);
});

test('Claude usage is counted per day, with a cost estimate', async () => {
  await new Promise((r) => setTimeout(r, 150));
  const days = (await call('GET', '/api/db/usage', { token: ownerToken })).json.docs;
  assert.equal(days.length, 1);
  const u = days[0].data;
  assert.ok(u.n >= 1 && u.by.page.n === u.n, 'page requests are counted');
  assert.equal(u.in, 100 * u.n); assert.ok(u.out >= u.n);
  assert.ok(Math.abs(u.cost - (u.in * 2 + u.out * 10) / 1e6) < 1e-9, 'cost by the price list of the model');
  assert.equal(u.models['claude-sonnet-5-5'], u.n);
});

test('the bot answers a question with the dashboard in view', async () => {
  aiMode = 'ok';
  await call('PUT', '/api/db/projects/p-ask', { token: ownerToken, json: { data: { name: 'Проект для вопроса', status: 'active', order: 1 } } });
  await update(msg(OWNER, { text: '/ask Что у меня на этой неделе?' }));
  assert.equal(lastSay().params.text, 'На этой неделе главное: пилот блога.');
  const sent = aiSrv.last.body;
  assert.equal(sent.stream, undefined);
  assert.match(sent.system, /ДАННЫЕ ДЭШБОРДА[\s\S]*Проект для вопроса/);
  assert.equal(sent.messages[sent.messages.length - 1].content, 'Что у меня на этой неделе?');
  // the next question carries the short history
  await update(msg(OWNER, { text: '/ask А потом?' }));
  assert.equal(aiSrv.last.body.messages.length, 3);
  await new Promise((r) => setTimeout(r, 150));
  const u = (await call('GET', '/api/db/usage', { token: ownerToken })).json.docs[0].data;
  assert.equal(u.by.bot.n, 2); assert.equal(u.by.bot.in, 2400);
  await update(msg(OWNER, { text: '/usage' }));
  assert.match(lastSay().params.text, /запросов \d+[\s\S]*\$/);
  // «/ask» without a question waits for the next message
  await update(msg(OWNER, { text: '/ask' }));
  assert.match(lastSay().params.text, /Напиши вопрос/);
  await update(msg(OWNER, { text: 'Сколько открытых задач?' }));
  assert.equal(aiSrv.last.body.messages[aiSrv.last.body.messages.length - 1].content, 'Сколько открытых задач?');
  // a bad key is explained, not hidden
  aiMode = 'badkey';
  await update(msg(OWNER, { text: '/ask ещё вопрос' }));
  assert.match(lastSay().params.text, /не принял ключ/);
  aiMode = 'ok';
});

test('connector for Claude: address from the bot, tools, review rule, merge', async () => {
  await update(msg(EVE, { text: '/connect' }));
  assert.match(lastSay().params.text, /только владельцу/);
  await update(msg(OWNER, { text: '/connect' }));
  const url = /<code>(https:\/\/prooloog\.test\/mcp\/[A-Za-z0-9_-]{20,})<\/code>/.exec(lastSay().params.text);
  assert.ok(url, 'the owner gets the address');
  const pathOf = (u) => u.replace('https://prooloog.test', '');
  const rpc = (p, method, params, id = 1) => call('POST', p, { json: { jsonrpc: '2.0', id, method, params }, headers: { accept: 'application/json, text/event-stream' } });
  const mp = pathOf(url[1]);
  assert.equal((await rpc('/mcp/wrong-token-wrong-token-wrong', 'tools/list')).status, 404);
  assert.equal((await call('GET', mp)).status, 405);
  const init = await rpc(mp, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.json.result.protocolVersion, '2025-06-18');
  assert.ok(init.json.result.capabilities.tools);
  assert.equal((await rpc(mp, 'initialize', { protocolVersion: '2099-01-01' })).json.result.protocolVersion, '2025-06-18');
  assert.equal((await call('POST', mp, { json: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status, 202);
  const tools = (await rpc(mp, 'tools/list')).json.result.tools.map((t) => t.name);
  assert.deepEqual(tools, ['status', 'list', 'get', 'write', 'add_message', 'sync']);
  const tool = async (name, args) => { const r = await rpc(mp, 'tools/call', { name, arguments: args }); return { err: !!r.json.result.isError, v: r.json.result.isError ? r.json.result.content[0].text : JSON.parse(r.json.result.content[0].text) }; };
  const st = await tool('status', {});
  assert.ok(st.v.records.projects >= 1 && /^\d{4}-\d{2}-\d{2}$/.test(st.v.today));
  assert.ok((await tool('list', { collection: 'projects' })).v.records.some((r) => r.id === 'p-ask'));
  assert.equal((await tool('list', { collection: 'nope' })).err, true);
  // direct changes: set, merge, delete with a mark
  const w = await tool('write', { ops: [{ op: 'set', collection: 'tasks', id: 't-mcp', data: { title: 'Из Claude', project: 'p-ask', status: 'todo' } }, { op: 'merge', collection: 'tasks', id: 't-mcp', data: { due: '2026-11-20' } }] });
  assert.equal(w.err, false);
  const got = await tool('get', { collection: 'tasks', id: 't-mcp' });
  assert.equal(got.v.data.title, 'Из Claude'); assert.equal(got.v.data.due, '2026-11-20'); assert.ok(got.v.data.u);
  await tool('write', { ops: [{ op: 'delete', collection: 'tasks', id: 't-mcp' }] });
  assert.equal((await tool('get', { collection: 'tasks', id: 't-mcp' })).v.missing, true);
  assert.ok((await tool('get', { collection: 'gone', id: 'tasks-t-mcp' })).v.data.at);
  // a client message waits for review, the project stays as it was
  const before = (await tool('get', { collection: 'projects', id: 'p-ask' })).v.data;
  const am = await tool('add_message', { project: 'p-ask', from: 'Наташа', text: 'Давайте созвонимся завтра', items: [{ t: 'next', to: 'Созвон с Наташей' }, { bad: 1 }] });
  const m = (await tool('get', { collection: 'messages', id: am.v.saved.id })).v.data;
  assert.equal(m.review, 'pending'); assert.equal(m.proposal.items.length, 1); assert.equal(m.src, 'claude');
  assert.deepEqual((await tool('get', { collection: 'projects', id: 'p-ask' })).v.data, before);
  assert.equal((await tool('add_message', { project: 'p-none', text: 'x' })).err, true);
  // merge: the fresher record wins, a deletion mark deletes, an older copy changes nothing
  await tool('write', { ops: [{ op: 'set', collection: 'tasks', id: 't-old', data: { title: 'Здесь свежее', project: 'p-ask' } }, { op: 'set', collection: 'tasks', id: 't-del', data: { title: 'Удалят с той стороны', project: 'p-ask' } }] });
  const sy = await tool('sync', { docs: {
    tasks: { 't-new': { title: 'Новая с той стороны', project: 'p-ask', u: '2026-11-18T10:00:00.000Z' }, 't-old': { title: 'Там старее', project: 'p-ask', u: '2020-01-01T00:00:00.000Z' }, 'bad id!': { title: 'x' } },
    gone: { 'tasks-t-del': { c: 'tasks', i: 't-del', at: '2099-01-01T00:00:00.000Z', u: '2099-01-01T00:00:00.000Z' } },
    nope: { a: { b: 1 } },
  } });
  assert.deepEqual(sy.v.changedHere, { added: 1, updated: 0, deleted: 1, kept: 1 });
  assert.equal(sy.v.docs.tasks['t-new'].title, 'Новая с той стороны');
  assert.equal(sy.v.docs.tasks['t-old'].title, 'Здесь свежее');
  assert.equal(sy.v.docs.tasks['t-del'], undefined);
  assert.ok(sy.v.docs.gone['tasks-t-del']);
  // a new address switches the old one off
  await update(msg(OWNER, { text: '/connect new' }));
  assert.equal((await rpc(mp, 'tools/list')).status, 404);
});

test('reminders: rules of the event, the call link, a participant with rules of their own', async () => {
  const remind = require('../src/remind'), clock = require('../src/clock');
  await call('PUT', '/api/db/settings/main', { token: ownerToken, json: { data: { capacity: 40, tz: 'Asia/Kolkata' } } });
  clock.forget();
  await call('PUT', '/api/db/events/e-rem', { token: ownerToken, json: { data: { title: 'Созвон с Наташей', project: 'p-ask', date: '2026-12-01', time: '10:00', rem: [60, 15], link: 'https://zoom.us/j/123', share: 'sharetoken123456' } } });
  const start = clock.wallToMs('2026-12-01', '10:00', 'Asia/Kolkata');
  assert.equal(new Date(start).toISOString(), '2026-12-01T04:30:00.000Z');
  const texts = (n) => sinceMark(n, 'sendMessage').map((c) => [String(c.params.chat_id), c.params.text]);
  let n = tgCalls.length;
  assert.equal(await remind.tick(start - 61 * 60000), 0, 'too early');
  assert.equal(await remind.tick(start - 60 * 60000 + 1000), 1);
  assert.match(texts(n)[0][1], /Через 1 час: <b>Созвон с Наташей<\/b>[\s\S]*1 дек, 10:00 · Проект для вопроса[\s\S]*zoom\.us/);
  assert.equal(texts(n)[0][0], String(OWNER.id));
  assert.equal(await remind.tick(start - 60 * 60000 + 30000), 0, 'never twice');
  // a participant opens the bot by the link of the event
  n = tgCalls.length;
  await update(msg(EVE, { text: '/start ev_sharetoken123456' }));
  assert.match(lastSay().params.text, /Созвон с Наташей[\s\S]*1 дек, 10:00 \(UTC\+5:30\)[\s\S]*за 5 минут/);
  let sub = (await call('GET', '/api/db/evsubs', { token: ownerToken })).json.docs.find((x) => x.data.event === 'e-rem');
  assert.deepEqual(sub.data.rem, [5]); assert.equal(sub.data.tg, String(EVE.id));
  await update(tap(EVE, 'er:e-rem:15'));
  sub = (await call('GET', '/api/db/evsubs', { token: ownerToken })).json.docs.find((x) => x.data.event === 'e-rem');
  assert.deepEqual(sub.data.rem, [15, 5]);
  await update(msg(EVE, { text: '/start ev_nosuchtoken000000' }));
  assert.match(lastSay().params.text, /больше не действует/);
  // 15 minutes before: the owner and the participant; 5 minutes before: the link goes to both
  n = tgCalls.length;
  assert.equal(await remind.tick(start - 15 * 60000 + 2000), 2);
  assert.deepEqual(texts(n).map((x) => x[0]).sort(), [String(OWNER.id), String(EVE.id)].sort());
  assert.match(texts(n).find((x) => x[0] === String(EVE.id))[1], /Через 15 минут[\s\S]*\(UTC\+5:30\)[\s\S]*zoom\.us/);
  n = tgCalls.length;
  assert.equal(await remind.tick(start - 5 * 60000 + 2000), 2);
  assert.match(texts(n)[0][1], /Через 5 минут[\s\S]*Ссылка: https:\/\/zoom\.us\/j\/123/);
  assert.equal(await remind.tick(start + 11 * 60000), 0, 'nothing after the start');
  // a daily event without rules and without a link stays silent; with a rule it fires every day
  await call('PUT', '/api/db/events/e-day', { token: ownerToken, json: { data: { title: 'Эфир', date: '2026-12-01', time: '08:00', repeat: 'daily', rem: [10] } } });
  const d2 = clock.wallToMs('2026-12-03', '08:00', 'Asia/Kolkata');
  n = tgCalls.length;
  assert.equal(await remind.tick(d2 - 10 * 60000 + 1000), 1);
  assert.match(texts(n)[0][1], /Через 10 минут: <b>Эфир<\/b>\n3 дек, 08:00/);
  assert.equal(remind.before(2880), 'Через 2 дня'); assert.equal(remind.before(90), 'Через 90 минут');
  assert.deepEqual(remind.rules([5, '15', 5, 0, 99999, 60]), [60, 15, 5]);
  await call('PUT', '/api/db/settings/main', { token: ownerToken, json: { data: { capacity: 40 } } });
  clock.forget();
});

test('invite link: access to chosen projects at a chosen level', async () => {
  const CAROL = { id: 777006, first_name: 'Carol', username: 'carol_guest' }, DAN = { id: 777007, first_name: 'Dan', username: 'dan_guest' };
  const put = (path, data, token = ownerToken) => call('PUT', '/api/db/' + path, { token, json: { data } });
  await put('projects/p-a2', { name: 'Открытый проект', status: 'active', order: 50 });
  await put('projects/p-b2', { name: 'Закрытый проект', status: 'active', order: 51 });
  await put('tasks/ta-1', { title: 'В открытом', project: 'p-a2' });
  await put('tasks/tb-1', { title: 'В закрытом', project: 'p-b2' });
  await put('inbox/in-free', { text: 'Мысль без проекта' });
  // only the owner makes links; a link needs real projects
  assert.equal((await call('POST', '/api/share/links', { token: ownerToken, json: { role: 'viewer', projects: ['nope'] } })).status, 400);
  const link = await call('POST', '/api/share/links', { token: ownerToken, json: { role: 'viewer', projects: ['p-a2', 'nope'] } });
  assert.equal(link.status, 200); assert.deepEqual(link.json.projects, ['p-a2']);
  assert.match(link.json.url, /^https:\/\/t\.me\/prooloog_test_bot\?start=inv_[A-Za-z0-9_-]{16,}$/);
  const share0 = (await call('GET', '/api/share', { token: ownerToken })).json;
  assert.ok(share0.links.some((l) => l.token === link.json.token && l.url === link.json.url));
  // the owner opening his own link changes nothing; a guest gets in
  await update(msg(OWNER, { text: '/start inv_' + link.json.token }));
  assert.match(lastSay().params.text, /собственная ссылка/);
  let n = tgCalls.length;
  await update(msg(CAROL, { text: '/start inv_' + link.json.token }));
  const said = sinceMark(n, 'sendMessage').map((c) => [String(c.params.chat_id), c.params.text]);
  assert.match(said.find((x) => x[0] === String(CAROL.id))[1], /открыт доступ[\s\S]*Открытый проект[\s\S]*можно смотреть/);
  assert.match(said.find((x) => x[0] === String(OWNER.id))[1], /Carol[\s\S]*открыл приглашение[\s\S]*зритель/);
  await update(msg(DAN, { text: '/start inv_' + link.json.token }));
  assert.match(lastSay().params.text, /уже использована/);
  assert.equal((await call('POST', '/api/auth/telegram', { json: { initData: initData(DAN) } })).status, 403);
  // Carol sees one project and what belongs to it
  const c = await call('POST', '/api/auth/telegram', { json: { initData: initData(CAROL) } });
  assert.equal(c.json.role, 'viewer'); assert.deepEqual(c.json.projects, ['p-a2']);
  const ct = c.json.token, ids = async (coll) => (await call('GET', '/api/db/' + coll, { token: ct })).json.docs.map((d) => d.id);
  assert.deepEqual(await ids('projects'), ['p-a2']);
  assert.deepEqual(await ids('tasks'), ['ta-1']);
  assert.deepEqual(await ids('inbox'), []);
  assert.equal((await call('GET', '/api/db/settings', { token: ct })).status, 200);
  assert.equal((await call('GET', '/api/db/money', { token: ct })).status, 403);
  assert.equal((await put('tasks/ta-2', { title: 'x', project: 'p-a2' }, ct)).status, 403, 'a viewer never writes');
  assert.equal((await call('GET', '/api/share', { token: ct })).status, 403);
  // the owner raises her to editor of the same project
  assert.equal((await call('PATCH', '/api/share/members/' + CAROL.id, { token: ownerToken, json: { role: 'editor', projects: ['p-a2'] } })).status, 200);
  assert.equal((await put('tasks/ta-2', { title: 'От Carol', project: 'p-a2' }, ct)).status, 200);
  assert.equal((await put('tasks/tb-2', { title: 'Чужое', project: 'p-b2' }, ct)).status, 403);
  assert.equal((await put('tasks/ta-3', { title: 'Без проекта' }, ct)).status, 403);
  assert.equal((await call('PATCH', '/api/db/tasks/ta-2', { token: ct, json: { data: { project: 'p-b2' } } })).status, 403, 'cannot move a record out');
  assert.equal((await call('PATCH', '/api/db/tasks/tb-1', { token: ct, json: { data: { title: 'взлом' } } })).status, 403);
  assert.equal((await call('DELETE', '/api/db/tasks/tb-1', { token: ct })).status, 403);
  assert.equal((await put('projects/p-new', { name: 'Новый' }, ct)).status, 403);
  assert.equal((await call('DELETE', '/api/db/projects/p-a2', { token: ct })).status, 403);
  assert.equal((await call('PATCH', '/api/db/projects/p-a2', { token: ct, json: { data: { next: 'Шаг от Carol' } } })).status, 200);
  assert.equal((await call('PATCH', '/api/db/settings/main', { token: ct, json: { data: { capacity: 1 } } })).status, 403);
  assert.equal((await put('tasks/ta-2', { title: 'Проект потерялся' }, ct)).status, 403, 'a full rewrite cannot drop the project');
  // live updates follow the same border: nothing about other projects, not even an id
  const wait = () => new Promise((r) => setTimeout(r, 150));
  const docs = (st) => st.events.filter((e) => e.event === 'doc').map((e) => [e.data.coll, e.data.id, e.data.data && e.data.data.title]);
  const sc = await openStream(ct);
  await put('tasks/tb-3', { title: 'Закрытая новость', project: 'p-b2' });
  await put('tasks/ta-4', { title: 'Открытая новость', project: 'p-a2' });
  await put('projects/p-b2', { name: 'Закрытый проект', status: 'paused', order: 51 });
  await call('DELETE', '/api/db/tasks/tb-3', { token: ownerToken });
  await call('PATCH', '/api/db/tasks/ta-4', { token: ownerToken, json: { data: { project: 'p-b2' } } });
  await wait();
  assert.deepEqual(docs(sc), [['tasks', 'ta-4', 'Открытая новость'], ['tasks', 'ta-4', null]], 'a record that leaves her project is taken away, the rest is silence');
  // the list for the owner
  const share = (await call('GET', '/api/share', { token: ownerToken })).json;
  const row = share.members.find((m) => m.id === String(CAROL.id));
  assert.equal(row.role, 'editor'); assert.deepEqual(row.projects, ['p-a2']);
  assert.ok(!share.links.some((l) => l.token === link.json.token), 'a used link is gone from the list');
  // the owner moves her to the other project as a viewer: the open stream follows at once
  assert.equal((await call('PATCH', '/api/share/members/' + CAROL.id, { token: ownerToken, json: { role: 'viewer', projects: ['p-b2'] } })).status, 200);
  await put('tasks/ta-5', { title: 'Уже не её', project: 'p-a2' });
  await put('tasks/tb-4', { title: 'Теперь её', project: 'p-b2' });
  await wait();
  assert.ok(sc.events.some((e) => e.event === 'reload'), 'her page is told to load again');
  assert.deepEqual(docs(sc).slice(2), [['tasks', 'tb-4', 'Теперь её']]);
  assert.deepEqual(await ids('projects'), ['p-b2']);
  assert.equal((await put('tasks/tb-5', { title: 'x', project: 'p-b2' }, ct)).status, 403, 'a viewer again');
  // a second link adds projects and the higher level
  const l3 = await call('POST', '/api/share/links', { token: ownerToken, json: { role: 'editor', projects: ['p-a2'] } });
  await update(msg(CAROL, { text: '/start inv_' + l3.json.token }));
  assert.deepEqual((await ids('projects')).sort(), ['p-a2', 'p-b2']);
  assert.equal((await call('GET', '/api/me', { token: ct })).json.role, 'editor');
  await update(msg(OWNER, { text: '/members' }));
  assert.match(lastSay().params.text, /Carol[\s\S]*редактор, (Открытый проект, Закрытый проект|Закрытый проект, Открытый проект)/);
  // an invitation by name shows up next to the links and can be taken back
  await update(msg(OWNER, { text: '/invite @late_guest viewer' }));
  assert.deepEqual((await call('GET', '/api/share', { token: ownerToken })).json.names, [{ username: 'late_guest', role: 'viewer' }]);
  assert.equal((await call('DELETE', '/api/share/names/late_guest', { token: ownerToken })).json.ok, true);
  assert.deepEqual((await call('GET', '/api/share', { token: ownerToken })).json.names, []);
  // the door closes: the stream ends, the token opens nothing
  const before = sc.events.length;
  assert.equal((await call('DELETE', '/api/share/members/' + CAROL.id, { token: ownerToken })).status, 200);
  await put('tasks/tb-6', { title: 'После закрытия', project: 'p-b2' });
  await wait();
  assert.deepEqual(sc.events.slice(before).map((e) => e.event), ['reload'], 'one last word, then nothing');
  sc.close();
  assert.equal((await call('GET', '/api/db/tasks', { token: ct })).status, 403);
  assert.equal((await call('GET', '/api/stream?t=' + encodeURIComponent(ct))).status, 403);
  // an unused link can be taken back
  const l2 = await call('POST', '/api/share/links', { token: ownerToken, json: { role: 'editor', projects: null } });
  assert.equal(l2.json.projects, null);
  assert.equal((await call('DELETE', '/api/share/links/' + l2.json.token, { token: ownerToken })).json.ok, true);
  await update(msg(DAN, { text: '/start inv_' + l2.json.token }));
  assert.match(lastSay().params.text, /уже использована или устарела/);
});

test('work chat: tied to a project, collects for review, answers on buttons, lets members look', async () => {
  const remind = require('../src/remind'), clock = require('../src/clock');
  const GID = -1001234500001, CH = 'g1001234500001', chat = { id: GID, type: 'supergroup', title: 'Команда EcoChakra' };
  const NAT = { id: 777101, first_name: 'Наташа', username: 'natakhas_t' }, PETR = { id: 777102, first_name: 'Пётр' };
  const sec = () => Math.floor(Date.now() / 1000);
  const gmsg = (from, extra, c) => ({ update_id: ++mid, message: Object.assign({ message_id: ++mid, date: sec(), chat: c || chat, from }, extra) });
  const gtap = (from, data, c) => ({ update_id: ++mid, callback_query: { id: 'cq' + (++mid), from, data, message: { message_id: 7000, chat: c || chat } } });
  const member = (c, from, status) => ({ update_id: ++mid, my_chat_member: { chat: c, from, date: sec(), old_chat_member: { status: 'left', user: { id: 1, is_bot: true } }, new_chat_member: { status, user: { id: 1, is_bot: true } } } });
  const said = (n, chatId) => sinceMark(n).filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && String(c.params.chat_id) === String(chatId));
  const put = (path, data) => call('PUT', '/api/db/' + path, { token: ownerToken, json: { data } });
  const patch = (path, data) => call('PATCH', '/api/db/' + path, { token: ownerToken, json: { data } });
  const docs = async (coll) => (await call('GET', '/api/db/' + coll, { token: ownerToken })).json.docs;
  const kept = async (prefix) => (await docs('messages')).filter((d) => d.data.src === 'chat' && d.id.startsWith(prefix)).sort((a, b) => a.id.localeCompare(b.id));
  const cbs = (c) => c.params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  await put('projects/p-eco', { name: 'EcoChakra', status: 'active', order: 60, next: 'Созвон с Наташей' });
  await put('tasks/t-eco-1', { title: 'Карта участников', project: 'p-eco', status: 'doing', due: '2031-01-15', order: 1 });
  await put('tasks/t-eco-2', { title: 'Анкета в Google Forms', project: 'p-eco', status: 'todo', order: 2 });
  await put('tasks/t-eco-3', { title: 'Готовая задача', project: 'p-eco', status: 'done', order: 3 });
  await put('milestones/m-eco-1', { title: 'Запуск бота сообщества', project: 'p-eco', date: '2031-02-10', done: false, order: 1 });
  const tasksBefore = (await docs('tasks')).length;

  // someone adds the bot: nothing in the chat, a question to the owner
  let n = tgCalls.length;
  await update(member(chat, NAT, 'member'));
  assert.equal(said(n, GID).length, 0);
  const ask = said(n, OWNER.id)[0];
  assert.match(ask.params.text, /Меня добавили в чат <b>Команда EcoChakra<\/b> \(добавил Наташа\)[\s\S]*молчу и ничего не сохраняю/);
  assert.ok(cbs(ask).includes('gl:' + CH + ':p-eco') && cbs(ask).includes('gl:' + CH + ':-'));
  // not tied to a project: neither saved nor answered
  await update(gmsg(NAT, { text: 'Всем привет' }));
  await update(gmsg(NAT, { text: '/project' }));
  assert.equal(said(n, GID).length, 0);
  assert.equal((await kept('g')).length, 0);
  // only the owner ties a chat to a project
  await update(tap(NAT, 'gl:' + CH + ':p-eco'));
  assert.equal((await docs('chats')).find((d) => d.id === CH).data.project, '');
  n = tgCalls.length;
  await update(tap(OWNER, 'gl:' + CH + ':p-eco'));
  const hello = said(n, GID)[0];
  assert.match(hello.params.text, /помогаю вести проект <b>EcoChakra<\/b>[\s\S]*то, что адресовано мне[\s\S]*видит только Alex[\s\S]*\/project[\s\S]*\/task/, 'says honestly what it keeps and for whom');
  assert.deepEqual(cbs(hello), ['gp:new', 'gp:sug']);
  assert.ok(said(n, OWNER.id).some((c) => /сделай меня администратором/.test(c.params.text)), 'the owner learns how to let it see everything');
  let ch = (await docs('chats')).find((d) => d.id === CH).data;
  assert.deepEqual([ch.project, ch.collect, ch.read, ch.app, ch.remind, ch.on, ch.tg], ['p-eco', 'all', true, false, false, true, String(GID)]);
  assert.equal((await call('GET', '/api/db/chats', { token: bobToken })).status, 403, 'chats are the owner\'s');
  // made an administrator: it now sees everything and says so
  n = tgCalls.length;
  await update(member(chat, OWNER, 'administrator'));
  assert.match(said(n, GID)[0].params.text, /Теперь я вижу все сообщения этого чата/);

  // what is said is kept in one record per day, waiting for review; nothing is answered, the project is untouched
  n = tgCalls.length;
  await update(gmsg(NAT, { text: 'Давайте созвонимся в четверг' }));
  await update(gmsg(PETR, { text: 'Я за', reply_to_message: { message_id: 1, from: NAT, text: 'Давайте созвонимся в четверг' } }));
  await update(gmsg(NAT, { voice: { file_id: 'voice-1', duration: 42 } }));
  await update(gmsg({ id: 5, is_bot: true, first_name: 'OtherBot' }, { text: 'реклама' }));
  let dg = await kept('gc');
  assert.equal(dg.length, 1);
  const d0 = dg[0].data, lines = d0.text.split('\n');
  assert.deepEqual([d0.project, d0.review, d0.proposal, d0.count, d0.from, d0.chat], ['p-eco', 'pending', null, 3, 'Чат «Команда EcoChakra»', CH]);
  assert.match(lines[0], /^\[\d\d:\d\d\] Наташа: Давайте созвонимся в четверг$/);
  assert.match(lines[1], /^\[\d\d:\d\d\] Пётр: ↪ Наташа: Я за$/);
  assert.match(lines[2], /^\[\d\d:\d\d\] Наташа: \[голосовое 0:42\]$/);
  const voice = (await kept('gv'))[0].data;
  assert.deepEqual([voice.file.tg, voice.file.kind, voice.file.dur, voice.from, voice.review, voice.project], ['voice-1', 'audio', 42, 'Наташа', 'pending', 'p-eco'], 'a voice message can be played in the dashboard');
  assert.deepEqual(d0.people, ['Наташа', 'Пётр']);
  assert.equal(said(n, GID).length, 0, 'collecting is silent');
  assert.equal((await docs('projects')).find((x) => x.id === 'p-eco').data.next, 'Созвон с Наташей');
  // a part the owner has reviewed is closed: later messages start the next one
  await patch('messages/' + dg[0].id, { review: 'done' });
  await update(gmsg(PETR, { text: 'После ревью' }));
  dg = await kept('gc');
  assert.deepEqual(dg.map((d) => d.id), [dg[0].id, dg[0].id + '-2']);
  assert.equal(dg[0].data.count, 3);
  assert.match(dg[1].data.text, /^\[\d\d:\d\d\] Пётр: После ревью$/);
  assert.equal(dg[1].data.from, 'Чат «Команда EcoChakra», часть 2');
  assert.equal((await docs('chats')).find((d) => d.id === CH).data.n, 4);

  // /project: the state of the project, for anyone in the chat
  n = tgCalls.length;
  await update(gmsg(PETR, { text: '/project@prooloog_test_bot' }));
  const card = said(n, GID)[0];
  assert.equal(card.params.text, '<b>EcoChakra</b> · в работе\nСледующий шаг: Созвон с Наташей\nБлижайший майлстоун: 10 фев — Запуск бота сообщества\nЗадач в работе: 1, в очереди: 1');
  assert.deepEqual(cbs(card), ['gp:tasks', 'gp:ms', 'gp:ev', 'gp:sug']);
  n = tgCalls.length;
  await update(gmsg(PETR, { text: '/project@some_other_bot' }));
  assert.equal(said(n, GID).length, 0, 'a command for another bot');
  n = tgCalls.length;
  await update(gtap(PETR, 'gp:tasks'));
  const ed = sinceMark(n, 'editMessageText')[0];
  assert.equal(ed.params.text, '<b>EcoChakra</b> · задачи\n\n• 15 янв — Карта участников <i>в работе</i>\n• Анкета в Google Forms');
  assert.deepEqual(cbs(ed), ['gp:card']);
  n = tgCalls.length;
  await update(gtap(PETR, 'gp:ms'));
  assert.match(sinceMark(n, 'editMessageText')[0].params.text, /майлстоуны\n\n• 10 фев — Запуск бота сообщества$/);

  // suggestions wait for the owner like any client reply
  n = tgCalls.length;
  await update(gmsg(NAT, { text: '/task Собрать список участников' }));
  let sug = await kept('gs');
  assert.equal(sug.length, 1);
  assert.deepEqual(sug[0].data.proposal.items, [{ t: 'task', title: 'Собрать список участников', due: '' }]);
  assert.deepEqual([sug[0].data.review, sug[0].data.from, sug[0].data.project, sug[0].data.proposal.by], ['pending', 'Наташа (@natakhas_t)', 'p-eco', 'bot']);
  assert.match(said(n, GID)[0].params.text, /^Записал задачу\. В проекте она появится, когда Alex подтвердит\.$/);
  assert.equal((await docs('tasks')).length, tasksBefore, 'no task appears by itself');
  // the button asks for the task in a reply, and the reply is taken
  n = tgCalls.length;
  await update(gtap(PETR, 'gp:sug'));
  const pr = said(n, GID)[0];
  assert.match(pr.params.text, /^✍️ Задача для проекта «EcoChakra»\.\n<a href="tg:\/\/user\?id=777102">Пётр<\/a>, напиши её ответом/);
  assert.deepEqual([pr.params.reply_markup.force_reply, pr.params.reply_markup.selective], [true, true]);
  await update(gmsg(PETR, { text: 'Снять видео для анонса', reply_to_message: { message_id: 1, from: { id: 1, is_bot: true }, text: '✍️ Задача для проекта «EcoChakra».\nПётр, напиши её ответом на это сообщение.' } }));
  await update(gmsg(PETR, { text: '/note', reply_to_message: { message_id: 2, from: NAT, text: 'Бюджет до 500 долларов' } }));
  sug = await kept('gs');
  assert.deepEqual(sug.map((d) => d.data.proposal.items[0]).slice(1), [{ t: 'task', title: 'Снять видео для анонса', due: '' }, { t: 'cm', text: 'Наташа: Бюджет до 500 долларов', tag: 'insight' }]);
  assert.equal((await kept('gc')).reduce((a, d) => a + d.data.count, 0), 4, 'commands and answers to the bot are not chat talk');

  // the project in the app: closed until the owner opens it for this chat
  const login = (u) => call('POST', '/api/auth/telegram', { json: { initData: initData(u) } });
  n = tgCalls.length;
  await update(gtap(NAT, 'gp:app'));
  assert.match(sinceMark(n, 'answerCallbackQuery')[0].params.text, /не открыт/);
  assert.equal((await login(NAT)).status, 403);
  await patch('chats/' + CH, { app: true });
  n = tgCalls.length;
  await update(gmsg(PETR, { text: '/project' }));
  assert.deepEqual(cbs(said(n, GID)[0]), ['gp:tasks', 'gp:ms', 'gp:ev', 'gp:sug', 'gp:app']);
  // someone who is no longer in the chat
  tgMember[String(PETR.id)] = 'left';
  n = tgCalls.length;
  await update(gtap(PETR, 'gp:app'));
  assert.match(sinceMark(n, 'answerCallbackQuery')[0].params.text, /только участникам/);
  assert.equal((await login(PETR)).status, 403);
  // a member: looks only, this project only; the owner is told
  n = tgCalls.length;
  await update(gtap(NAT, 'gp:app'));
  assert.equal(sinceMark(n, 'answerCallbackQuery')[0].params.url, 'https://t.me/prooloog_test_bot?start=open');
  assert.match(said(n, OWNER.id)[0].params.text, /Наташа \(@natakhas_t\) открыл проект <b>EcoChakra<\/b> из чата «Команда EcoChakra»: доступ «смотреть»/);
  const nat = await login(NAT);
  assert.equal(nat.json.role, 'viewer'); assert.deepEqual(nat.json.projects, ['p-eco']);
  const natGet = (coll) => call('GET', '/api/db/' + coll, { token: nat.json.token });
  assert.deepEqual((await natGet('projects')).json.docs.map((d) => d.id), ['p-eco']);
  assert.equal((await natGet('messages')).status, 403);
  assert.equal((await natGet('chats')).status, 403);
  n = tgCalls.length;
  await update(gtap(NAT, 'gp:app'));
  assert.equal(said(n, OWNER.id).length, 0, 'the owner is told once');
  // a public chat where Telegram will not say who is a member: no access by the button
  await patch('chats/' + CH, { pub: true });
  tgMember[String(PETR.id)] = 'error';
  await update(gtap(PETR, 'gp:app'));
  assert.equal((await login(PETR)).status, 403);
  await patch('chats/' + CH, { pub: false });

  // the owner writes to the chat from the dashboard
  n = tgCalls.length;
  assert.equal((await call('POST', '/api/chats/' + CH + '/post', { token: ownerToken, json: { text: 'Созвон <завтра> в 18:00', buttons: true } })).status, 200);
  assert.equal(said(n, GID)[0].params.text, 'Созвон &lt;завтра&gt; в 18:00');
  assert.deepEqual(cbs(said(n, GID)[0]), ['gp:new', 'gp:sug', 'gp:app']);
  assert.equal((await call('POST', '/api/chats/' + CH + '/post', { token: nat.json.token, json: { text: 'x' } })).status, 403);
  assert.equal((await call('POST', '/api/chats/' + CH + '/post', { token: ownerToken, json: { text: '  ' } })).status, 400);
  assert.equal((await call('POST', '/api/chats/g999/post', { token: ownerToken, json: { text: 'x' } })).status, 404);

  // reminders of the project's events come to the chat when the owner turns them on
  await put('events/e-eco', { title: 'Общий созвон', project: 'p-eco', date: '2031-03-05', time: '12:00', rem: [15], link: 'https://meet.google.com/abc', share: 'ecosharetoken123' });
  const tz = await clock.appTz(), start = clock.wallToMs('2031-03-05', '12:00', tz);
  n = tgCalls.length;
  await remind.tick(start - 15 * 60000 + 1000);
  assert.equal(said(n, GID).length, 0, 'off until asked');
  await patch('chats/' + CH, { remind: true });
  await put('events/e-eco', { title: 'Общий созвон', project: 'p-eco', date: '2031-03-06', time: '12:00', rem: [15], link: 'https://meet.google.com/abc', share: 'ecosharetoken123' });
  const start2 = clock.wallToMs('2031-03-06', '12:00', tz);
  n = tgCalls.length;
  await remind.tick(start2 - 15 * 60000 + 1000);
  const rm = said(n, GID)[0];
  assert.match(rm.params.text, /Через 15 минут: <b>Общий созвон<\/b>/);
  assert.equal(rm.params.reply_markup.inline_keyboard[0][0].url, 'https://t.me/prooloog_test_bot?start=ev_ecosharetoken123');
  n = tgCalls.length;
  await remind.tick(start2 - 5 * 60000 + 1000);
  assert.match(said(n, GID)[0].params.text, /Через 5 минут[\s\S]*Ссылка: https:\/\/meet\.google\.com\/abc/);

  // «only what is addressed to the bot»
  await patch('chats/' + CH, { collect: 'ask' });
  const total = async () => (await kept('gc')).reduce((a, d) => a + d.data.count, 0);
  const t0 = await total();
  await update(gmsg(PETR, { text: 'Это мимо бота' }));
  assert.equal(await total(), t0);
  await update(gmsg(PETR, { text: '@prooloog_test_bot запомни: площадка свободна с 10 утра' }));
  assert.equal(await total(), t0 + 1);
  n = tgCalls.length;
  await update(gmsg(PETR, { text: '@prooloog_test_bot' }));
  assert.match(said(n, GID)[0].params.text, /^<b>EcoChakra<\/b> · в работе/, 'the name alone is a question');
  await patch('chats/' + CH, { collect: 'off', read: false });
  const t1 = await total();
  n = tgCalls.length;
  await update(gmsg(PETR, { text: '@prooloog_test_bot ещё одно' }));
  await update(gtap(PETR, 'gp:tasks'));
  assert.equal(await total(), t1);
  assert.equal(said(n, GID).length, 0);
  assert.match(sinceMark(n, 'answerCallbackQuery')[0].params.text, /не открывал проект/);
  // the bot starts to keep more than before: the chat is told at once
  n = tgCalls.length;
  await patch('chats/' + CH, { collect: 'all', read: true });
  assert.match(said(n, GID)[0].params.text, /Сохраняю сообщения этого чата в переписку проекта\. Их видит только Alex/);
  n = tgCalls.length;
  await patch('chats/' + CH, { collect: 'ask', remind: false });
  assert.equal(said(n, GID).length, 0, 'keeping less needs no announcement');
  // a deleted project: the chat falls silent and lets go of it
  await put('projects/p-tmp', { name: 'Временный', status: 'active', order: 70 });
  n = tgCalls.length;
  await patch('chats/' + CH, { project: 'p-tmp', collect: 'all' });
  assert.match(said(n, GID)[0].params.text, /помогаю вести проект <b>Временный<\/b>/, 'tied from the dashboard: the chat is told too');
  await call('DELETE', '/api/db/projects/p-tmp', { token: ownerToken });
  n = tgCalls.length;
  await update(gmsg(PETR, { text: 'Кто-нибудь тут?' }));
  await update(gmsg(PETR, { text: '/project' }));
  assert.equal(said(n, GID).length, 0);
  assert.equal((await docs('chats')).find((d) => d.id === CH).data.project, '');
  assert.equal((await kept('gc')).filter((d) => d.data.project === 'p-tmp').length, 0);
  await patch('chats/' + CH, { project: 'p-eco' });

  // the group became a supergroup: same settings under the new id
  await update(gmsg(OWNER, { migrate_to_chat_id: -1009990000002 }));
  const after = await docs('chats');
  assert.ok(!after.some((d) => d.id === CH));
  const moved = after.find((d) => d.id === 'g1009990000002').data;
  assert.deepEqual([moved.project, moved.app, moved.tg], ['p-eco', true, '-1009990000002']);
  // the bot is removed: the record stays, nothing can be sent
  await update(member({ id: -1009990000002, type: 'supergroup', title: 'Команда EcoChakra' }, OWNER, 'left'));
  assert.equal((await docs('chats')).find((d) => d.id === 'g1009990000002').data.on, false);
  assert.equal((await call('POST', '/api/chats/g1009990000002/post', { token: ownerToken, json: { text: 'x' } })).status, 404);

  // the «add to a chat» link of a project: the chat is tied at once, without questions
  const G2 = { id: -1005550000003, type: 'supergroup', title: 'Блог: съёмки' };
  n = tgCalls.length;
  await update(gmsg(EVE, { text: '/start@prooloog_test_bot p_p-eco' }, G2));
  assert.equal(said(n, G2.id).length, 0, 'a stranger cannot tie a chat');
  await update(gmsg(OWNER, { text: '/start@prooloog_test_bot p_p-eco' }, G2));
  assert.match(said(n, G2.id)[0].params.text, /помогаю вести проект <b>EcoChakra<\/b>/);
  await update(member(G2, OWNER, 'member'));
  assert.equal(said(n, OWNER.id).filter((c) => /К какому проекту/.test(c.params.text)).length, 0);
  assert.equal((await docs('chats')).find((d) => d.id === 'g1005550000003').data.project, 'p-eco');
  // the owner takes the bot out from the dashboard
  n = tgCalls.length;
  assert.equal((await call('POST', '/api/chats/g1005550000003/leave', { token: ownerToken })).status, 200);
  assert.ok(sinceMark(n, 'leaveChat').some((c) => String(c.params.chat_id) === String(G2.id)));
  assert.equal((await docs('chats')).find((d) => d.id === 'g1005550000003').data.on, false);
  await call('DELETE', '/api/share/members/' + NAT.id, { token: ownerToken });
});

test('the bot dates messages by the time zone chosen in the dashboard', async () => {
  const db = require('../src/db'), bot = require('../src/bot');
  // 19:00 UTC is 23:00 on the 18th in Tbilisi and 00:30 on the 19th in India
  const at = Math.floor(Date.parse('2026-11-18T19:00:00Z') / 1000);
  bot.forgetTz();
  const u1 = msg(OWNER, { text: 'от Ravi Kumar, индия: по часам Грузии', date: at });
  await update(u1);
  assert.equal((await db.getDoc('messages', 'gt' + u1.message.message_id)).data.date, '2026-11-18');
  await call('PATCH', '/api/db/settings/main', { token: ownerToken, json: { data: { tz: 'Asia/Kolkata' } } });
  bot.forgetTz();
  const u2 = msg(OWNER, { text: 'от Ravi Kumar, индия: по часам Индии', date: at });
  await update(u2);
  assert.equal((await db.getDoc('messages', 'gt' + u2.message.message_id)).data.date, '2026-11-19');
  await call('PATCH', '/api/db/settings/main', { token: ownerToken, json: { data: { tz: 'Not/AZone' } } });
  bot.forgetTz();
  const u3 = msg(OWNER, { text: 'от Ravi Kumar, индия: зона с ошибкой', date: at });
  await update(u3);
  assert.equal((await db.getDoc('messages', 'gt' + u3.message.message_id)).data.date, '2026-11-18', 'falls back to the default zone');
});

test('header parsing', () => {
  const { parseHeader } = require('../src/bot');
  const list = [{ id: 'p-india', data: { name: 'Кастинги в Индии' } }, { id: 'p-blog', data: { name: 'Личный блог' } }, { id: 'p-hub', data: { name: 'Хаб услуг: канал, бот, мини-приложение' } }];
  assert.equal(parseHeader('от @ravi, индия', list).project, 'p-india');
  assert.equal(parseHeader('от @ravi, india: hi', list).project, 'p-india');
  assert.equal(parseHeader('От Ravi, Личный блог: привет', list).project, 'p-blog');
  assert.equal(parseHeader('ravi, хаб', list).project, 'p-hub');
  assert.equal(parseHeader('ravi, блог: текст', list).body, 'текст');
  assert.equal(parseHeader('Купить молоко, хлеб', list), null);
  assert.equal(parseHeader('Саша, блог нужен завтра', list), null);
  assert.equal(parseHeader('Просто текст без запятой', list), null);
  assert.equal(parseHeader('от Ravi, марс: привет', list).project, '');
});
