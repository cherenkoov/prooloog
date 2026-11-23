'use strict';
// End-to-end checks of the server against a real Postgres, with stand-ins for Telegram and the Claude API.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');

const PORT = 18080, BOT = '123456:TESTTOKEN', BASE = 'http://127.0.0.1:' + PORT;
const tgCalls = [], tgFiles = {}, tgMember = {}, tgPhotos = {}, tgAdmins = {};
const sttCalls = [];
let sttAnswer = { text: '' };
let aiMode = 'ok';
const aiScript = []; // answers the Claude stand-in gives next, in order (without stream)

function listen(handler) { return new Promise((res) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res(s)); }); }
function body(req) { return new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c))); }); }

let tgSrv, aiSrv, sttSrv, srv;

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
    if (method === 'getChatAdministrators') result = tgAdmins[String(params.chat_id)] || [];
    if (method === 'sendMessage' || method === 'editMessageText' || method === 'sendDocument' || method === 'sendPhoto') result = { message_id: 1000 + tgCalls.length };
    if (method === 'getUserProfilePhotos') { const ph = tgPhotos[String(params.user_id)]; result = { total_count: ph ? 1 : 0, photos: ph ? [ph] : [] }; }
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
      const base = { id: 'msg_2', type: 'message', role: 'assistant', model: aiSrv.last.body.model, content: [{ type: 'text', text: 'На этой неделе главное: пилот блога.' }], stop_reason: 'end_turn', usage: { input_tokens: 1200, output_tokens: 80 } };
      return res.end(JSON.stringify(Object.assign(base, aiScript.shift() || {})));
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
  // Speech-to-text stand-in: the OpenAI-compatible call, a file and a model in, { text } out.
  sttSrv = await listen(async (req, res) => {
    const raw = (await body(req)).toString('latin1');
    sttCalls.push({ url: req.url, auth: req.headers.authorization, model: (/name="model"\r\n\r\n([^\r]*)/.exec(raw) || [])[1], file: (/name="file"; filename="([^"]*)"/.exec(raw) || [])[1], bytes: raw.length });
    res.setHeader('content-type', 'application/json');
    if (sttAnswer.status) res.statusCode = sttAnswer.status;
    res.end(JSON.stringify(sttAnswer.status ? { error: { message: 'no' } } : { text: sttAnswer.text }));
  });
  Object.assign(process.env, {
    STT_API_KEY: 'stt-test', STT_API_ROOT: 'http://127.0.0.1:' + sttSrv.address().port + '/v1',
    PORT: String(PORT), DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://prooloog@127.0.0.1:54329/prooloog_test',
    BOT_TOKEN: BOT, TG_API_ROOT: 'http://127.0.0.1:' + tgSrv.address().port, APP_URL: 'https://prooloog.test',
    OWNER_USERNAME: 'Alex_Owner', SESSION_SECRET: 'test-session-secret', WEBHOOK_SECRET: 'test-hook+secret/=',
    ANTHROPIC_API_KEY: 'sk-test', AI_API_ROOT: 'http://127.0.0.1:' + aiSrv.address().port, BACKUP_DAYS: '7',
    SEED_FILE: path.join(__dirname, 'fixture-seed.json'), GROUP_ASK_MS: '0', AUTH_LIMIT: '500',
    // the checks have forms of their own: they serve every project and carry a poll, whatever the live forms say
    FORMS_DIR: path.join(__dirname, 'forms'),
  });
  const db = require('../src/db');
  await db.init(process.env.DATABASE_URL);
  await db.q('DROP TABLE IF EXISTS docs, kv, members, invites, login_codes, bot_state, files, sent_reminders, invite_links, join_links');
  await db.close();
  srv = await require('../src/server').start();
  await new Promise((r) => setTimeout(r, 300));   // bot.setup() talks to the Telegram stand-in
});
test.after(async () => { await srv.stop(); tgSrv.close(); aiSrv.close(); sttSrv.close(); });

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
  assert.match(lastSay().params.text, /Кастинги в Индии[\s\S]*ждёт ревью\.$/);
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
  assert.match(lastSay().params.text, /Расшифровка голосового появится/, 'a speech-to-text key is set: the words are on their way');
  await require('../src/stt').idle();
  m = await db.getDoc('messages', 'gt' + u3.message.message_id);
  assert.deepEqual([m.data.text, m.data.stt.error, m.data.file.tg], ['', 'no_file', 'VOICEFILE12345'], 'no file, no words: the record stays as it was');
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
  // the bot works for the team: an editor's client reply is saved for review, and those who run the project hear of it
  let bn = tgCalls.length;
  await update(msg(BOB, { text: 'от Ravi, индия: тест' }));
  const bobSaid = sinceMark(bn, 'sendMessage').map((c) => [String(c.params.chat_id), c.params.text, c.params.reply_markup]);
  const toBob = bobSaid.find((x) => x[0] === String(BOB.id)), toOwner = bobSaid.find((x) => x[0] === String(OWNER.id));
  assert.match(toBob[1], /Сохранил в проект <b>Кастинги в Индии<\/b> от <b>Ravi<\/b>[\s\S]*подтверждают координаторы проекта/);
  assert.equal(toBob[2], undefined, 'no review button for somebody who cannot open the review');
  assert.match(toOwner[1], /<b>Bob<\/b> сохранил\(а\) в проект <b>Кастинги в Индии<\/b> сообщение от <b>Ravi<\/b>/);
  const bobMsg = (await call('GET', '/api/db/messages', { token: ownerToken })).json.docs.filter((d) => d.data.by === 'Bob');
  assert.equal(bobMsg.length, 1); assert.deepEqual([bobMsg[0].data.project, bobMsg[0].data.review, bobMsg[0].data.text], ['p-india', 'pending', 'тест']);
  assert.equal((await call('GET', '/api/db/projects', { token: ownerToken })).json.docs.find((d) => d.id === 'p-india').data.next, 'Домонтировать видеовизитку', 'the project is untouched');
  await call('DELETE', '/api/db/messages/' + bobMsg[0].id, { token: ownerToken });
  // plain text: an editor with every project gets «в ответ клиента» and «во входящие», never a session with Claude
  await update(msg(BOB, { text: 'просто мысль' }));
  assert.deepEqual(lastSay().params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['k:m', 'k:i', 'x']);
  await update(tap(BOB, 'x'));
  // what belongs to the whole dashboard stays with the owner, and the bot says why instead of «only the owner»
  await update(msg(BOB, { text: '/backup' }));
  assert.match(lastSay().params.text, /относится ко всему дэшборду[\s\S]*в боте она тебе не открыта/);
  await update(msg(BOB, { text: '/onboard индия' }));
  assert.match(lastSay().params.text, /Это делают координаторы проекта/);
  await update(msg(BOB, { text: '/help' }));
  assert.match(lastSay().params.text, /перешли мне его сообщение[\s\S]*подтверждают координаторы/);
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

test('a session with Claude in the bot: a talk, actions on the data, memory at the end', async () => {
  aiMode = 'ok';
  const session = require('../src/session'), dbm = require('../src/db');
  const docs = async (coll) => (await call('GET', '/api/db/' + coll, { token: ownerToken })).json.docs;
  const lastMsg = () => aiSrv.last.body.messages[aiSrv.last.body.messages.length - 1];
  const say = (text) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
  const use = (id, name, input, text) => ({ content: (text ? [{ type: 'text', text }] : []).concat([{ type: 'tool_use', id, name, input }]), stop_reason: 'tool_use' });
  await call('PUT', '/api/db/projects/p-ask', { token: ownerToken, json: { data: { name: 'Проект для вопроса', status: 'active', order: 1 } } });
  await call('PATCH', '/api/db/settings/main', { token: ownerToken, json: { data: { meet: { zoom: 'https://zoom.us/j/555' } } } });

  // «/ask вопрос» opens a session; the answer carries the button that ends it
  await update(msg(OWNER, { text: '/ask Что у меня на этой неделе?' }));
  assert.equal(lastSay().params.text, 'На этой неделе главное: пилот блога.');
  assert.deepEqual(lastSay().params.reply_markup.inline_keyboard, [[{ text: 'Завершить сессию', callback_data: 'as:end' }]]);
  const sent = aiSrv.last.body;
  assert.equal(sent.stream, undefined);
  assert.match(sent.system, /ДАННЫЕ ДЭШБОРДА СЕЙЧАС[\s\S]*Проект для вопроса/);
  assert.match(sent.system, /постоянные ссылки владельца: Zoom https:\/\/zoom\.us\/j\/555/);
  assert.deepEqual(sent.tools.map((t) => t.name), ['status', 'list', 'get', 'write', 'add_message', 'create', 'remember']);
  assert.ok(sent.tools.every((t) => t.input_schema && t.input_schema.type === 'object' && !t.inputSchema), 'tools in the shape the API takes');
  assert.equal(lastMsg().content, 'Что у меня на этой неделе?');
  // from now on a plain message is a turn of the talk, with what was said before
  await update(msg(OWNER, { text: 'А потом?' }));
  assert.deepEqual(aiSrv.last.body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(lastSay().params.text, 'На этой неделе главное: пилот блога.');
  await new Promise((r) => setTimeout(r, 150));
  const u = (await docs('usage'))[0].data;
  assert.equal(u.by.bot.n, 2); assert.equal(u.by.bot.in, 2400);
  await update(msg(OWNER, { text: '/usage' }));
  assert.match(lastSay().params.text, /запросов \d+[\s\S]*\$/);

  // Claude acts: a meeting is created, and Claude gets the participant's links back
  aiScript.push(use('tu_1', 'create', { collection: 'events', data: { title: 'Созвон с Джоном', project: 'p-ask', date: '2031-06-01', time: '10:00', call: 'zoom', link: 'https://zoom.us/j/555', rem: [15], lang: 'en' } }, 'Назначаю.'),
    say('**Готово**: встреча назначена на 1 июня в 10:00.'));
  await update(msg(OWNER, { text: 'Назначь созвон с Джоном 1 июня в 10 утра, он говорит по-английски' }));
  assert.equal(lastSay().params.text, 'Готово: встреча назначена на 1 июня в 10:00.', 'plain text for Telegram');
  const ev = (await docs('events')).find((d) => d.data.title === 'Созвон с Джоном');
  assert.match(ev.id, /^e[0-9a-f]{10}$/);
  assert.deepEqual([ev.data.project, ev.data.date, ev.data.time, ev.data.call, ev.data.link, ev.data.rem, ev.data.lang], ['p-ask', '2031-06-01', '10:00', 'zoom', 'https://zoom.us/j/555', [15], 'en']);
  assert.match(ev.data.share, /^[0-9a-f]{24}$/);
  const back = aiSrv.last.body.messages, tr = lastMsg().content[0];
  assert.deepEqual([tr.type, tr.tool_use_id, tr.is_error], ['tool_result', 'tu_1', undefined]);
  assert.match(tr.content, new RegExp('"english":"https://t\\.me/prooloog_test_bot\\?start=even_' + ev.data.share + '"'));
  assert.deepEqual(back[back.length - 2].content.map((b) => b.type), ['text', 'tool_use'], 'the tool call goes back as it came');
  // a tool that fails tells Claude so, and the talk goes on
  aiScript.push(use('tu_2', 'write', { ops: [{ op: 'merge', collection: 'nope', id: 'x', data: { a: 1 } }] }), say('Такой коллекции нет.'));
  await update(msg(OWNER, { text: 'Поменяй что-нибудь в nope' }));
  assert.deepEqual([lastMsg().content[0].is_error, /Unknown collection/.test(lastMsg().content[0].content)], [true, true]);
  assert.equal(lastSay().params.text, 'Такой коллекции нет.');
  // a forwarded message inside a session goes to Claude with its author
  await update(msg(OWNER, { text: 'Давайте в четверг', forward_origin: { type: 'hidden_user', sender_user_name: 'Наташа', date: Math.floor(Date.now() / 1000) } }));
  assert.equal(lastMsg().content, 'Пересланное сообщение от Наташа:\nДавайте в четверг');
  // «запомни»: a note in the memory at once
  aiScript.push(use('tu_3', 'remember', { text: 'Созвоны с Джоном ведём на английском' }), say('Запомнил.'));
  await update(msg(OWNER, { text: 'Запомни: с Джоном говорим по-английски' }));
  assert.deepEqual((await docs('memory')).map((d) => [d.data.kind, d.data.text]), [['note', 'Созвоны с Джоном ведём на английском']]);

  // the button ends the session: Claude writes what to remember, the talk is kept next to it
  aiScript.push(say('Созвон с Джоном и неделя\n- Назначен созвон с Джоном на 1 июня, 10:00, на английском\n- Главное на неделе: пилот блога'));
  let n = tgCalls.length;
  await update(tap(OWNER, 'as:end'));
  assert.equal(lastSay().params.text, 'Сессия с Claude завершена. Запомнил:\n\nСозвон с Джоном и неделя\n- Назначен созвон с Джоном на 1 июня, 10:00, на английском\n- Главное на неделе: пилот блога\n\nВсё, что в памяти: /memory');
  assert.ok(sinceMark(n, 'editMessageReplyMarkup').length, 'the button is gone from the old answer');
  assert.match(aiSrv.last.body.system, /^Ты ведёшь память ассистента/);
  assert.match(aiSrv.last.body.messages[0].content, /^Владелец: Что у меня на этой неделе\?\n\nClaude: На этой неделе главное: пилот блога\./);
  const mem = (await docs('memory')).find((d) => d.data.kind === 'session').data;
  assert.deepEqual([mem.title, mem.why, mem.turns, mem.talk.length, mem.talk[0].r, mem.src], ['Созвон с Джоном и неделя', 'button', 12, 12, 'u', 'bot']);
  assert.equal((await call('GET', '/api/db/memory', { token: bobToken })).status, 403, 'the memory is the owner\'s');
  // the session is over: a plain text is a note or a client reply again
  await update(msg(OWNER, { text: 'Просто заметка' }));
  assert.match(lastSay().params.text, /Что сделать с этим текстом/);
  await update(tap(OWNER, 'x'));
  await update(tap(OWNER, 'as:end'));
  assert.match(lastSay().params.text, /уже завершена/);

  // the next session knows what the earlier ones left
  await update(msg(OWNER, { text: '/ask' }));
  assert.match(lastSay().params.text, /^Сессия с Claude открыта\./);
  await update(msg(OWNER, { text: 'Что ты помнишь?' }));
  assert.match(aiSrv.last.body.system, /ПАМЯТЬ ПРОШЛЫХ СЕССИЙ[\s\S]*Назначен созвон с Джоном на 1 июня[\s\S]*Созвоны с Джоном ведём на английском/);
  assert.equal(aiSrv.last.body.messages.length, 1, 'a new session starts clean');
  // 30 minutes of silence close it, quietly, with its memory
  const s = await dbm.kvGet(session.KEY);
  await dbm.kvSet(session.KEY, Object.assign({}, s, { lastAt: Date.now() - 31 * 60000 }));
  aiScript.push(say('Вопрос о памяти\n- Владелец спрашивал, что помнит ассистент'));
  n = tgCalls.length;
  assert.equal(await session.sweep(), true);
  const quiet = sinceMark(n, 'sendMessage')[0].params;
  assert.match(quiet.text, /^Сессия с Claude закрыта: 30 минут было тихо\. Запомнил:\n\nВопрос о памяти/);
  assert.equal(quiet.disable_notification, true);
  assert.equal(await session.sweep(), false);
  assert.equal((await docs('memory')).filter((d) => d.data.why === 'idle').length, 1);
  // what is in the memory, and how to clear it
  await update(msg(OWNER, { text: '/memory' }));
  assert.match(lastSay().params.text, /<b>Память Claude<\/b>: записей 3[\s\S]*Вопрос о памяти[\s\S]*\/forget/);
  await update(msg(OWNER, { text: '/forget' }));
  assert.match(lastSay().params.text, /записей: 3\. Стереть всё\? Тогда напиши: \/forget да/);
  assert.equal((await docs('memory')).length, 3);
  await update(msg(OWNER, { text: '/forget да' }));
  assert.equal((await docs('memory')).length, 0);
  // a bad key is explained, not hidden; nothing is remembered about a talk that never happened
  aiMode = 'badkey';
  await update(msg(OWNER, { text: '/ask ещё вопрос' }));
  assert.match(lastSay().params.text, /не принял ключ/);
  aiMode = 'ok';
  await update(msg(OWNER, { text: '/end' }));
  assert.match(lastSay().params.text, /^Сессия с Claude завершена\.$/);
  assert.equal((await docs('memory')).length, 0);
  await update(msg(OWNER, { text: '/end' }));
  assert.match(lastSay().params.text, /Сессии с Claude сейчас нет/);
});

test('connector for Claude: address from the bot, tools, review rule, merge', async () => {
  await update(msg(EVE, { text: '/connect' }));
  assert.match(lastSay().params.text, /в боте она тебе не открыта/);
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
  // a participant opens the bot by the link of the event: the language first, the likely one offered first
  const subOf = async (u) => (await call('GET', '/api/db/evsubs', { token: ownerToken })).json.docs.find((x) => x.data.event === 'e-rem' && x.data.tg === String(u.id));
  const keys = (c) => c.params.reply_markup.inline_keyboard.map((row) => row.map((b) => [b.text, b.callback_data]));
  const EVR = Object.assign({}, EVE, { language_code: 'ru' });
  n = tgCalls.length;
  await update(msg(EVR, { text: '/start ev_sharetoken123456' }));
  assert.equal(lastSay().params.text, '<b>Созвон с Наташей</b>\n🌐 Выберите язык · Choose your language');
  assert.deepEqual(keys(lastSay()), [[['Русский', 'el:e-rem:ru'], ['English', 'el:e-rem:en']]]);
  let sub = await subOf(EVE);
  assert.deepEqual([sub.data.rem, sub.data.lang, sub.data.asked], [[5], 'ru', false], 'subscribed at once, in the likely language, even if the question is never answered');
  await update(tap(EVR, 'el:e-rem:ru'));
  assert.equal(lastSay().method, 'editMessageText');
  assert.equal(lastSay().params.text, '<b>Созвон с Наташей</b>\n1 дек, 10:00 (UTC+5:30)\n\nСсылка на созвон: https://zoom.us/j/123\nЗа 5 минут до начала пришлю её ещё раз.\n\nНапомню за 5 минут.\nКнопками ниже можно выбрать, когда напоминать.', 'the call link comes at once, right after the language');
  assert.deepEqual(keys(lastSay()), [[['Открыть созвон', undefined]], [['✓ за 5 минут', 'er:e-rem:5'], ['за 15 минут', 'er:e-rem:15']], [['за час', 'er:e-rem:60'], ['за день', 'er:e-rem:1440']], [['🌐 Язык', 'el:e-rem:ask']]]);
  assert.equal(lastSay().params.reply_markup.inline_keyboard[0][0].url, 'https://zoom.us/j/123');
  await update(tap(EVR, 'er:e-rem:15'));
  sub = await subOf(EVE);
  assert.deepEqual([sub.data.rem, sub.data.lang, sub.data.asked], [[15, 5], 'ru', true]);
  // the choice is remembered: the next link opens without a question
  await call('PUT', '/api/db/events/e-rem2', { token: ownerToken, json: { data: { title: 'Вторая встреча', date: '2026-12-02', time: '11:00', share: 'sharetoken2222222' } } });
  await update(msg(Object.assign({}, EVE, { language_code: 'en' }), { text: '/start ev_sharetoken2222222' }));
  assert.match(lastSay().params.text, /^<b>Вторая встреча<\/b>\n2 дек, 11:00 \(UTC\+5:30\)\n\nНапомню за 5 минут\.\nКнопками/);
  await update(msg(EVR, { text: '/start ev_nosuchtoken000000' }));
  assert.match(lastSay().params.text, /больше не действует\. Попросите у организатора/);
  // the organizer fixed English in the link: no question, whatever the person's Telegram says
  const JOHN = { id: 777301, first_name: 'John', language_code: 'de' };
  await update(msg(JOHN, { text: '/start even_sharetoken123456' }));
  assert.equal(lastSay().params.text, "<b>Созвон с Наташей</b>\nDec 1, 10:00 (UTC+5:30)\n\nCall link: https://zoom.us/j/123\nI'll send it again 5 minutes before the start.\n\nI'll remind you 5 minutes before.\nUse the buttons below to choose when to be reminded.");
  assert.deepEqual(keys(lastSay()).flat().map((b) => b[0]), ['Join the call', '✓ 5 minutes before', '15 minutes before', '1 hour before', '1 day before', '🌐 Language']);
  n = tgCalls.length;
  await update(tap(JOHN, 'er:e-rem:60'));
  assert.equal(sinceMark(n, 'answerCallbackQuery')[0].params.text, "I'll remind you 1 hour before");
  assert.deepEqual([(await subOf(JOHN)).data.lang, (await subOf(JOHN)).data.asked], ['en', true]);
  await update(msg(JOHN, { text: '/start even_nosuchtoken000000' }));
  assert.match(lastSay().params.text, /^This meeting link no longer works/);
  // the link leaves the choice, the person's Telegram is not in Russian: English is offered first
  const ANA = { id: 777302, first_name: 'Ana', language_code: 'es' };
  await update(msg(ANA, { text: '/start ev_sharetoken123456' }));
  assert.deepEqual(keys(lastSay()), [[['English', 'el:e-rem:en'], ['Русский', 'el:e-rem:ru']]]);
  assert.deepEqual([(await subOf(ANA)).data.lang, (await subOf(ANA)).data.asked], ['en', false]);
  // 15 minutes before: the owner and the participant who asked for it; 5 minutes before: the link goes to everybody, each in their language
  n = tgCalls.length;
  assert.equal(await remind.tick(start - 15 * 60000 + 2000), 2);
  assert.deepEqual(texts(n).map((x) => x[0]).sort(), [String(OWNER.id), String(EVE.id)].sort());
  assert.match(texts(n).find((x) => x[0] === String(EVE.id))[1], /Через 15 минут[\s\S]*\(UTC\+5:30\)[\s\S]*zoom\.us/);
  n = tgCalls.length;
  assert.equal(await remind.tick(start - 5 * 60000 + 2000), 4);
  const to = (u) => texts(n).find((x) => x[0] === String(u.id))[1];
  assert.equal(to(EVE), '⏰ Через 5 минут: <b>Созвон с Наташей</b>\n1 дек, 10:00 (UTC+5:30)\nСсылка: https://zoom.us/j/123');
  assert.equal(to(JOHN), '⏰ In 5 minutes: <b>Созвон с Наташей</b>\nDec 1, 10:00 (UTC+5:30)\nLink: https://zoom.us/j/123');
  assert.match(to(ANA), /^⏰ In 5 minutes:/, 'no answer to the question: the likely language');
  assert.match(to(OWNER), /^⏰ Через 5 минут:[\s\S]*Ссылка: https:\/\/zoom\.us\/j\/123/);
  // the language can be changed later with the button under the meeting
  await update(tap(ANA, 'el:e-rem:ask'));
  assert.match(lastSay().params.text, /Выберите язык · Choose your language/);
  n = tgCalls.length;
  await update(tap(ANA, 'el:e-rem:ru'));
  assert.equal(sinceMark(n, 'answerCallbackQuery')[0].params.text, 'Язык: русский');
  assert.match(lastSay().params.text, /Напомню за 5 минут/);
  assert.deepEqual([(await subOf(ANA)).data.lang, (await subOf(ANA)).data.asked], ['ru', true]);
  const i18n = require('../src/i18n');
  assert.equal(i18n.of('en').before(1), 'In 1 minute'); assert.equal(i18n.of('en').before(120), 'In 2 hours'); assert.equal(i18n.of('en').before(1440), 'In 1 day');
  assert.equal(i18n.guess('ru-RU'), 'ru'); assert.equal(i18n.guess(undefined), 'en'); assert.deepEqual(i18n.offer('hi'), ['en', 'ru']);
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
  assert.match(said.find((x) => x[0] === String(OWNER.id))[1], /Carol[\s\S]*вход по приглашению[\s\S]*зритель/);
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
  // the chat with a person: the bot sends the owner a message where the name opens the person's profile
  const chatMark = tgCalls.length;
  assert.equal((await call('POST', '/api/share/members/' + CAROL.id + '/chat', { token: ownerToken })).json.ok, true);
  const chatSay = sinceMark(chatMark, 'sendMessage')[0];
  assert.ok(chatSay && String(chatSay.params.chat_id) === String(OWNER.id) && chatSay.params.text.includes('<a href="tg://user?id=' + CAROL.id + '">Carol</a>'), 'the owner gets the link to the person');
  assert.equal((await call('POST', '/api/share/members/' + CAROL.id + '/chat', { token: ct })).status, 403, 'only the owner asks for it');
  assert.equal((await call('POST', '/api/share/members/999000111/chat', { token: ownerToken })).status, 404);
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
  assert.match(hello.params.text, /помогаю вести проект <b>EcoChakra<\/b>[\s\S]*то, что адресовано мне[\s\S]*видят только координаторы проекта[\s\S]*\/project[\s\S]*\/task/, 'says honestly what it keeps and for whom');
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
  assert.equal(card.params.text, '<b>EcoChakra</b> · в работе\nСледующий шаг: Созвон с Наташей\nБлижайшая верста: 10 фев — Запуск бота сообщества\nЗадач в работе: 1, в очереди: 1');
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
  assert.match(sinceMark(n, 'editMessageText')[0].params.text, /вёрсты\n\n• 10 фев — Запуск бота сообщества$/);

  // suggestions wait for the owner like any client reply
  n = tgCalls.length;
  await update(gmsg(NAT, { text: '/task Собрать список участников' }));
  let sug = await kept('gs');
  assert.equal(sug.length, 1);
  assert.deepEqual(sug[0].data.proposal.items, [{ t: 'task', title: 'Собрать список участников', due: '' }]);
  assert.deepEqual([sug[0].data.review, sug[0].data.from, sug[0].data.project, sug[0].data.proposal.by], ['pending', 'Наташа (@natakhas_t)', 'p-eco', 'bot']);
  assert.match(said(n, GID)[0].params.text, /^Записал задачу\. В проекте она появится, когда её подтвердит координатор\.$/);
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
  assert.match(said(n, OWNER.id)[0].params.text, /Наташа \(@natakhas_t\): доступ «смотреть» к проекту <b>EcoChakra<\/b> из чата «Команда EcoChakra»/);
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
  await put('events/e-eco-en', { title: 'Team call', project: 'p-eco', date: '2031-03-07', time: '12:00', rem: [15], share: 'ecosharetoken456', lang: 'en' });
  n = tgCalls.length;
  await remind.tick(clock.wallToMs('2031-03-07', '12:00', tz) - 15 * 60000 + 1000);
  const en = said(n, GID)[0];
  assert.match(en.params.text, /^⏰ In 15 minutes: <b>Team call<\/b>\nMar 7, 12:00/);
  assert.deepEqual([en.params.reply_markup.inline_keyboard[0][0].text, en.params.reply_markup.inline_keyboard[0][0].url], ['Remind me personally', 'https://t.me/prooloog_test_bot?start=even_ecosharetoken456']);

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
  assert.match(sinceMark(n, 'answerCallbackQuery')[0].params.text, /не открыт/);
  // the bot starts to keep more than before: the chat is told at once
  n = tgCalls.length;
  await patch('chats/' + CH, { collect: 'all', read: true });
  assert.match(said(n, GID)[0].params.text, /Сохраняю сообщения этого чата в переписку проекта\. Их видят только координаторы проекта/);
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

test('onboarding: a link for a chat, the form, access to one project, a poll', async () => {
  const FAY = { id: 777010, first_name: 'Fay', last_name: 'Mason', username: 'fay_hub' }, GUS = { id: 777011, first_name: 'Gus' };
  const post = (tok, path, json) => call('POST', '/api/join/' + tok + path, { json });
  const said2 = (from) => sinceMark(from, 'sendMessage').filter((c) => String(c.params.chat_id) === String(OWNER.id)).map((c) => c.params.text);
  const put = (path, data) => call('PUT', '/api/db/' + path, { token: ownerToken, json: { data } });
  await put('projects/p-net', { name: 'Сеть мастеров', status: 'idea', order: 60 });
  await put('tasks/te-1', { title: 'Собрать анкеты', project: 'p-net' });
  // only the owner gets a link; the same link comes back the second time
  await update(msg(BOB, { text: '/onboard Сеть мастеров' }));
  assert.doesNotMatch(lastSay().params.text, /start=join_/);
  await update(msg(OWNER, { text: '/onboard сеть мастеров' }));
  const tok = /start=join_([A-Za-z0-9_-]{12,40})/.exec(lastSay().params.text)[1];
  assert.match(lastSay().params.text, /выбрать время встречи 19 ноября/);
  await update(msg(OWNER, { text: '/onboard Сеть мастеров' }));
  assert.equal(/start=join_([A-Za-z0-9_-]+)/.exec(lastSay().params.text)[1], tok);
  // a name the bot cannot place: the project is picked from buttons, a stranger's tap does nothing
  await update(msg(OWNER, { text: '/onboard неизвестный' }));
  assert.match(lastSay().params.text, /Не нашёл проект/);
  assert.ok(lastSay().params.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'ob:p-net'));
  let n0 = tgCalls.length;
  await update(tap(FAY, 'ob:p-net'));
  assert.equal(sinceMark(n0, 'sendMessage').length, 0);
  await update(tap(OWNER, 'ob:p-net'));
  assert.equal(/start=join_([A-Za-z0-9_-]+)/.exec(lastSay().params.text)[1], tok);
  // a stranger opens the link in the bot and gets the button to the form
  await update(msg(FAY, { text: '/start join_' + tok }));
  assert.match(lastSay().params.text, /ЭкоЧакра[\s\S]*Сеть мастеров/);
  assert.equal(lastSay().params.reply_markup.inline_keyboard[0][0].web_app.url, 'https://prooloog.test/join/' + tok);
  await update(msg(FAY, { text: '/start join_AAAAAAAAAAAAAAAA' }));
  assert.match(lastSay().params.text, /больше не действует/);
  // the page and the form are public by the link; a wrong link shows nothing
  assert.match((await call('GET', '/join/' + tok)).text, /telegram-web-app\.js/);
  const pub = await call('GET', '/api/join/' + tok);
  assert.equal(pub.json.project, 'Сеть мастеров'); assert.equal(pub.json.form.id, 'ecochakra'); assert.equal(pub.json.bot, 'prooloog_test_bot');
  assert.equal((await call('GET', '/api/join/AAAAAAAAAAAAAAAA')).status, 404);
  // who you are comes from Telegram only
  assert.equal((await post(tok, '/me', { initData: 'user=%7B%22id%22%3A1%7D&hash=00' })).status, 401);
  const me0 = await post(tok, '/me', { initData: initData(FAY) });
  assert.equal(me0.json.joined, false); assert.equal(me0.json.user.name, 'Fay Mason'); assert.equal(me0.json.polls[0].voters, 0);
  // no vote and no extended part before the form
  assert.equal((await post(tok, '/vote', { initData: initData(FAY), poll: 'meet-1119-time', picks: ['10:00'] })).status, 409);
  assert.equal((await post(tok, '/submit', { initData: initData(FAY), part: 'more', answers: { '8.2': '500' } })).status, 409);
  // required answers are checked on the server
  const core = {
    '1.1': 'Fay Mason', '1.2': '+995 555 12 34 56', '1.3': 'fay@example.com', '1.5': ['Telegram'],
    '2.1': ['Владелец пространства / хаба', 'Другое: гончар'], '2.2': 'Керамика', '3.1': 'Батуми, Грузия', '3.2': 'Планирую создать',
    '4.1': ['Провести ретрит / событие'], '5.1': ['Ретриты и выездные форматы'], '6.1': ['Амбассадор', 'Эксперт-консультант'],
    '7.1': '2–5', '8.1': ['Обсуждаемо'], '9.1': 'Пока затрудняюсь ответить', '10.5': 'Пока затрудняюсь ответить',
  };
  const badTry = await post(tok, '/submit', { initData: initData(FAY), part: 'core', answers: Object.assign({}, core, { '1.3': 'not-mail', '3.2': 'выдумка', '5.1': ['Сеть точек и хабов на карте', 'Ретриты и выездные форматы', 'Ремесло, мастерские, ручная работа', 'Обучение и передача знаний'], '7.1': undefined }) });
  assert.equal(badTry.status, 400); assert.deepEqual(badTry.json.fields.sort(), ['1.3', '3.2', '5.1', '7.1']);
  assert.equal((await require('../src/db').getMember(String(FAY.id))), null);
  // the form goes through: access to this one project, a contact, a word to both sides
  let n = tgCalls.length;
  const done = await post(tok, '/submit', { initData: initData(FAY), part: 'core', answers: Object.assign({ junk: 'x', '8.2': 'не из этой части' }, core) });
  assert.equal(done.status, 200); assert.equal(done.json.joined, true); assert.equal(done.json.people, 1);
  assert.equal(done.json.answers.junk, undefined); assert.equal(done.json.answers['8.2'], undefined);
  const said = sinceMark(n, 'sendMessage').map((c) => [String(c.params.chat_id), c.params.text]);
  assert.match(said.find((x) => x[0] === String(FAY.id))[1], /вы в проекте <b>Сеть мастеров/);
  assert.match(said.find((x) => x[0] === String(OWNER.id))[1], /Fay Mason<\/b> \(@fay_hub\)[\s\S]*Сеть мастеров[\s\S]*Город: Батуми, Грузия[\s\S]*Роль: Амбассадор; Эксперт-консультант/);
  const f = await call('POST', '/api/auth/telegram', { json: { initData: initData(FAY) } });
  assert.equal(f.json.role, 'editor'); assert.deepEqual(f.json.projects, ['p-net']);
  const ft = f.json.token, ids = async (coll) => (await call('GET', '/api/db/' + coll, { token: ft })).json.docs.map((d) => d.id);
  assert.deepEqual(await ids('projects'), ['p-net']); assert.deepEqual(await ids('tasks'), ['te-1']);
  assert.equal((await call('GET', '/api/db/contacts', { token: ft })).status, 403);
  assert.equal((await call('GET', '/api/db/joins', { token: ft })).status, 404);
  assert.equal((await call('GET', '/api/db/joins', { token: ownerToken })).status, 404);
  assert.equal((await call('PUT', '/api/db/tasks/te-2', { token: ft, json: { data: { title: 'Моя задача', project: 'p-net' } } })).status, 200);
  assert.equal((await call('PUT', '/api/db/tasks/tx-9', { token: ft, json: { data: { title: 'В чужой проект', project: 'p-india' } } })).status, 403);
  const contact = (await call('GET', '/api/db/contacts', { token: ownerToken })).json.docs.find((d) => d.id === 'jn-' + FAY.id);
  assert.equal(contact.data.name, 'Fay Mason'); assert.equal(contact.data.tg, '@fay_hub'); assert.equal(contact.data.email, 'fay@example.com');
  assert.deepEqual(contact.data.projects, ['p-net']); assert.match(contact.data.notes, /Анкета «ЭкоЧакра»[\s\S]*Сфера: Керамика/);
  assert.deepEqual([contact.data.team, contact.data.rel], [['p-net'], 'Команда'], 'the team form puts the person into the team of the project');
  // sending the form again changes the answers, the contact stays one, nobody is told twice
  n = tgCalls.length;
  const again = await post(tok, '/submit', { initData: initData(FAY), part: 'core', answers: Object.assign({}, core, { '2.2': 'Керамика и чай' }) });
  assert.equal(again.json.answers['2.2'], 'Керамика и чай'); assert.equal(again.json.people, 1);
  assert.equal(sinceMark(n, 'sendMessage').length, 0);
  const c2 = (await call('GET', '/api/db/contacts', { token: ownerToken })).json.docs.filter((d) => /^jn-/.test(d.id));
  assert.equal(c2.length, 1); assert.equal((c2[0].data.notes.match(/Анкета «ЭкоЧакра»/g) || []).length, 1); assert.match(c2[0].data.notes, /Керамика и чай/);
  // the extended part: everything optional, saved step by step, core answers stay
  const more = await post(tok, '/submit', { initData: initData(FAY), part: 'more', answers: { '3.3': 'Да, по договорённости', '10.2': ['Генерирую идеи', 'Обучаю других'], '11.6': 'керамика' } });
  assert.equal(more.json.more, true); assert.equal(more.json.answers['1.1'], 'Fay Mason'); assert.deepEqual(more.json.answers['10.2'], ['Генерирую идеи', 'Обучаю других']);
  assert.equal((await post(tok, '/submit', { initData: initData(FAY), part: 'more', answers: { '10.2': ['Генерирую идеи', 'Обучаю других', 'Организую процессы'] } })).status, 400);
  // two polls after the form: the hour (several picks) and the platform (one pick); names are shown
  const evs = async () => (await call('GET', '/api/db/events', { token: ownerToken })).json.docs.find((d) => d.id === 'ev-meet-1119');
  const P = (r, id) => r.json.polls.find((x) => x.id === id), whoOf = (r, id) => Object.fromEntries(P(r, id).opts.filter((o) => o.n).map((o) => [o.t, o.who]));
  await call('PATCH', '/api/db/settings/main', { token: ownerToken, json: { data: { tz: 'Asia/Tbilisi' } } }); require('../src/clock').forget();
  assert.equal(await evs(), undefined);
  n = tgCalls.length;
  const v1 = await post(tok, '/vote', { initData: initData(FAY), poll: 'meet-1119-time', picks: ['18:00', '11:00', '03:00'] });
  assert.deepEqual(P(v1, 'meet-1119-time').mine, ['11:00', '18:00']); assert.equal(P(v1, 'meet-1119-time').lead, '11:00');
  // the choice of the majority is the start of the meeting in the project's calendar (the app lives by Tbilisi time here)
  let ev = await evs();
  assert.deepEqual([ev.data.project, ev.data.title, ev.data.date, ev.data.time, ev.data.call], ['p-net', 'Встреча команды «ЭкоЧакра»', '2026-11-19', '11:00', '']);
  assert.match(said2(n)[0], /Большинство за 11:00 по Тбилиси \(UTC\+4\): голосов 1 из 1\.[\s\S]*стоит на 19 ноября, 11:00\./);
  const v2 = await post(tok, '/vote', { initData: initData(OWNER), poll: 'meet-1119-time', picks: ['18:00'] });
  assert.equal(v2.json.owner, true); assert.equal(v2.json.joined, false); assert.equal(v2.json.people, 1);
  assert.deepEqual(whoOf(v2, 'meet-1119-time'), { '11:00': ['Fay Mason'], '18:00': ['Fay Mason', 'Alex Owner'] });
  assert.equal(P(v2, 'meet-1119-time').lead, '18:00'); assert.equal((await evs()).data.time, '18:00');
  // the platform: one pick; a known platform takes the owner's standing link, Discord goes into the title
  await call('PATCH', '/api/db/settings/main', { token: ownerToken, json: { data: { meet: { zoom: 'https://zoom.us/j/111' } } } });
  const c1 = await post(tok, '/vote', { initData: initData(FAY), poll: 'meet-1119-call', picks: ['Zoom', 'Discord'] });
  assert.deepEqual(P(c1, 'meet-1119-call').mine, ['Zoom']);
  ev = await evs(); assert.deepEqual([ev.data.call, ev.data.link, ev.data.title], ['zoom', 'https://zoom.us/j/111', 'Встреча команды «ЭкоЧакра»']);
  await post(tok, '/vote', { initData: initData(FAY), poll: 'meet-1119-call', picks: ['Discord'] });
  ev = await evs(); assert.deepEqual([ev.data.call, ev.data.link, ev.data.title], ['other', '', 'Встреча команды «ЭкоЧакра» · Discord']);
  // a vote that does not move the majority writes nothing; a changed vote moves the meeting
  const ver = ev.version; n = tgCalls.length;
  await post(tok, '/vote', { initData: initData(FAY), poll: 'meet-1119-time', picks: ['18:00', '20:00'] });
  assert.equal((await evs()).version, ver); assert.equal(said2(n).length, 0);
  const v3 = await post(tok, '/vote', { initData: initData(FAY), poll: 'meet-1119-time', picks: ['14:00'] });
  assert.deepEqual(whoOf(v3, 'meet-1119-time'), { '14:00': ['Fay Mason'], '18:00': ['Alex Owner'] }); assert.equal(P(v3, 'meet-1119-time').voters, 2);
  assert.equal((await evs()).data.time, '14:00', 'equal votes: the earlier hour');
  // the participant sees the meeting in the project; the owner's own title and link survive later votes
  assert.ok((await ids('events')).includes('ev-meet-1119'));
  await call('PATCH', '/api/db/events/ev-meet-1119', { token: ownerToken, json: { data: { title: 'Знакомство команды', link: 'https://discord.gg/abc' } } });
  await post(tok, '/vote', { initData: initData(FAY), poll: 'meet-1119-time', picks: ['18:00'] });
  ev = await evs(); assert.deepEqual([ev.data.title, ev.data.link, ev.data.time], ['Знакомство команды', 'https://discord.gg/abc', '18:00']);
  // the calendar follows the app's own time zone
  await call('PATCH', '/api/db/settings/main', { token: ownerToken, json: { data: { tz: 'Asia/Kolkata' } } }); require('../src/clock').forget();
  await post(tok, '/vote', { initData: initData(FAY), poll: 'meet-1119-time', picks: ['21:00'] });
  await post(tok, '/vote', { initData: initData(OWNER), poll: 'meet-1119-time', picks: ['21:00'] });
  ev = await evs(); assert.deepEqual([ev.data.date, ev.data.time], ['2026-11-19', '22:30']);
  await call('PATCH', '/api/db/settings/main', { token: ownerToken, json: { data: { tz: 'Asia/Tbilisi' } } }); require('../src/clock').forget();
  assert.equal((await post(tok, '/vote', { initData: initData(GUS), poll: 'meet-1119-time', picks: ['12:00'] })).status, 409);
  assert.equal((await post(tok, '/vote', { initData: initData(FAY), poll: 'nope', picks: [] })).status, 400);
  await update(msg(OWNER, { text: '/votes' }));
  assert.match(lastSay().params.text, /Встреча 19 ноября: во сколько\?<\/b> · проголосовали: 2 · время по Тбилиси[\s\S]*✅ 21:00 — 2: Fay Mason, Alex Owner[\s\S]*Где созваниваемся\?[\s\S]*✅ Discord — 1: Fay Mason/);
  await update(msg(FAY, { text: '/votes' }));
  assert.match(lastSay().params.text, /Это делают координаторы проекта/);
  // answers as a table, and in the backup; the owner's own access did not change
  n = tgCalls.length;
  await update(msg(OWNER, { text: '/answers' }));
  const docs = sinceMark(n, 'sendDocument');
  assert.equal(docs.length, 1); assert.match(docs[0].params.caption, /ответов 2/);
  const tbl = await require('../src/join').csv(require('../src/join').form('ecochakra'));
  assert.match(tbl.body.toString('utf8'), /"Fay Mason","@fay_hub","Fay Mason","\+995 555 12 34 56"[\s\S]*"Владелец пространства \/ хаба; Другое: гончар"[\s\S]*"21:00","Discord"/);
  const exp = (await call('GET', '/api/export', { token: ownerToken })).json;
  assert.equal(exp.docs.joins['ecochakra-' + FAY.id].answers['2.2'], 'Керамика и чай');
  assert.equal((await call('GET', '/api/me', { token: ownerToken })).json.role, 'owner');
  assert.equal(await require('../src/db').getMember(String(OWNER.id)), null);
  // a person without a username joins too; someone with access to all projects keeps it
  const g = await post(tok, '/submit', { initData: initData(GUS), part: 'core', answers: Object.assign({}, core, { '1.1': 'Gus' }) });
  assert.equal(g.json.people, 2);
  assert.deepEqual((await require('../src/db').getMember(String(GUS.id))).projects, ['p-net']);
  await post(tok, '/submit', { initData: initData(BOB), part: 'core', answers: Object.assign({}, core, { '1.1': 'Bob' }) });
  const share = (await call('GET', '/api/share', { token: ownerToken })).json;
  assert.deepEqual(share.members.find((m) => m.id === String(FAY.id)).projects, ['p-net']);
  const bobNow = share.members.find((m) => m.id === String(BOB.id));
  if (bobNow) assert.equal(bobNow.projects === null || bobNow.projects.includes('p-net'), true);
  // switched off: the link stops working, people who came in stay
  await update(msg(OWNER, { text: '/onboard off Сеть мастеров' }));
  assert.match(lastSay().params.text, /выключена/);
  assert.equal((await call('GET', '/api/join/' + tok)).status, 404);
  assert.equal((await post(tok, '/me', { initData: initData(FAY) })).status, 404);
  assert.deepEqual(await ids('projects'), ['p-net']);
  await update(msg(OWNER, { text: '/onboard Сеть мастеров' }));
  assert.notEqual(/start=join_([A-Za-z0-9_-]+)/.exec(lastSay().params.text)[1], tok);
});

test('onboarding in the dashboard: the owner sees the link, the people, their answers and the poll', async () => {
  const FAY = { id: 777010 }, ob = (m, path, token = ownerToken) => call(m, '/api/onboard/' + path, { token, json: m === 'POST' ? {} : undefined });
  const v = (await ob('GET', 'p-net')).json;
  assert.match(v.link.url, /^https:\/\/t\.me\/prooloog_test_bot\?start=join_[A-Za-z0-9_-]{12,40}$/);
  assert.match(v.link.text, /^Коллеги, анкету «ЭкоЧакра» можно заполнить в Telegram[\s\S]*встречи 19 ноября[\s\S]*start=join_/);
  assert.deepEqual([v.form.id, v.form.title, v.forms.length >= 1], ['ecochakra', 'ЭкоЧакра', true]);
  assert.deepEqual(v.people.map((x) => x.name).sort(), ['Alex Owner', 'Bob', 'Fay Mason', 'Gus']);
  const fay = v.people.find((x) => x.tg === String(FAY.id));
  assert.deepEqual([fay.username, fay.core, fay.answers['2.2'], /^\d{4}-\d\d-\d\dT/.test(fay.at)], ['fay_hub', true, 'Керамика и чай', true]);
  assert.ok(fay.summary.length >= 3 && fay.summary.every((x) => typeof x === 'string' && x.includes(': ')), 'the short summary of the answers');
  assert.ok(v.form.questions.some((q) => q.id === '2.2' && q.label));
  assert.deepEqual([v.polls.map((x) => x.id), v.polls[0].kind, v.polls[0].opts.every((o) => o.n > 0), v.polls[1].opts.map((o) => o.t)], [['meet-1119-time', 'meet-1119-call'], 'time', true, ['Zoom', 'Google Meet', 'Discord']]);
  // the answers side by side: who chose what
  const st = v.stats.find((q) => q.id === '3.2');
  const plan = st.opts.find((o) => o.t === 'Планирую создать');
  assert.ok(plan.n >= 3 && plan.who.includes('Fay Mason') && plan.who.includes('Gus'));
  assert.ok(st.opts.every((o, i) => i === 0 || st.opts[i - 1].n >= o.n), 'the most chosen first');
  assert.ok(v.stats.every((q) => q.label && q.opts.every((o) => o.n === o.who.length && o.n > 0)));
  assert.ok(v.stats.find((q) => q.id === '2.1').opts.some((o) => o.t === 'Другое'), 'free «other» answers are counted together');
  assert.equal(v.polls[0].opts.reduce((n, o) => n + o.n, 0) >= 1, true);
  // a project nobody came to: no link yet, nothing to show
  await call('PUT', '/api/db/projects/p-ob2', { token: ownerToken, json: { data: { name: 'Без онбординга', status: 'idea', order: 61 } } });
  const empty = (await ob('GET', 'p-ob2')).json;
  assert.deepEqual([empty.link, empty.people, empty.polls.map((p) => p.voters)], [null, [], [0, 0]]);
  // the link is made in the dashboard, the same one comes back, and it can be switched off
  const on = (await ob('POST', 'p-ob2')).json;
  assert.match(on.link.url, /start=join_/);
  assert.equal((await ob('POST', 'p-ob2')).json.link.url, on.link.url);
  assert.equal((await call('GET', '/api/join/' + on.link.url.split('join_')[1])).status, 200);
  assert.equal((await ob('DELETE', 'p-ob2')).json.link, null);
  assert.equal((await call('GET', '/api/join/' + on.link.url.split('join_')[1])).status, 404);
  // the table of answers of this project goes to the owner's chat
  let n = tgCalls.length;
  assert.deepEqual((await ob('POST', 'p-net/csv')).json, { ok: true, n: 4 });
  const doc = sinceMark(n, 'sendDocument')[0];
  assert.equal(String(doc.params.chat_id), String(OWNER.id)); assert.match(doc.params.caption, /Сеть мастеров[\s\S]*ответов 4/);
  assert.equal((await ob('POST', 'p-ob2/csv')).status, 409);
  // only the owner; an unknown project is not found
  assert.equal((await ob('GET', 'p-net', bobToken)).status, 403);
  assert.equal((await ob('POST', 'p-net', bobToken)).status, 403);
  assert.equal((await ob('GET', 'p-nope')).status, 404);
  await call('DELETE', '/api/db/projects/p-ob2', { token: ownerToken });
});

test('invitation: a standing link with a QR code, a branching form, a card without access, the showcase', async () => {
  const join = require('../src/join'), dbm = require('../src/db');
  const IDA = { id: 777020, first_name: 'Ida', last_name: 'Reed', username: 'ida_body' }, JON = { id: 777021, first_name: 'Jon' }, FAY = { id: 777010, first_name: 'Fay', last_name: 'Mason', username: 'fay_hub' };
  const MASTER = 'Мастер: телесные практики, терапия';
  const post = (tok, path, json) => call('POST', '/api/join/' + tok + path, { json });
  const ob = (m, path, json, token = ownerToken) => call(m, '/api/onboard/' + path, { token, json });
  const contacts = async () => (await call('GET', '/api/db/contacts', { token: ownerToken })).json.docs;
  await call('PUT', '/api/db/projects/p-club', { token: ownerToken, json: { data: { name: 'Клуб', status: 'active', order: 70, why: 'внутреннее описание', notes: 'внутренние заметки' } } });
  await call('PUT', '/api/db/tasks/tc-1', { token: ownerToken, json: { data: { title: 'Внутренняя задача', project: 'p-club' } } });
  // two kinds of forms: the team form stays the default of /onboard, the invitation has its own command
  assert.deepEqual([join.teamFormOf('p-any').id, join.cardFormOf('p-any').id], ['ecochakra', 'ecochakra-club']);
  let n = tgCalls.length;
  await update(msg(OWNER, { text: '/club клуб' }));
  const sent = sinceMark(n, 'sendMessage').map((c) => c.params.text);
  const tok = /start=join_([A-Za-z0-9_-]{12,40})/.exec(sent[0])[1];
  assert.equal(sinceMark(n, 'sendPhoto').length, 1, 'the QR code comes as a picture');
  assert.match(sent[1], /клуб «ЭкоЧакра»[\s\S]*start=join_/); assert.match(sent[2], /Система долголетия[\s\S]*выберите «Мастер»[\s\S]*start=join_/);
  await update(msg(OWNER, { text: '/club Клуб' }));
  assert.ok(sinceMark(n, 'sendMessage').slice(3).some((c) => c.params.text.includes('start=join_' + tok)), 'the link is the same every time');
  await update(msg(BOB, { text: '/club Клуб' }));
  assert.doesNotMatch(lastSay().params.text, /start=join_/);
  // the team link of the same project is another link with the team form
  const teamTok = (await ob('POST', 'p-club', {})).json.link.url.split('join_')[1];
  assert.notEqual(teamTok, tok); assert.equal((await call('GET', '/api/join/' + teamTok)).json.form.id, 'ecochakra');
  // the dashboard: the invitation with its link, both texts and the QR code
  const v0 = (await ob('GET', 'p-club')).json;
  assert.equal(v0.invite.link.url, 'https://t.me/prooloog_test_bot?start=join_' + tok);
  assert.ok(v0.invite.link.guest.includes(v0.invite.link.url) && v0.invite.link.master.includes(v0.invite.link.url));
  assert.deepEqual([v0.invite.form.id, v0.invite.people, v0.forms.map((f) => f.id)], ['ecochakra-club', [], ['ecochakra']]);
  const qr = await ob('GET', 'p-club/qr');
  assert.match(qr.json.svg, /^<svg[\s\S]*<path/); assert.equal(qr.json.url, v0.invite.link.url);
  assert.equal((await ob('GET', 'p-club/qr', undefined, bobToken)).status, 403);
  // the bot greets a stranger without promising the project
  await update(msg(IDA, { text: '/start join_' + tok }));
  assert.match(lastSay().params.text, /ЭкоЧакра: клуб/); assert.doesNotMatch(lastSay().params.text, /окажетесь в проекте/);
  const pub = (await call('GET', '/api/join/' + tok)).json;
  assert.deepEqual([pub.access, pub.form.id, pub.form.steps[0].qs[0].label, pub.form.steps[pub.form.steps.filter((x) => x.part === 'core').length - 1].title], ['card', 'ecochakra-club', 'Кто вы?', 'Согласие']);
  const me0 = (await post(tok, '/me', { initData: initData(IDA) })).json;
  assert.deepEqual([me0.joined, me0.show, me0.people], [false, null, 0], 'no showcase before the form');
  const base = {
    '0.1': 'Участник клуба', '1.1': 'Ida Reed', '1.2': '+995 555 00 00 01', '1.3': 'ida@example.com', '1.5': ['Telegram'],
    '2.1': ['Путешественник / участник сети'], '2.2': 'Телесные практики', '3.1': 'Батуми, Грузия', '3.2': 'Нет, но хочу быть участником сети',
    '4.1': ['Медиа и продвижение'], '9.3': ['Знания и обучение'], '5.1': ['Обучение и передача знаний'], '6.1': ['Участник сети / путешественник'],
    '7.1': 'До 2', '8.1': ['Обсуждаемо'], '9.1': 'Пока затрудняюсь ответить', '10.5': 'Пока затрудняюсь ответить',
  };
  // without the consent nothing is saved: no answers, no card
  const noYes = await post(tok, '/submit', { initData: initData(IDA), part: 'core', answers: base });
  assert.equal(noYes.status, 400); assert.equal(noYes.json.error, 'no_consent');
  assert.equal(await dbm.getDoc('joins', 'ecochakra-club-' + IDA.id), null);
  assert.ok(!(await contacts()).some((d) => d.id === 'jn-' + IDA.id));
  // a master must answer the master's questions; a guest is never asked them
  const m1 = await post(tok, '/submit', { initData: initData(IDA), part: 'core', agree: true, answers: Object.assign({}, base, { '0.1': MASTER }) });
  assert.equal(m1.status, 400); assert.deepEqual(m1.json.fields.sort(), ['m.1', 'm.2', 'm.3', 'm.4']);
  // the follow-ups of an option are kept only while the option is chosen
  const mast = { '0.1': MASTER, 'm.1': ['Цигун / тайцзи', 'Другое: шиацу'], 'm.2': ['Групповые занятия'], 'm.3': '3–7 лет', 'm.4': 'Да, готов(а)' };
  n = tgCalls.length;
  const done = await post(tok, '/submit', { initData: initData(IDA), part: 'core', agree: true, answers: Object.assign({}, base, mast, {
    '4.1': ['Экспертная помощь: консультации, лекции'], '4.1.e1': ['Наставничество'], '4.1.e2': 'Здоровье спины', '4.1.e3': '3–7 лет', '4.1.m1': 'не выбрано, не должно сохраниться' }) });
  assert.equal(done.status, 200);
  assert.deepEqual([done.json.joined, done.json.agreed, done.json.people, done.json.answers['4.1.e2'], done.json.answers['4.1.m1']], [true, true, 0, 'Здоровье спины', undefined]);
  assert.equal(done.json.show.title, 'Клуб'); assert.match(done.json.show.text, /ЭкоЧакра/); assert.ok(done.json.show.points.length >= 2);
  assert.doesNotMatch(JSON.stringify(done.json.show), /внутрен/, 'nothing internal in the showcase');
  // no access to the project: only a card among its contacts, marked as a master
  assert.equal(await dbm.getMember(String(IDA.id)), null);
  assert.notEqual((await call('POST', '/api/auth/telegram', { json: { initData: initData(IDA) } })).status, 200);
  const card = (await contacts()).find((d) => d.id === 'jn-' + IDA.id).data;
  assert.deepEqual([card.name, card.tg, card.projects, card.master, card.team, card.rel], ['Ida Reed', '@ida_body', ['p-club'], true, undefined, '']);
  assert.match(card.role, /^Мастер: Цигун/); assert.match(card.notes, /Анкета «ЭкоЧакра: клуб»[\s\S]*Кто вы: Мастер[\s\S]*Направление: Цигун[\s\S]*Город: Батуми/);
  assert.ok(!(await join.teamOf('p-club')).some((d) => d.data.tg === String(IDA.id)), 'a guest is not in the team the meetings are sent to');
  const said = sinceMark(n, 'sendMessage').map((c) => [String(c.params.chat_id), c.params.text, c.params.reply_markup]);
  const toIda = said.find((x) => x[0] === String(IDA.id)), toOwner = said.find((x) => x[0] === String(OWNER.id));
  assert.match(toIda[1], /Анкета принята/); assert.equal(toIda[2].inline_keyboard[0][0].web_app.url, 'https://prooloog.test/join/' + tok);
  assert.match(toOwner[1], /Ida Reed<\/b> \(@ida_body\)[\s\S]*как <b>мастер<\/b>[\s\S]*доступа к проекту у человека нет/);
  assert.match((await dbm.getDoc('joins', 'ecochakra-club-' + IDA.id)).data.agreed, /^\d{4}-/);
  // the owner writes the showcase himself in the project
  await call('PUT', '/api/db/projects/p-club', { token: ownerToken, json: { data: { name: 'Клуб', status: 'active', order: 70, why: 'внутреннее описание', show: 'Клуб для своих.\nВстречи по субботам.' } } });
  assert.deepEqual((await post(tok, '/me', { initData: initData(IDA) })).json.show, { title: 'Клуб', text: 'Клуб для своих.\nВстречи по субботам.', points: [] });
  // sent again as a guest: the option is gone and so are its follow-ups; the card is the same one and keeps the mark
  n = tgCalls.length;
  const again = await post(tok, '/submit', { initData: initData(IDA), part: 'core', agree: true, answers: Object.assign({}, base, { 'm.1': ['Йога'], '4.1.e2': 'осталось от прошлого раза' }) });
  assert.deepEqual([again.json.answers['m.1'], again.json.answers['4.1.e2'], again.json.answers['0.1']], [undefined, undefined, 'Участник клуба']);
  assert.equal(sinceMark(n, 'sendMessage').length, 0);
  const cs = (await contacts()).filter((d) => d.id === 'jn-' + IDA.id || d.data.tg === '@ida_body');
  assert.equal(cs.length, 1); assert.equal(cs[0].data.master, true); assert.equal((cs[0].data.notes.match(/Анкета «ЭкоЧакра: клуб»/g) || []).length, 1);
  // where the owner has put a card, it stays: a team member who fills in the invitation is still in the team,
  // and a guest the owner moved into the team keeps the place after sending the form again
  const fay0 = (await contacts()).find((d) => d.id === 'jn-' + FAY.id).data;
  await post(tok, '/submit', { initData: initData(FAY), part: 'core', agree: true, answers: Object.assign({}, base, { '1.1': 'Fay Mason' }) });
  const fay1 = (await contacts()).find((d) => d.id === 'jn-' + FAY.id).data;
  assert.deepEqual([fay1.team, fay1.rel, fay1.projects.sort(), fay1.name], [fay0.team, fay0.rel, ['p-club', 'p-net'], fay0.name]);
  assert.deepEqual((await call('POST', '/api/auth/telegram', { json: { initData: initData(FAY) } })).json.projects, ['p-net'], 'the invitation adds no access');
  await call('PUT', '/api/db/contacts/jn-' + IDA.id, { token: ownerToken, json: { data: Object.assign({}, cs[0].data, { rel: 'Команда', team: ['p-club'] }) } });
  await post(tok, '/submit', { initData: initData(IDA), part: 'core', agree: true, answers: base });
  const ida2 = (await contacts()).find((d) => d.id === 'jn-' + IDA.id).data;
  assert.deepEqual([ida2.rel, ida2.team], ['Команда', ['p-club']]);
  // the dashboard sees who came by the invitation, apart from the team form
  const v = (await ob('GET', 'p-club')).json;
  assert.deepEqual(v.invite.people.map((x) => [x.name, x.master]).sort(), [['Fay Mason', false], ['Ida Reed', false]]);
  assert.deepEqual(v.people, []);
  n = tgCalls.length;
  assert.deepEqual((await call('POST', '/api/onboard/p-club/csv?form=invite', { token: ownerToken })).json, { ok: true, n: 2 });
  assert.match(sinceMark(n, 'sendDocument')[0].params.caption, /ЭкоЧакра: клуб/);
  // the whole onboarding of the project as one file, csv or json: both forms, this project only
  const exp = (body, token = ownerToken) => call('POST', '/api/onboard/p-club/export', { token, json: body });
  const ej = (await exp({ format: 'json' })).json, data = JSON.parse(ej.text);
  assert.deepEqual([ej.n, /^onboarding-p-club-\d{4}-\d\d-\d\d\.json$/.test(ej.filename), data.project, data.people], [2, true, { id: 'p-club', name: 'Клуб' }, 2]);
  assert.deepEqual(data.forms.map((f) => [f.id, f.kind, f.people.length]), [['ecochakra-club', 'invite', 2]]);
  const pIda = data.forms[0].people.find((x) => x.telegramId === String(IDA.id));
  assert.deepEqual([pIda.username, pIda.answers['3.1'], pIda.contact, /^\d{4}-/.test(pIda.consentAt)], ['ida_body', 'Батуми, Грузия', 'jn-' + IDA.id, true]);
  assert.ok(data.forms[0].questions.find((q) => q.id === '0.1').options.includes(MASTER));
  const ec = (await exp({ format: 'csv' })).json, lines = ec.text.split('\r\n');
  assert.match(ec.filename, /\.csv$/); assert.equal(lines.length, 3);
  assert.match(lines[0], /^\ufeff"Анкета","Дата"[\s\S]*"0\.1 Кто вы\?"[\s\S]*"3\.1 /); assert.ok(lines.some((l) => /"ЭкоЧакра: клуб".*"@ida_body".*"Батуми, Грузия"/.test(l)));
  n = tgCalls.length;
  assert.deepEqual((await exp({ format: 'json', send: true })).json, { ok: true, n: 2, sent: true });
  assert.match(sinceMark(n, 'sendDocument')[0].params.caption, /Онбординг проекта «Клуб»: ответов 2, формат JSON/);
  const net = JSON.parse((await call('POST', '/api/onboard/p-net/export', { token: ownerToken, json: { format: 'json' } })).json.text);
  assert.ok(net.forms.every((f) => f.kind === 'team') && net.forms[0].people.length >= 3 && net.forms[0].polls.length === 2, 'another project: its own people, with the polls');
  assert.equal((await exp({ format: 'csv' }, bobToken)).status, 403);
  assert.equal((await call('POST', '/api/onboard/p-india/export', { token: ownerToken, json: {} })).status, 409);
  n = tgCalls.length;
  await update(msg(OWNER, { text: '/answers json клуб' }));
  assert.match(sinceMark(n, 'sendDocument')[0].params.caption, /«Клуб»: ответов 2, формат JSON/);
  await update(msg(OWNER, { text: '/answers Клуб' }));
  assert.match(sinceMark(n, 'sendDocument')[1].params.caption, /«Клуб»: ответов 2\. Открывается/);
  // each link is switched off on its own
  assert.equal((await call('DELETE', '/api/onboard/p-club', { token: ownerToken })).json.invite.link.url, v.invite.link.url);
  assert.equal((await call('GET', '/api/join/' + teamTok)).status, 404); assert.equal((await call('GET', '/api/join/' + tok)).status, 200);
  assert.equal((await call('DELETE', '/api/onboard/p-club?form=invite', { token: ownerToken })).json.invite.link, null);
  assert.equal((await call('GET', '/api/join/' + tok)).status, 404);
  assert.equal((await post(tok, '/submit', { initData: initData(JON), part: 'core', agree: true, answers: base })).status, 404);
  const back = (await ob('POST', 'p-club', { form: 'invite' })).json;
  assert.match(back.invite.link.url, /start=join_/); assert.notEqual(back.invite.link.url, v.invite.link.url);
  await update(msg(OWNER, { text: '/club off Клуб' }));
  assert.match(lastSay().params.text, /Приглашение в <b>Клуб<\/b> выключено/);
  assert.equal((await ob('GET', 'p-club')).json.invite.link, null);
  // cards made before the team was kept on the card get it once, by the answers of the team form
  const gus = (await contacts()).find((d) => d.id === 'jn-777011');
  await call('PUT', '/api/db/contacts/jn-777011', { token: ownerToken, json: { data: Object.assign({}, gus.data, { team: undefined, rel: '' }) } });
  await dbm.kvSet('team.oncard', null);
  assert.ok((await join.migrateTeam()) >= 1);
  assert.deepEqual((await contacts()).find((d) => d.id === 'jn-777011').data.team, ['p-net']);
  assert.ok(!(await contacts()).find((d) => d.id === 'jn-' + IDA.id).data.team.includes('p-net'));
  assert.equal(await join.migrateTeam(), 0, 'only once');
});

test('call links: a Zoom link appears by itself when a meeting is made', async () => {
  const put = (path, data) => call('PUT', '/api/db/' + path, { token: ownerToken, json: { data } });
  const ev = async (id) => (await call('GET', '/api/db/events', { token: ownerToken })).json.docs.find((d) => d.id === id).data;
  await call('PATCH', '/api/db/settings/main', { token: ownerToken, json: { data: { meet: { zoom: 'https://zoom.us/j/555', meet: 'https://meet.google.com/own-room' } } } });
  // without Zoom keys: the owner's permanent link is put in
  assert.equal((await call('GET', '/api/me', { token: ownerToken })).json.app.zoom, false);
  await put('events/e-z1', { title: 'Созвон без ключей', date: '2031-07-01', time: '15:30', call: 'zoom' });
  assert.equal((await ev('e-z1')).link, 'https://zoom.us/j/555');
  await put('events/e-g1', { title: 'В Meet', date: '2031-07-01', time: '16:00', call: 'meet' });
  assert.equal((await ev('e-g1')).link, 'https://meet.google.com/own-room');
  await put('events/e-o1', { title: 'Своя ссылка', date: '2031-07-01', time: '17:00', call: 'zoom', link: 'https://zoom.us/j/777' });
  assert.equal((await ev('e-o1')).link, 'https://zoom.us/j/777', 'a link that is given stays');
  await put('events/e-n1', { title: 'Не созвон', date: '2031-07-01', time: '18:00' });
  assert.equal((await ev('e-n1')).link, undefined);
  // with the keys of a Zoom app: every meeting gets a room of its own
  const seen = [];
  let fail = false, rooms = 9000;
  const zoom = await listen(async (req, res) => {
    const raw = (await body(req)).toString('utf8');
    seen.push({ url: req.url, auth: req.headers.authorization, body: raw });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok-1', token_type: 'bearer', expires_in: 3600 }));
    if (fail) { res.statusCode = 500; return res.end(JSON.stringify({ code: 500, message: 'down' })); }
    rooms++;
    res.statusCode = 201;
    res.end(JSON.stringify({ id: rooms, join_url: 'https://zoom.us/j/' + rooms + '?pwd=x' }));
  });
  const root = 'http://127.0.0.1:' + zoom.address().port;
  Object.assign(process.env, { ZOOM_ACCOUNT_ID: 'acc', ZOOM_CLIENT_ID: 'cid', ZOOM_CLIENT_SECRET: 'sec', ZOOM_AUTH_ROOT: root, ZOOM_API_ROOT: root + '/v2' });
  try {
    assert.equal((await call('GET', '/api/me', { token: ownerToken })).json.app.zoom, true);
    await put('events/e-z2', { title: 'Zoom-встреча', date: '2031-07-02', time: '15:30', call: 'zoom', share: 'zoomsharetoken1234' });
    const z2 = await ev('e-z2');
    assert.deepEqual([z2.link, z2.zoomId], ['https://zoom.us/j/9001?pwd=x', '9001']);
    assert.deepEqual([seen[0].url, seen[0].auth, seen[0].body], ['/oauth/token', 'Basic ' + Buffer.from('cid:sec').toString('base64'), 'grant_type=account_credentials&account_id=acc']);
    assert.deepEqual([seen[1].url, seen[1].auth], ['/v2/users/me/meetings', 'Bearer tok-1']);
    const tz = await require('../src/clock').appTz();
    assert.deepEqual(JSON.parse(seen[1].body), { topic: 'Zoom-встреча', type: 2, start_time: '2031-07-02T15:30:00', timezone: tz, duration: 60 });
    // the key is asked once; a repeating meeting gets a room that stays open; saving again makes no second room
    await put('events/e-z3', { title: 'Каждую неделю', date: '2031-07-03', time: '10:00', repeat: 'weekly', call: 'zoom' });
    assert.deepEqual(JSON.parse(seen[2].body), { topic: 'Каждую неделю', type: 3 });
    assert.equal(seen.filter((x) => x.url === '/oauth/token').length, 1);
    await call('PATCH', '/api/db/events/e-z2', { token: ownerToken, json: { data: { title: 'Zoom-встреча, перенос' } } });
    assert.equal(seen.length, 3);
    assert.equal((await ev('e-z2')).link, 'https://zoom.us/j/9001?pwd=x');
    // Zoom is down: the permanent link stands in
    fail = true;
    await put('events/e-z4', { title: 'Zoom лежит', date: '2031-07-04', time: '10:00', call: 'zoom' });
    assert.equal((await ev('e-z4')).link, 'https://zoom.us/j/555');
    fail = false;
    // Claude in the bot makes a meeting with only «zoom»: the link comes back to him ready
    aiScript.push({ content: [{ type: 'tool_use', id: 'tu_z', name: 'create', input: { collection: 'events', data: { title: 'Созвон от Claude', date: '2031-07-05', time: '12:00', call: 'zoom' } } }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Назначил.' }], stop_reason: 'end_turn' });
    await update(msg(OWNER, { text: '/ask назначь созвон в зуме 5 июля в 12' }));
    const back = aiSrv.last.body.messages;
    assert.match(back[back.length - 1].content[0].content, /"call_link":"https:\/\/zoom\.us\/j\/9\d{3}\?pwd=x"/);
    await update(msg(OWNER, { text: '/end' }));
    // the participant: the language, and the Zoom link at once
    const KIM = { id: 777401, first_name: 'Kim', language_code: 'en' };
    await update(msg(KIM, { text: '/start ev_zoomsharetoken1234' }));
    assert.match(lastSay().params.text, /Choose your language/);
    await update(tap(KIM, 'el:e-z2:en'));
    assert.match(lastSay().params.text, /^<b>Zoom-встреча, перенос<\/b>\nJul 2, 2031, 15:30 \(UTC[^)]*\)\n\nCall link: https:\/\/zoom\.us\/j\/9001\?pwd=x\nI'll send it again 5 minutes before the start\.\n\nI'll remind you 5 minutes before\./);
    assert.deepEqual([lastSay().params.reply_markup.inline_keyboard[0][0].text, lastSay().params.reply_markup.inline_keyboard[0][0].url], ['Join the call', 'https://zoom.us/j/9001?pwd=x']);
    const j = require('../src/journal'); await j.flush();
    const log = (await call('GET', '/api/db/audit', { token: ownerToken })).json.docs.flatMap((d) => d.data.items);
    assert.ok(log.some((e) => e.c === 'events' && e.by === 'Zoom' && e.f.includes('link')), 'the journal says where the link came from');
  } finally {
    ['ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'ZOOM_AUTH_ROOT', 'ZOOM_API_ROOT'].forEach((k) => { delete process.env[k]; });
    zoom.close();
  }
  for (const id of ['e-z1', 'e-g1', 'e-o1', 'e-n1', 'e-z2', 'e-z3', 'e-z4']) await call('DELETE', '/api/db/events/' + id, { token: ownerToken });
});

test('Google Meet: the owner signs in once, a Meet call gets a room, the team gets the link', async () => {
  const put = async (path, data) => call('PUT', '/api/db/' + path, { token: ownerToken, json: { data } });
  const ev = async (id) => (await call('GET', '/api/db/events', { token: ownerToken })).json.docs.find((d) => d.id === id).data;
  const google = require('../src/google'), db = require('../src/db');
  const FAY = { id: 777010, first_name: 'Fay', last_name: 'Mason', username: 'fay_hub' };
  const seen = []; let rooms = 0, grant = 'ok', withRefresh = true;
  const g = http.createServer(async (req, res) => {
    const body = Buffer.concat(await req.toArray()).toString('utf8');
    seen.push({ url: req.url, auth: req.headers.authorization || '', body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/token') {
      const b = new URLSearchParams(body);
      if (b.get('grant_type') === 'authorization_code') {
        if (b.get('code') !== 'good-code') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad code' })); }
        return res.end(JSON.stringify(Object.assign({ access_token: 'acc-1', expires_in: 3600, scope: google.SCOPE }, withRefresh ? { refresh_token: 'ref-1' } : {})));
      }
      if (grant !== 'ok') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_grant' })); }
      return res.end(JSON.stringify({ access_token: 'acc-2', expires_in: 3600 }));
    }
    if (req.url === '/v2/spaces' && req.method === 'POST') { rooms++; return res.end(JSON.stringify({ name: 'spaces/s' + rooms, meetingUri: 'https://meet.google.com/abc-' + rooms, meetingCode: 'abc-' + rooms })); }
    res.statusCode = 404; res.end('{}');
  }).listen(0);
  const root = 'http://127.0.0.1:' + g.address().port;
  try {
    // without keys: the bot explains the setup and names the address Google must return to
    assert.equal((await call('GET', '/api/me', { token: ownerToken })).json.app.meet, false);
    await update(msg(OWNER, { text: '/google' }));
    assert.match(lastSay().params.text, /Google Meet REST API[\s\S]*https:\/\/prooloog\.test\/api\/google\/callback[\s\S]*GOOGLE_CLIENT_ID/);
    assert.match((await call('GET', '/api/google/callback?code=x&state=y')).text, /Google не настроен/);
    Object.assign(process.env, { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec', GOOGLE_AUTH_URL: root + '/auth', GOOGLE_TOKEN_URL: root + '/token', GOOGLE_MEET_ROOT: root + '/v2' });
    // not connected yet: a Meet call takes the owner's standing link, as before
    await call('PATCH', '/api/db/settings/main', { token: ownerToken, json: { data: { meet: { meet: 'https://meet.google.com/standing' } } } });
    await put('events/e-g0', { title: 'До входа', date: '2031-08-01', time: '10:00', call: 'meet' });
    assert.equal((await ev('e-g0')).link, 'https://meet.google.com/standing');
    await call('PATCH', '/api/db/settings/main', { token: ownerToken, json: { data: { meet: { meet: '', zoom: '' } } } });
    await put('events/e-g1', { title: 'Ждёт ссылку', date: '2031-08-02', time: '11:00', call: 'meet', project: 'p-net' });
    assert.equal((await ev('e-g1')).link || '', '');
    // only the owner gets the sign-in button; the link asks Google for one narrow permission, offline
    await update(msg(FAY, { text: '/google' }));
    assert.doesNotMatch(lastSay().params.text, /Войди в Google/);
    await update(msg(OWNER, { text: '/google' }));
    const u = new URL(lastSay().params.reply_markup.inline_keyboard[0][0].url), state = u.searchParams.get('state');
    assert.deepEqual([u.origin + u.pathname, u.searchParams.get('client_id'), u.searchParams.get('redirect_uri'), u.searchParams.get('scope'), u.searchParams.get('access_type'), u.searchParams.get('prompt'), u.searchParams.get('response_type')],
      [root + '/auth', 'gid', 'https://prooloog.test/api/google/callback', google.SCOPE, 'offline', 'consent', 'code']);
    // a wrong state, a refusal and a bad code connect nothing
    assert.match((await call('GET', '/api/google/callback?code=good-code&state=wrong')).text, /устарела/);
    assert.match((await call('GET', '/api/google/callback?error=access_denied&state=' + state)).text, /Вход отменён/);
    assert.match((await call('GET', '/api/google/callback?code=bad&state=' + state)).text, /Bad code/);
    assert.equal((await google.status()).connected, false);
    // the state is good for one try: a new link, and this time Google gives the keys
    await update(msg(OWNER, { text: '/google' }));
    const state2 = new URL(lastSay().params.reply_markup.inline_keyboard[0][0].url).searchParams.get('state');
    assert.notEqual(state2, state);
    let n = tgCalls.length;
    const okPage = await call('GET', '/api/google/callback?code=good-code&state=' + state2);
    assert.match(okPage.text, /Google подключён/);
    const tokenCall = seen.filter((x) => x.url === '/token').pop(), tb = new URLSearchParams(tokenCall.body);
    assert.deepEqual([tb.get('client_id'), tb.get('client_secret'), tb.get('code'), tb.get('grant_type'), tb.get('redirect_uri')], ['gid', 'gsec', 'good-code', 'authorization_code', 'https://prooloog.test/api/google/callback']);
    assert.equal((await db.kvGet('google.oauth')).refresh, 'ref-1');
    assert.equal((await call('GET', '/api/me', { token: ownerToken })).json.app.meet, true);
    // the meeting that was waiting got its room at once; the bot says so and offers to tell the team
    const g1 = await ev('e-g1');
    assert.deepEqual([g1.link, g1.meetId], ['https://meet.google.com/abc-1', 'spaces/s1']);
    const told = sinceMark(n, 'sendMessage').find((c) => String(c.params.chat_id) === String(OWNER.id));
    assert.match(told.params.text, /Google подключён[\s\S]*Ждёт ссылку: https:\/\/meet\.google\.com\/abc-1/);
    assert.equal(told.params.reply_markup.inline_keyboard[0][0].callback_data, 'an:e-g1');
    assert.equal((await call('GET', '/api/google/callback?code=good-code&state=' + state2)).text.includes('устарела'), true);
    // a new Meet call gets a room of its own; a call that has a link keeps it; other kinds are left alone
    await put('events/e-g2', { title: 'Своя комната', date: '2031-08-03', time: '12:00', call: 'meet' });
    assert.equal((await ev('e-g2')).link, 'https://meet.google.com/abc-2');
    assert.equal(seen.filter((x) => x.url === '/v2/spaces').pop().auth, 'Bearer acc-1');
    await put('events/e-g2', Object.assign(await ev('e-g2'), { time: '13:00' }));
    await put('events/e-g3', { title: 'Со своей ссылкой', date: '2031-08-03', call: 'meet', link: 'https://meet.google.com/mine' });
    await put('events/e-g4', { title: 'Без созвона', date: '2031-08-03' });
    assert.deepEqual([(await ev('e-g2')).link, (await ev('e-g3')).link, (await ev('e-g4')).link || '', rooms], ['https://meet.google.com/abc-2', 'https://meet.google.com/mine', '', 2]);
    assert.equal((await ev('e-g0')).link, 'https://meet.google.com/standing');
    // the team of the project gets the meeting with its link; only the owner can send it
    n = tgCalls.length;
    await update(tap(FAY, 'an:e-g1'));
    assert.equal(sinceMark(n, 'sendMessage').length, 0);
    await update(tap(OWNER, 'an:e-g1'));
    const out = sinceMark(n, 'sendMessage').map((c) => [String(c.params.chat_id), c.params.text]);
    const team = (await require('../src/join').teamOf('p-net')).map((d) => d.data.tg).sort();
    assert.ok(team.includes(String(FAY.id)) && !team.includes(String(OWNER.id)));
    assert.deepEqual(out.filter((x) => /Ждёт ссылку/.test(x[1]) && x[0] !== String(OWNER.id)).map((x) => x[0]).sort(), team);
    // each person gets a button of their own into the call instead of the bare link, and the meeting becomes the whole team's
    assert.match(out.find((x) => x[0] === String(FAY.id))[1], /<b>Ждёт ссылку<\/b>\n2 августа, 11:00 \(UTC[+−][\d:]+\)\n\nПроект «Сеть мастеров»\n\nВходи в созвон по кнопке ниже/);
    assert.doesNotMatch(out.find((x) => x[0] === String(FAY.id))[1], /meet\.google\.com/);
    const fayKb = sinceMark(n, 'sendMessage').find((c) => String(c.params.chat_id) === String(FAY.id)).params.reply_markup.inline_keyboard;
    assert.match(fayKb[0][0].url, new RegExp('^https://prooloog\\.test/c/e-g1/' + FAY.id + '/[A-Za-z0-9_-]{22}$'));
    assert.deepEqual(fayKb[1].map((b) => b.callback_data), ['at:e-g1:20310802:y', 'at:e-g1:20310802:n']);
    assert.equal((await ev('e-g1')).team, true);
    assert.match(out.find((x) => x[0] === String(OWNER.id))[1], new RegExp('получили ' + team.length + ' из ' + team.length));
    await update(tap(OWNER, 'an:e-g4'));
    assert.match(lastSay().params.text, /рассылать некому|нет ссылки/);
    await update(msg(OWNER, { text: '/announce' }));
    assert.ok(lastSay().params.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'an:e-g1'));
    // the access token is renewed with the stored key; when Google refuses the key, the owner is told once and the standing link is used
    await put('events/e-g5', { title: 'Свежий ключ', date: '2031-08-04', call: 'meet' });
    assert.equal((await ev('e-g5')).link, 'https://meet.google.com/abc-3');
    google.forgetAccess();
    await put('events/e-g6', { title: 'Обновление ключа', date: '2031-08-04', call: 'meet' });
    const refresh = new URLSearchParams(seen.filter((x) => x.url === '/token').pop().body);
    assert.deepEqual([refresh.get('grant_type'), refresh.get('refresh_token'), (await ev('e-g6')).link], ['refresh_token', 'ref-1', 'https://meet.google.com/abc-4']);
    assert.equal(seen.filter((x) => x.url === '/v2/spaces').pop().auth, 'Bearer acc-2');
    grant = 'gone'; google.forgetAccess(); n = tgCalls.length;
    await call('PATCH', '/api/db/settings/main', { token: ownerToken, json: { data: { meet: { meet: 'https://meet.google.com/standing' } } } });
    await put('events/e-g7', { title: 'Ключ отозван', date: '2031-08-05', call: 'meet' });
    await put('events/e-g8', { title: 'Ключ отозван 2', date: '2031-08-05', call: 'meet' });
    assert.deepEqual([(await ev('e-g7')).link, (await ev('e-g8')).link], ['https://meet.google.com/standing', 'https://meet.google.com/standing']);
    assert.equal(sinceMark(n, 'sendMessage').filter((c) => /войди заново/.test(c.params.text)).length, 1);
    assert.deepEqual([(await google.status()).connected, (await google.status()).broken], [false, true]);
    await update(msg(OWNER, { text: '/google' }));
    assert.match(lastSay().params.text, /перестал принимать прежний вход/);
    // Google gave no long-lived key: nothing is stored; switching off forgets the key
    withRefresh = false;
    const state3 = new URL(lastSay().params.reply_markup.inline_keyboard[0][0].url).searchParams.get('state');
    assert.match((await call('GET', '/api/google/callback?code=good-code&state=' + state3)).text, /не выдал долгий ключ/);
    await update(msg(OWNER, { text: '/google off' }));
    assert.match(lastSay().params.text, /Google отключён/);
    assert.equal((await db.kvGet('google.oauth')).refresh, undefined);
  } finally {
    ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_AUTH_URL', 'GOOGLE_TOKEN_URL', 'GOOGLE_MEET_ROOT'].forEach((k) => { delete process.env[k]; });
    await call('PATCH', '/api/db/settings/main', { token: ownerToken, json: { data: { meet: { meet: '', zoom: '' } } } });
    g.close();
  }
});

test('journal: who did what with the data, kept by the server, outside copies', async () => {
  const journal = require('../src/journal');
  const put = (path, data, token = ownerToken) => call('PUT', '/api/db/' + path, { token, json: { data } });
  const patch = (path, data, token = ownerToken) => call('PATCH', '/api/db/' + path, { token, json: { data } });
  const entries = async () => { await journal.flush(); return (await call('GET', '/api/db/audit', { token: ownerToken })).json.docs.flatMap((d) => d.data.items); };
  await journal.flush();
  const from = (await entries()).length;
  const fresh = async () => (await entries()).slice(from);
  // the earlier tests left their trace: chats, invitations, the connector
  const old = await entries();
  assert.ok(old.some((e) => e.a === 'acc' && /Вход по приглашению: Carol[\s\S]*зритель/.test(e.n)), 'an invitation used');
  assert.ok(old.some((e) => e.a === 'acc' && /Доступ закрыт: Carol/.test(e.n)));
  assert.ok(old.some((e) => e.a === 'bulk' && /Бот добавлен в чат «Команда EcoChakra»/.test(e.n) && e.by === 'Наташа'));
  assert.ok(old.some((e) => e.c === 'messages' && e.a === 'add' && e.by === 'чат «Команда EcoChakra»' && /^Чат «Команда EcoChakra»/.test(e.n)), 'a day of chat talk is one line');
  assert.equal(old.filter((e) => e.c === 'messages' && e.by === 'чат «Команда EcoChakra»' && e.n === 'Чат «Команда EcoChakra»').length, 1, 'not a line per message');
  assert.ok(old.some((e) => e.c === 'messages' && e.by === 'чат «Команда EcoChakra»: Наташа' && e.n === 'Собрать список участников'));
  assert.ok(old.some((e) => e.by === 'Claude'), 'what Claude wrote through the connector is signed');
  assert.ok(old.some((e) => e.c === 'chats' && e.a === 'upd' && e.f.includes('project')));
  assert.ok(!old.some((e) => ['activity', 'usage', 'gone', 'audit', 'evsubs'].includes(e.c)), 'bookkeeping is not an action');

  // the owner: add, change, a change of state, a move in a list, a deletion
  await put('projects/p-j', { name: 'Журнал', status: 'active', order: 90 });
  await put('tasks/t-j', { title: 'Проверить журнал', project: 'p-j', status: 'todo', order: 1 });
  await patch('tasks/t-j', { status: 'done', due: '2031-05-01' });
  await patch('tasks/t-j', { order: 7 });
  await patch('tasks/t-j', { status: 'done' });
  await put('tasks/t-j', { title: 'Проверить журнал', project: 'p-j', status: 'done', due: '2031-05-01', order: 7, notes: 'готово' });
  // a guest editor of this project
  const DAN = { id: 777201, first_name: 'Dan', username: 'dan_j' };
  const link = await call('POST', '/api/share/links', { token: ownerToken, json: { role: 'editor', projects: ['p-j'] } });
  await update(msg(DAN, { text: '/start inv_' + link.json.token }));
  const dan = (await call('POST', '/api/auth/telegram', { json: { initData: initData(DAN) } })).json.token;
  await put('tasks/t-j2', { title: 'Задача гостя', project: 'p-j', status: 'todo' }, dan);
  await call('DELETE', '/api/db/tasks/t-j2', { token: dan });
  await call('DELETE', '/api/db/tasks/t-j', { token: ownerToken });
  const got = (await fresh()).map((e) => [e.a, e.c || '', e.n, (e.f || []).join(','), e.s || '', e.by || '', e.p || '']);
  assert.deepEqual(got, [
    ['add', 'projects', 'Журнал', '', '', '', ''],
    ['add', 'tasks', 'Проверить журнал', '', '', '', 'p-j'],
    ['upd', 'tasks', 'Проверить журнал', 'status,due', 'done', '', 'p-j'],
    ['upd', 'tasks', 'Проверить журнал', 'notes', '', '', 'p-j'],
    ['acc', '', 'Создана ссылка-приглашение: редактировать, проектов: 1', '', '', '', ''],
    ['acc', '', 'Вход по приглашению: Dan (@dan_j) — Журнал, редактор', '', '', '', ''],
    ['add', 'tasks', 'Задача гостя', '', '', 'Dan', 'p-j'],
    ['del', 'tasks', 'Задача гостя', '', '', 'Dan', 'p-j'],
    ['del', 'tasks', 'Проверить журнал', '', '', '', 'p-j'],
  ], 'a move in a list and a change that changes nothing leave no line');
  assert.ok((await fresh()).every((e) => /^\d{4}-\d\d-\d\dT/.test(e.t)));
  // only the owner reads it, nobody writes it by hand
  assert.equal((await call('GET', '/api/db/audit', { token: dan })).status, 403);
  assert.equal((await call('GET', '/api/db/audit', { token: bobToken })).status, 403);
  assert.equal((await put('audit/s20310101', { items: [] })).status, 403);
  assert.equal((await call('DELETE', '/api/db/audit/s20310101', { token: ownerToken })).status, 403);
  // it stays out of copies and survives a copy being loaded
  const copy = (await call('GET', '/api/export', { token: ownerToken })).json;
  assert.equal(copy.docs.audit, undefined);
  const before = (await entries()).length;
  assert.equal((await call('POST', '/api/import', { token: ownerToken, json: { app: 'prooloog', docs: copy.docs, mode: 'replace' } })).status, 200);
  const after = await entries();
  assert.equal(after.length, before + 1);
  assert.match(after[after.length - 1].n, /^Данные заменены копией: записей \d+$/);
  // one record per day, in the order things happened
  const docs = (await call('GET', '/api/db/audit', { token: ownerToken })).json.docs;
  assert.ok(docs.every((d) => /^s\d{8}(-\d+)?$/.test(d.id) && /^\d{4}-\d\d-\d\d$/.test(d.data.date)));
  await call('DELETE', '/api/share/members/' + DAN.id, { token: ownerToken });
  await call('DELETE', '/api/db/projects/p-j', { token: ownerToken });
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

test('avatars: the Telegram photo of a person gets to the access list, the contact card and the settings', async () => {
  const db = require('../src/db'), avatar = require('../src/avatar');
  const ZOE = 888001, jpeg = (n, fill) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, fill)]);
  const asked = (from) => sinceMark(from, 'getUserProfilePhotos').length;
  await db.upsertMember(ZOE, 'zoe_team', 'Zoe Team', 'editor');
  await db.setDoc('contacts', 'jn-' + ZOE, { name: 'Zoe Team', tg: '@zoe_team', projects: [], notes: '', u: '2026-01-01T00:00:00.000Z' });
  const card = async () => (await db.getDoc('contacts', 'jn-' + ZOE)).data;
  const listed = async () => (await call('GET', '/api/share', { token: ownerToken })).json.members.find((m) => m.id === String(ZOE));

  // no photo (or a photo closed by privacy settings): nothing is stored, the page draws initials
  await avatar.refresh(ZOE);
  assert.equal(await avatar.urlOf(ZOE), '');
  assert.equal((await listed()).photo, '');
  assert.equal((await card()).photo, undefined);
  assert.equal((await card()).u, '2026-01-01T00:00:00.000Z', 'a card without a photo is not touched');

  // a small photo: kept on the server, on the card as a data URI (the copy inside Claude shows only those)
  tgFiles['files/zs1'] = jpeg(2000, 1); tgFiles['files/zb1'] = jpeg(90000, 2);
  tgPhotos[ZOE] = [{ file_id: 'zb1', file_unique_id: 'Ub1', width: 640, height: 640 }, { file_id: 'zs1', file_unique_id: 'Us1', width: 160, height: 160 }];
  let n = tgCalls.length;
  await avatar.refresh(ZOE);
  assert.equal(asked(n), 0, 'asked a moment ago: Telegram is not asked again for a few days');
  await avatar.refresh(ZOE, { force: true });
  const url1 = await avatar.urlOf(ZOE);
  assert.match(url1, /^\/f\/[\w-]{8,40}$/);
  assert.equal((await listed()).photo, url1);
  const pic = await fetch(BASE + url1);
  assert.equal(pic.headers.get('content-type'), 'image/jpeg');
  assert.ok(Buffer.from(await pic.arrayBuffer()).equals(tgFiles['files/zs1']), 'the smallest size is taken');
  assert.equal((await card()).photo, 'data:image/jpeg;base64,' + tgFiles['files/zs1'].toString('base64'));
  assert.ok((await card()).u > '2026-11-01', 'the card counts as changed, so a sync carries the photo');
  assert.ok(!JSON.stringify(await card()).includes(BOT) && !url1.includes(BOT), 'the bot token never reaches a page');

  // the same photo again: no second copy; the card is left alone
  const u1 = (await card()).u;
  n = tgCalls.length;
  await avatar.refresh(ZOE, { force: true });
  assert.equal(asked(n), 1);
  assert.equal(sinceMark(n, 'getFile').length, 0);
  assert.equal(await avatar.urlOf(ZOE), url1);
  assert.equal((await card()).u, u1);

  // the owner edits the card in the dashboard: the photo stays
  await call('PATCH', '/api/db/contacts/jn-' + ZOE, { token: ownerToken, json: { data: { role: 'Дизайнер' } } });
  assert.match((await card()).photo, /^data:image\/jpeg/);

  // a new photo, too big for a record: the card gets the link, the old file is gone
  tgFiles['files/zs2'] = jpeg(20000, 3);
  tgPhotos[ZOE] = [{ file_id: 'zs2', file_unique_id: 'Us2', width: 160, height: 160 }];
  await avatar.refresh(ZOE, { force: true });
  const url2 = await avatar.urlOf(ZOE);
  assert.notEqual(url2, url1);
  assert.equal((await card()).photo, url2);
  assert.equal((await fetch(BASE + url1)).status, 404);
  assert.equal((await fetch(BASE + url2)).status, 200);

  // something that is not a picture is not stored; what was there stays
  tgFiles['files/zx'] = Buffer.from('<html>not a picture</html>');
  tgPhotos[ZOE] = [{ file_id: 'zx', file_unique_id: 'Ux', width: 160, height: 160 }];
  await assert.rejects(avatar.refresh(ZOE, { force: true }), /not a JPEG/);
  assert.equal(await avatar.urlOf(ZOE), url2);

  // the photo is removed in Telegram: it leaves the card and the list
  delete tgPhotos[ZOE];
  await avatar.refresh(ZOE, { force: true });
  assert.equal(await avatar.urlOf(ZOE), '');
  assert.equal((await card()).photo, undefined);
  assert.equal((await fetch(BASE + url2)).status, 404);

  // the owner's own photo goes to the settings; signing in asks for it without holding the sign-in up
  tgFiles['files/os1'] = jpeg(1500, 4);
  tgPhotos[OWNER.id] = [{ file_id: 'os1', file_unique_id: 'Uo1', width: 160, height: 160 }];
  await db.kvSet('avatar:' + OWNER.id, { at: '', uid: '', url: '' });
  assert.equal((await call('POST', '/api/auth/telegram', { json: { initData: initData(OWNER) } })).status, 200);
  for (let i = 0; i < 50 && !(await avatar.urlOf(OWNER.id)); i++) await new Promise((r) => setTimeout(r, 40));
  assert.match(await avatar.urlOf(OWNER.id), /^\/f\//);
  for (let i = 0; i < 50 && !((await db.getDoc('settings', 'main')).data.photo); i++) await new Promise((r) => setTimeout(r, 40));
  const st = (await db.getDoc('settings', 'main')).data;
  assert.equal(st.photo, 'data:image/jpeg;base64,' + tgFiles['files/os1'].toString('base64'));
  assert.ok(st.tz !== undefined || st.capacity !== undefined || Object.keys(st).length > 2, 'the other settings are kept');

  // a failure on Telegram's side never fails the caller
  avatar.soon('not-an-id');
  await db.removeMember(ZOE); await db.deleteDoc('contacts', 'jn-' + ZOE);
});

test('coordinator: runs chosen projects next to the owner, without the irreversible', async () => {
  const db = require('../src/db'), journal = require('../src/journal');
  const KIM = { id: 777031, first_name: 'Kim', username: 'kim_coord' }, LEE = { id: 777032, first_name: 'Lee', username: 'lee_editor' }, MAX = { id: 777033, first_name: 'Max', username: 'max_coord' };
  const put = (path, data, token = ownerToken) => call('PUT', '/api/db/' + path, { token, json: { data } });
  const patch = (path, data, token = ownerToken) => call('PATCH', '/api/db/' + path, { token, json: { data } });
  const del = (path, token = ownerToken) => call('DELETE', '/api/db/' + path, { token });
  const signIn = async (u) => (await call('POST', '/api/auth/telegram', { json: { initData: initData(u) } })).json;
  await put('projects/p-co', { name: 'Сеть', status: 'active', order: 60 });
  await put('projects/p-own', { name: 'Личное', status: 'active', order: 61 });
  await put('money/mo-co', { kind: 'in', amount: 100, cur: 'USD', project: 'p-co', title: 'Взнос' });
  await put('money/mo-own', { kind: 'in', amount: 900, cur: 'USD', project: 'p-own', title: 'Гонорар' });
  await put('money/mo-free', { kind: 'out', amount: 5, cur: 'USD', title: 'Без проекта' });
  await put('contacts/c-in', { name: 'Только сеть', projects: ['p-co'], notes: 'Выжимка анкеты' });
  await put('contacts/c-both', { name: 'В двух', projects: ['p-co', 'p-own'], team: ['p-own'], notes: 'Личная заметка' });
  await put('contacts/c-out', { name: 'Чужой', projects: ['p-own'] });
  await put('messages/ms-co', { project: 'p-co', from: 'Клиент', text: 'Перенесём?', review: 'pending', proposal: { items: [{ t: 'next', to: 'Перенести встречу' }], by: 'page' }, file: { name: 'v.oga', kind: 'voice', tg: 'voicefile_co_123' } });
  await put('messages/ms-own', { project: 'p-own', from: 'Агент', text: 'Личное', review: 'pending', file: { name: 'w.oga', kind: 'voice', tg: 'voicefile_own_123' } });
  await put('chats/g9001', { tg: '-9001', title: 'Чат сети', project: 'p-co', collect: 'off', on: true });
  await put('chats/g9002', { tg: '-9002', title: 'Личный чат', project: 'p-own', collect: 'off', on: true });
  tgFiles['files/voicefile_co_123'] = Buffer.from('OggS-co'); tgFiles['files/voicefile_own_123'] = Buffer.from('OggS-own');
  // three people of the project come in as editors
  const link = async () => (await call('POST', '/api/share/links', { token: ownerToken, json: { role: 'editor', projects: ['p-co'] } })).json.token;
  for (const u of [KIM, LEE, MAX]) await update(msg(u, { text: '/start inv_' + await link() }));
  assert.equal((await signIn(KIM)).role, 'editor');
  assert.equal((await call('GET', '/api/db/money', { token: (await signIn(KIM)).token })).status, 403, 'an editor sees no money');

  // only the owner names a coordinator, and only with a list of projects
  const access = (id, body, token = ownerToken) => call('PATCH', '/api/share/members/' + id, { token, json: body });
  assert.equal((await access(KIM.id, { role: 'manager', projects: null })).status, 400, 'a coordinator of everything does not exist');
  assert.equal((await call('POST', '/api/share/links', { token: ownerToken, json: { role: 'manager', projects: ['p-co'] } })).status, 400, 'no link makes a coordinator');
  let n = tgCalls.length;
  assert.equal((await access(KIM.id, { role: 'manager', projects: ['p-co'] })).status, 200);
  assert.match(sinceMark(n, 'sendMessage').find((c) => String(c.params.chat_id) === String(KIM.id)).params.text, /координатор: Сеть/);
  assert.equal((await access(MAX.id, { role: 'manager', projects: ['p-co'] })).status, 200);
  const k = await signIn(KIM), kt = k.token;
  assert.equal(k.role, 'manager'); assert.deepEqual(k.projects, ['p-co']); assert.ok(k.managed.includes('money'));
  const ids = async (coll, token = kt) => (await call('GET', '/api/db/' + coll, { token })).json.docs.map((d) => d.id).sort();

  // the owner's collections, cut to the project
  assert.deepEqual(await ids('projects'), ['p-co']);
  assert.deepEqual(await ids('money'), ['mo-co']);
  assert.deepEqual(await ids('messages'), ['ms-co']);
  assert.deepEqual(await ids('chats'), ['g9001']);
  assert.deepEqual(await ids('contacts'), ['c-both', 'c-in']);
  const cards = (await call('GET', '/api/db/contacts', { token: kt })).json.docs;
  assert.equal(cards.find((d) => d.id === 'c-in').data.notes, 'Выжимка анкеты');
  const both = cards.find((d) => d.id === 'c-both').data;
  assert.deepEqual(both.projects, ['p-co']); assert.deepEqual(both.team, []); assert.equal(both.notes, '', 'notes of a shared card stay with the owner');
  for (const c of ['usage', 'activity', 'memory', 'gone', 'evsubs']) assert.equal((await call('GET', '/api/db/' + c, { token: kt })).status, 403, c);
  assert.equal((await call('GET', '/api/export', { token: kt })).status, 403);
  assert.equal((await call('POST', '/api/backup/send', { token: kt })).status, 403);

  // writing: inside the project yes, outside no
  assert.equal((await put('money/mo-k', { kind: 'out', amount: 20, cur: 'USD', project: 'p-co', title: 'Чай' }, kt)).status, 200);
  assert.equal((await put('money/mo-x', { kind: 'out', amount: 20, cur: 'USD', project: 'p-own' }, kt)).status, 403);
  assert.equal((await patch('money/mo-own', { amount: 1 }, kt)).status, 403);
  assert.equal((await patch('money/mo-co', { project: 'p-own' }, kt)).status, 403, 'a record does not leave the project');
  assert.equal((await put('settings/main', { capacity: 1 }, kt)).status, 403);
  // a shared card: the coordinator's change lands, what they could not see is kept
  assert.equal((await put('contacts/c-both', { name: 'В двух (сеть)', projects: [], team: ['p-co'], notes: '' }, kt)).status, 200);
  let cb = (await db.getDoc('contacts', 'c-both')).data;
  assert.deepEqual(cb.projects, ['p-own']); assert.deepEqual(cb.team.sort(), ['p-co', 'p-own']); assert.equal(cb.notes, 'Личная заметка'); assert.equal(cb.name, 'В двух (сеть)');
  assert.equal((await patch('contacts/c-both', { role: 'Мастер', notes: 'затёр?' }, kt)).status, 200);
  cb = (await db.getDoc('contacts', 'c-both')).data;
  assert.equal(cb.role, 'Мастер'); assert.equal(cb.notes, 'Личная заметка'); assert.deepEqual(cb.team.sort(), ['p-co', 'p-own']);
  assert.equal((await del('contacts/c-both', kt)).status, 403, 'a shared card is not theirs to delete');
  assert.equal((await put('contacts/c-out', { name: 'x', projects: ['p-co'] }, kt)).status, 403, 'a card they do not see');
  assert.equal((await put('contacts/c-new', { name: 'Новый', projects: [] }, kt)).status, 403, 'a card needs one of their projects');
  assert.equal((await put('contacts/c-new', { name: 'Новый', projects: ['p-co'] }, kt)).status, 200);
  assert.equal((await del('contacts/c-new', kt)).status, 200);

  // review: a coordinator applies a proposal, the journal names them
  await journal.flush();
  assert.equal((await patch('projects/p-co', { next: 'Перенести встречу' }, kt)).status, 200);
  assert.equal((await patch('messages/ms-co', { review: 'done', applied: [0], reviewedAt: new Date().toISOString() }, kt)).status, 200);
  await journal.flush();
  const lines = (await call('GET', '/api/db/audit', { token: kt })).json.docs.flatMap((d) => d.data.items);
  assert.ok(lines.length && lines.every((e) => e.p === 'p-co'), 'the journal of the project only');
  assert.ok(lines.some((e) => e.c === 'messages' && e.i === 'ms-co' && e.s === 'done' && e.by === 'Kim'), 'who reviewed');
  assert.equal((await put('audit/s20260101', { date: '2026-01-01', items: [] }, kt)).status, 403);

  // the irreversible stays with the owner
  assert.equal((await del('projects/p-co', kt)).status, 403, 'the project is not deleted');
  assert.equal((await put('projects/p-new', { name: 'Ещё один' }, kt)).status, 403);
  assert.equal((await access(MAX.id, { role: 'editor', projects: ['p-co'] }, kt)).status, 403, 'another coordinator is not lowered');
  assert.equal((await call('DELETE', '/api/share/members/' + MAX.id, { token: kt })).status, 403);
  assert.equal((await call('DELETE', '/api/share/members/' + KIM.id, { token: kt })).status, 403, 'nor themselves');
  assert.equal((await access(LEE.id, { role: 'manager', projects: ['p-co'] }, kt)).status, 400, 'a coordinator names no coordinators');
  assert.equal((await access(LEE.id, { role: 'editor', projects: ['p-co', 'p-own'] }, kt)).status, 400, 'nor opens other projects');
  assert.equal((await access(LEE.id, { role: 'editor', projects: null }, kt)).status, 400);

  // access inside the project: the two lower levels are theirs
  const sh = (await call('GET', '/api/share', { token: kt })).json;
  assert.deepEqual(sh.members.map((m) => [m.name, m.role, m.fixed]).sort(), [['Kim', 'manager', true], ['Lee', 'editor', false], ['Max', 'manager', true]]);
  assert.deepEqual(sh.names, []);
  assert.equal((await access(LEE.id, { role: 'viewer', projects: ['p-co'] }, kt)).status, 200);
  assert.equal((await signIn(LEE)).role, 'viewer');
  const kl = await call('POST', '/api/share/links', { token: kt, json: { role: 'editor', projects: ['p-co'] } });
  assert.equal(kl.status, 200);
  assert.equal((await call('POST', '/api/share/links', { token: kt, json: { role: 'editor', projects: ['p-own'] } })).status, 400);
  assert.equal((await call('POST', '/api/share/links', { token: kt, json: { role: 'editor' } })).status, 400, 'no link to everything');
  const ownerLink = (await call('POST', '/api/share/links', { token: ownerToken, json: { role: 'viewer', projects: ['p-own'] } })).json.token;
  assert.equal((await call('DELETE', '/api/share/links/' + ownerLink, { token: kt })).status, 403);
  assert.equal((await call('DELETE', '/api/share/links/' + kl.json.token, { token: kt })).json.ok, true);
  await call('DELETE', '/api/share/links/' + ownerLink, { token: ownerToken });
  assert.equal((await call('DELETE', '/api/share/members/' + LEE.id, { token: kt })).json.ok, true);
  assert.equal((await call('POST', '/api/auth/telegram', { json: { initData: initData(LEE) } })).status, 403);

  // onboarding, the work chat and voice: the project's only
  assert.equal((await call('GET', '/api/onboard/p-co', { token: kt })).status, 200);
  assert.equal((await call('GET', '/api/onboard/p-own', { token: kt })).status, 403);
  assert.equal((await call('POST', '/api/onboard/p-own', { token: kt, json: {} })).status, 403);
  assert.equal((await call('POST', '/api/onboard/p-co', { token: kt, json: {} })).status, 200);
  n = tgCalls.length;
  assert.equal((await call('POST', '/api/chats/g9001/post', { token: kt, json: { text: 'Встреча в пятницу' } })).status, 200);
  assert.ok(sinceMark(n, 'sendMessage').some((c) => String(c.params.chat_id) === '-9001' && /Встреча в пятницу/.test(c.params.text)));
  assert.equal((await call('POST', '/api/chats/g9002/post', { token: kt, json: { text: 'x' } })).status, 404);
  assert.equal((await call('GET', '/api/tg/file/voicefile_co_123?t=' + encodeURIComponent(kt))).text, 'OggS-co');
  assert.equal((await call('GET', '/api/tg/file/voicefile_own_123?t=' + encodeURIComponent(kt))).status, 404);

  // live: the project's money reaches the coordinator, the rest does not; a shared card comes cut
  const s = await openStream(kt);
  await put('money/mo-own2', { kind: 'in', amount: 1, cur: 'USD', project: 'p-own' });
  await put('contacts/c-both', Object.assign({}, cb, { phone: '+100' }));
  await put('money/mo-co2', { kind: 'in', amount: 2, cur: 'USD', project: 'p-co' });
  await new Promise((r) => setTimeout(r, 250));
  const got = s.events.filter((e) => e.event === 'doc').map((e) => e.data);
  assert.ok(got.some((e) => e.coll === 'money' && e.id === 'mo-co2'));
  assert.ok(!got.some((e) => e.id === 'mo-own2'));
  const live = got.find((e) => e.coll === 'contacts' && e.id === 'c-both');
  assert.equal(live.data.phone, '+100'); assert.equal(live.data.notes, ''); assert.deepEqual(live.data.projects, []);
  s.close();

  // a coordinator keeps the level: a link or a form does not change it, and adds no project
  n = tgCalls.length;
  const other = (await call('POST', '/api/share/links', { token: ownerToken, json: { role: 'viewer', projects: ['p-own'] } })).json.token;
  await update(msg(KIM, { text: '/start inv_' + other }));
  assert.match(lastSay().params.text, /Ты координатор/);
  const k2 = await signIn(KIM);
  assert.equal(k2.role, 'manager'); assert.deepEqual(k2.projects, ['p-co']);
  await call('DELETE', '/api/share/links/' + other, { token: ownerToken });
  // the owner takes the level back
  assert.equal((await access(KIM.id, { role: 'editor', projects: ['p-co'] })).status, 200);
  assert.equal((await call('GET', '/api/db/money', { token: kt })).status, 403);
  for (const u of [KIM, MAX]) await call('DELETE', '/api/share/members/' + u.id, { token: ownerToken });
});

test('preview: the owner and a coordinator see a form as a person will, nothing is saved', async () => {
  const db = require('../src/db');
  const PAT = { id: 777041, first_name: 'Pat', username: 'pat_coord' };
  const put = (path, data) => call('PUT', '/api/db/' + path, { token: ownerToken, json: { data } });
  await put('projects/p-pv', { name: 'Витрина сети', status: 'active', order: 70, show: 'Сеть пространств и мастеров.' });
  await put('projects/p-pv2', { name: 'Другой', status: 'active', order: 71 });
  const before = (await db.listDocs('joins')).length, links = (await db.listJoinLinks()).length;
  // the page itself is the form page; the form comes with a newcomer who has answered nothing
  assert.match((await call('GET', '/preview/p-pv')).text, /pvProject/);
  const team = await call('GET', '/api/onboard/p-pv/preview', { token: ownerToken });
  assert.equal(team.status, 200); assert.equal(team.json.preview, true); assert.equal(team.json.access, 'project');
  assert.equal(team.json.project, 'Витрина сети'); assert.ok(team.json.form.steps.length > 0);
  assert.deepEqual([team.json.me.joined, team.json.me.owner, team.json.me.answers], [false, false, {}]);
  assert.equal(team.json.show, null);
  assert.ok(team.json.me.polls.every((p) => p.mine.length === 0));
  // the invitation comes with its showcase: the project's own text for guests
  const inv = await call('GET', '/api/onboard/p-pv/preview?form=invite', { token: ownerToken });
  assert.equal(inv.json.access, 'card'); assert.equal(inv.json.show.text, 'Сеть пространств и мастеров.'); assert.equal(inv.json.me.people, 0);
  // no link is needed and none is made; nothing is written
  assert.equal((await db.listJoinLinks()).length, links); assert.equal((await db.listDocs('joins')).length, before);
  // who may look: the owner and the project's coordinator
  assert.equal((await call('GET', '/api/onboard/p-pv/preview')).status, 401);
  assert.equal((await call('GET', '/api/onboard/nope/preview', { token: ownerToken })).status, 404);
  const l = (await call('POST', '/api/share/links', { token: ownerToken, json: { role: 'editor', projects: ['p-pv'] } })).json.token;
  await update(msg(PAT, { text: '/start inv_' + l }));
  const ed = (await call('POST', '/api/auth/telegram', { json: { initData: initData(PAT) } })).json.token;
  assert.equal((await call('GET', '/api/onboard/p-pv/preview', { token: ed })).status, 403, 'an editor has no preview');
  await call('PATCH', '/api/share/members/' + PAT.id, { token: ownerToken, json: { role: 'manager', projects: ['p-pv'] } });
  assert.equal((await call('GET', '/api/onboard/p-pv/preview?form=invite', { token: ed })).status, 200);
  assert.equal((await call('GET', '/api/onboard/p-pv2/preview', { token: ed })).status, 403);
  await call('DELETE', '/api/share/members/' + PAT.id, { token: ownerToken });
});

test('work chat: the bot asks for the administrator\'s rights, hears voices, writes the feed', async () => {
  const groups = require('../src/groups'), stt = require('../src/stt');
  const GID = -1001234500777, CH = 'g1001234500777', chat = { id: GID, type: 'supergroup', title: 'Рабочая группа' };
  const ARJ = { id: 777201, first_name: 'Арджун', username: 'arjun_t' }, TASHA = { id: 777202, first_name: 'Таша' };
  const sec = () => Math.floor(Date.now() / 1000);
  const gmsg = (from, extra) => ({ update_id: ++mid, message: Object.assign({ message_id: ++mid, date: sec(), chat, from }, extra) });
  const gtap = (from, data) => ({ update_id: ++mid, callback_query: { id: 'cq' + (++mid), from, data, message: { message_id: 7100, chat } } });
  const member = (from, status) => ({ update_id: ++mid, my_chat_member: { chat, from, date: sec(), old_chat_member: { status: 'left', user: { id: 1, is_bot: true } }, new_chat_member: { status, user: { id: 1, is_bot: true } } } });
  const said = (n, chatId) => sinceMark(n).filter((c) => c.method === 'sendMessage' && String(c.params.chat_id) === String(chatId));
  const acks = (n) => sinceMark(n, 'answerCallbackQuery').map((c) => c.params);
  const docs = async (coll) => (await call('GET', '/api/db/' + coll, { token: ownerToken })).json.docs;
  const chatDoc = async () => (await docs('chats')).find((d) => d.id === CH).data;
  await call('PUT', '/api/db/projects/p-feed', { token: ownerToken, json: { data: { name: 'Лента Тест', status: 'active', order: 90, why: 'Сеть пространств' } } });
  await call('PUT', '/api/db/tasks/t-feed-1', { token: ownerToken, json: { data: { title: 'Старая открытая задача', project: 'p-feed', status: 'todo', order: 1 } } });
  tgAdmins[String(GID)] = [
    { status: 'administrator', user: { id: 777203, first_name: 'Без', username: 'no_rights' } },
    { status: 'administrator', can_promote_members: true, user: { id: TASHA.id, first_name: 'Таша' } },
    { status: 'creator', user: ARJ },
    { status: 'administrator', can_promote_members: true, user: { id: 9, is_bot: true, username: 'other_bot' } },
  ];
  delete tgMember['1'];

  // tied to a project while it is a plain member: the chat gets the request with the steps, and the people who can grant
  await update(member(ARJ, 'member'));
  let n = tgCalls.length;
  await update(tap(OWNER, 'gl:' + CH + ':p-feed'));
  const inChat = said(n, GID);
  assert.equal(inChat.length, 2, 'the greeting, then the request');
  const req = inChat[1].params;
  assert.match(req.text, /Мне нужны права администратора[\s\S]*только команды и ответы[\s\S]*«Лента Тест»[\s\S]*может создатель чата или администратор: @arjun_t, <a href="tg:\/\/user\?id=777202">Таша<\/a>\.[\s\S]*«Администраторы» → «Добавить администратора»[\s\S]*@prooloog_test_bot[\s\S]*видят только координаторы проекта/);
  assert.doesNotMatch(req.text, /no_rights|other_bot/, 'only those who can name an administrator');
  assert.deepEqual(req.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['gp:adm']);
  assert.match(said(n, OWNER.id).map((c) => c.params.text).join('\n'), /сделай меня администратором[\s\S]*попросил об этом в чате[\s\S]*\/admin/);
  assert.equal((await chatDoc()).adminAsk.n, 1);
  // not again at once, whatever the members write to it
  n = tgCalls.length;
  await update(gmsg(TASHA, { text: '/project' }));
  assert.equal(said(n, GID).length, 1, 'the card only');
  // /admin repeats the request, for the owner alone
  n = tgCalls.length;
  await update(gmsg(TASHA, { text: '/admin' }));
  assert.equal(said(n, GID).length, 0);
  await update(gmsg(OWNER, { text: '/admin' }));
  assert.match(said(n, GID)[0].params.text, /Мне нужны права администратора/);
  assert.equal((await chatDoc()).adminAsk.n, 2);
  // the button looks at the rights
  n = tgCalls.length;
  await update(gtap(TASHA, 'gp:adm'));
  assert.match(acks(n)[0].text, /пока нет/); assert.equal(acks(n)[0].show_alert, true);
  tgMember['1'] = 'error'; n = tgCalls.length;
  await update(gtap(TASHA, 'gp:adm'));
  assert.match(acks(n)[0].text, /не отвечает/);
  tgMember['1'] = 'administrator'; n = tgCalls.length;
  await update(gtap(TASHA, 'gp:adm'));
  assert.match(acks(n)[0].text, /Права есть/);
  assert.match(said(n, GID)[0].params.text, /Теперь я вижу все сообщения этого чата/);
  assert.equal((await chatDoc()).admin, true);
  n = tgCalls.length;
  await update(gtap(TASHA, 'gp:adm'));
  assert.equal(said(n, GID).length, 0, 'said once');
  await update(gmsg(OWNER, { text: '/admin' }));
  assert.match(said(n, GID)[0].params.text, /Права администратора у меня есть/);

  // after a restart: only a chat that never heard the request gets it, and only without the rights
  n = tgCalls.length;
  await groups.sweep();
  assert.equal(said(n, GID).length, 0);
  const G2 = -1001234500778, chat2 = { id: G2, type: 'supergroup', title: 'Вторая группа' };
  await update({ update_id: ++mid, my_chat_member: { chat: chat2, from: OWNER, date: sec(), old_chat_member: { status: 'left', user: { id: 1 } }, new_chat_member: { status: 'member', user: { id: 1 } } } });
  await update(tap(OWNER, 'gl:g1001234500778:p-feed'));
  await call('PATCH', '/api/db/chats/g1001234500778', { token: ownerToken, json: { data: { adminAsk: null, admin: false } } });
  tgMember['1'] = 'member'; n = tgCalls.length;
  await groups.sweep();
  assert.equal(said(n, G2).length, 1); assert.match(said(n, G2)[0].params.text, /права администратора/);
  assert.equal(said(n, GID).length, 0);
  await groups.sweep();
  assert.equal(said(n, G2).length, 1, 'once');
  await update({ update_id: ++mid, message: { message_id: ++mid, date: sec(), chat: chat2, from: OWNER, text: '/unlink' } });

  // a voice message gets its words; a forwarded one keeps the name of who spoke
  tgFiles['files/v-feed-1'] = Buffer.from('OggS-voice-one'); tgFiles['files/v-feed-2'] = Buffer.from('OggS-voice-two');
  sttCalls.length = 0; sttAnswer = { text: '  предлагаю   сделать кулоны с номерами ' };
  await update(gmsg(ARJ, { text: 'Утверждаем анкету завтра в 11' }));
  await update(gmsg(ARJ, { voice: { file_id: 'v-feed-1', duration: 54 } }));
  await stt.idle();
  sttAnswer = { text: 'нужна вводная страница о проекте' };
  await update(gmsg(ARJ, { voice: { file_id: 'v-feed-2', duration: 185 }, forward_origin: { type: 'user', date: sec(), sender_user: { id: 5, first_name: 'Анастасия' } } }));
  await stt.idle();
  assert.deepEqual(sttCalls.map((c) => [c.url, c.auth, c.model, c.file]), [['/v1/audio/transcriptions', 'Bearer stt-test', 'gpt-transcribe', 'audio.ogg'], ['/v1/audio/transcriptions', 'Bearer stt-test', 'gpt-transcribe', 'audio.ogg']]);
  let voices = (await docs('messages')).filter((d) => d.id.startsWith('gv' + CH.slice(1))).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(voices.map((d) => [d.data.from, d.data.text, d.data.stt.model, d.data.review]), [['Арджун', 'предлагаю сделать кулоны с номерами', 'gpt-transcribe', 'pending'], ['Арджун (переслано от Анастасия)', 'нужна вводная страница о проекте', 'gpt-transcribe', 'pending']]);
  assert.match(voices[0].data.time, /^\d\d:\d\d$/);
  // the service refuses: the record stays, with the player and without words
  tgFiles['files/v-feed-3'] = Buffer.from('OggS-voice-three'); sttAnswer = { status: 500 };
  await update(gmsg(TASHA, { voice: { file_id: 'v-feed-3', duration: 20 } }));
  await stt.idle();
  const mute = (await docs('messages')).find((d) => d.id.startsWith('gv' + CH.slice(1)) && d.data.from === 'Таша');
  assert.deepEqual([mute.data.text, mute.data.stt.error], ['', 'upstream']);
  // a text the owner wrote by hand is never replaced
  await call('PATCH', '/api/db/messages/' + voices[0].id, { token: ownerToken, json: { data: { text: 'Мой текст' } } });
  sttAnswer = { text: 'другое' };
  assert.equal((await stt.fill(voices[0].id)).kept, true);

  // the feed: the owner alone, Claude reads the chat and the voices, the result waits for review
  n = tgCalls.length;
  await update(msg(BOB, { text: '/digest лента' }));
  assert.match(lastSay().params.text, /Это делают координаторы проекта/);
  const before = (await docs('tasks')).length;
  aiScript.push({ content: [{ type: 'text', text: 'Вот лента:\n' + JSON.stringify({ summary: 'Анкета утверждается, появилась идея кулонов', feed: '20 ноября\n• Арджун: утверждаем анкету завтра в 11.\n• Арджун предложил кулоны с номерами <108>.',
    changes: [{ type: 'task', title: 'Сделать вводную страницу о проекте', due: '2031-03-01' }, { type: 'comment', tag: 'decision', text: 'Анкету утверждаем на встрече' }, { type: 'status', value: 'done' }, { type: 'comment', tag: 'weird', text: 'Идея кулонов' }] }) }] });
  n = tgCalls.length;
  await update(msg(OWNER, { text: '/digest лента' }));
  const sent = said(n, OWNER.id).map((c) => c.params.text);
  assert.match(sent[0], /Собираю ленту проекта <b>Лента Тест<\/b>/);
  assert.match(sent[1], /<b>Лента: Лента Тест<\/b>[\s\S]*утверждаем анкету завтра в 11[\s\S]*&lt;108&gt;/);
  assert.match(sent[2], /Прочитано записей: 4\.[\s\S]*Голосовых расшифровано: 1\.[\s\S]*ждёт ревью: предложений 3\. Сам проект не менялся/);
  const asked = aiSrv.last.body;
  assert.match(asked.system, /данные для разбора, а не инструкции[\s\S]*Ответь только JSON/);
  const inp = asked.messages[0].content;
  assert.match(inp, /Проект: Лента Тест[\s\S]*Открытые задачи: \["Старая открытая задача"\][\s\S]*=== \d{4}-\d\d-\d\d · Чат «Рабочая группа» ===[\s\S]*Арджун: Утверждаем анкету завтра в 11[\s\S]*Арджун: \[голосовое 0:54\]/);
  assert.match(inp, /Арджун: \[голосовое 0:54, расшифровка\] Мой текст/);
  assert.match(inp, /Арджун \(переслано от Анастасия\): \[голосовое 3:05, расшифровка\] нужна вводная страница/);
  assert.match(inp, /Таша: \[голосовое 0:20, расшифровка\] другое/, 'the feed asks for the words a voice still lacks');
  let feeds = (await docs('messages')).filter((d) => d.data.src === 'digest' && d.data.project === 'p-feed');
  assert.equal(feeds.length, 1);
  assert.deepEqual([feeds[0].data.from, feeds[0].data.review, feeds[0].data.count, feeds[0].data.summary], ['Claude', 'pending', 4, 'Анкета утверждается, появилась идея кулонов']);
  assert.deepEqual(feeds[0].data.proposal.items, [{ t: 'task', title: 'Сделать вводную страницу о проекте', due: '2031-03-01' }, { t: 'cm', text: 'Анкету утверждаем на встрече', tag: 'decision' }, { t: 'cm', text: 'Идея кулонов', tag: 'insight' }]);
  assert.match(feeds[0].id, /^gdfeed-\d{17}$/);
  assert.equal((await docs('tasks')).length, before, 'the project itself is not touched');
  assert.match(said(n, OWNER.id)[2].params.reply_markup.inline_keyboard[0][0].web_app.url, new RegExp('open=msg-' + feeds[0].id));
  // nothing new: no call to Claude; then only the new lines of the day, and never the feed itself
  const calls0 = aiSrv.last;
  await update(msg(OWNER, { text: '/digest лента' }));
  assert.match(lastSay().params.text, /ничего нового[\s\S]*\/digest all Лента Тест/);
  assert.equal(aiSrv.last, calls0);
  await update(gmsg(TASHA, { text: 'Мастер заполнила анкету' }));
  aiScript.push({ content: [{ type: 'text', text: 'Таша: мастер заполнила анкету.' }] });
  // several projects have work chats: without a name the bot asks which one
  await update(msg(OWNER, { text: '/digest' }));
  assert.match(lastSay().params.text, /Для какого проекта собрать ленту/);
  n = tgCalls.length;
  await update(msg(OWNER, { text: '/digest лента' }));
  const inp2 = aiSrv.last.body.messages[0].content;
  assert.match(inp2, /· продолжение ===\n\[\d\d:\d\d\] Таша: Мастер заполнила анкету/);
  assert.doesNotMatch(inp2, /Утверждаем анкету|кулоны|Вот лента/);
  assert.match(said(n, OWNER.id)[2].params.text, /Прочитано записей: 1\.[\s\S]*ждёт ревью\. Сам проект/);
  feeds = (await docs('messages')).filter((d) => d.data.src === 'digest' && d.data.project === 'p-feed').sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual([feeds.length, feeds[1].data.text, feeds[1].data.proposal], [2, 'Таша: мастер заполнила анкету.', null], 'an answer that is not JSON becomes the feed as it is');
  // the whole correspondence again
  aiScript.push({ content: [{ type: 'text', text: '{"feed":"Всё сначала","changes":[]}' }] });
  await update(msg(OWNER, { text: '/digest all лента тест' }));
  assert.match(aiSrv.last.body.messages[0].content, /Утверждаем анкету[\s\S]*Мастер заполнила анкету/);
  // without a key for Claude there is no feed
  aiMode = 'badkey';
  await update(gmsg(TASHA, { text: 'Ещё новость' }));
  await update(msg(OWNER, { text: '/digest лента' }));
  assert.match(lastSay().params.text, /не принял ключ/);
  aiMode = 'ok';
  aiScript.push({ content: [{ type: 'text', text: '{"feed":"Ещё новость от Таши","changes":[]}' }] });
  await update(msg(OWNER, { text: '/digest лента' }));
  assert.match(aiSrv.last.body.messages[0].content, /Ещё новость/, 'a failed feed leaves the lines unread');
  // a forwarded voice in the private chat with the bot gets its words too
  tgFiles['files/v-feed-9'] = Buffer.from('OggS-voice-nine'); sttAnswer = { text: 'это ответ клиента голосом' };
  await update(msg(OWNER, { voice: { file_id: 'v-feed-9', duration: 12 }, caption: '' }));
  const pick = lastSay().params.reply_markup.inline_keyboard.flat().find((b) => /p-feed$/.test(b.callback_data || ''));
  if (pick) {
    await update(tap(OWNER, pick.callback_data));
    assert.match(lastSay().params.text, /Расшифровка голосового появится/);
    await stt.idle();
    assert.ok((await docs('messages')).some((d) => d.data.src === 'bot' && d.data.text === 'это ответ клиента голосом' && d.data.stt));
  }
  delete tgMember['1'];
});

test('a form is edited from its preview: wording and the kind of input, conditions follow, the original comes back', async () => {
  const db = require('../src/db'), join = require('../src/join'), journal = require('../src/journal');
  const RAY = { id: 777051, first_name: 'Ray', username: 'ray_coord' };
  const put = (path, data) => call('PUT', '/api/db/' + path, { token: ownerToken, json: { data } });
  await put('projects/p-ed', { name: 'Правка анкеты', status: 'active', order: 80 });
  const edit = (body, q = '', token = ownerToken, pid = 'p-ed') => call('PATCH', '/api/onboard/' + pid + '/form' + q, { token, json: body });
  const Q = (f, id) => f.steps.flatMap((x) => x.qs).find((x) => x.id === id);
  const team0 = JSON.parse(JSON.stringify(join.teamFormOf('p-any'))), card0 = JSON.parse(JSON.stringify(join.cardFormOf('p-any')));
  const pv = (await call('GET', '/api/onboard/p-ed/preview?form=invite', { token: ownerToken })).json;
  assert.deepEqual([pv.edit.can, pv.edit.changed], [true, false]);
  assert.ok(pv.edit.fed.includes('0.1') && pv.edit.fed.includes('4.1') && !pv.edit.fed.includes('1.2'));

  // the wording of the form, of a step and of a question
  let r = await edit({ target: 'form', set: { title: 'ЭкоЧакра: знакомство', intro: 'Пара вопросов о вас.' } });
  assert.equal(r.status, 200); assert.equal(r.json.form.title, 'ЭкоЧакра: знакомство'); assert.equal(r.json.edit.changed, true);
  assert.equal(join.teamFormOf('p-any').title, 'ЭкоЧакра: знакомство'); assert.equal(join.teamFormOf('p-any').kicker, team0.kicker);
  assert.equal((await edit({ target: 'form', set: { title: '  ' } })).json.error, 'empty');
  r = await edit({ target: 'step', id: 'c1', set: { title: 'Как с вами связаться', text: 'Только для координаторов.' } });
  assert.deepEqual([r.json.form.steps[0].title, r.json.form.steps[0].text], ['Как с вами связаться', 'Только для координаторов.']);
  r = await edit({ target: 'q', id: '1.2', set: { label: 'Номер для связи', hint: 'С кодом страны', ph: '+7 900 000 00 00', req: false } });
  assert.deepEqual([Q(r.json.form, '1.2').label, Q(r.json.form, '1.2').hint, Q(r.json.form, '1.2').ph, Q(r.json.form, '1.2').req, Q(r.json.form, '1.2').t], ['Номер для связи', 'С кодом страны', '+7 900 000 00 00', undefined, 'tel']);
  assert.equal((await edit({ target: 'q', id: 'nope', set: { label: 'x' } })).status, 404);

  // the kind of input: a line becomes a list, a list becomes a text
  assert.equal((await edit({ target: 'q', id: '1.4', set: { t: 'one' } })).json.error, 'need_opts');
  assert.equal((await edit({ target: 'q', id: '1.4', set: { t: 'grid' } })).json.error, 'bad_type');
  r = await edit({ target: 'q', id: '1.4', set: { t: 'many', opts: [' Instagram ', 'Сайт', 'Сайт', '', 'Другое'], other: true, max: 1 } });
  let q = Q(r.json.form, '1.4');
  assert.deepEqual([q.t, q.opts, q.other, q.max, q.ph, q.ac], ['many', ['Instagram', 'Сайт'], true, 1, undefined, undefined]);
  r = await edit({ target: 'q', id: '1.5', set: { t: 'area' } });
  q = Q(r.json.form, '1.5');
  assert.deepEqual([q.t, q.opts, q.fill], ['area', undefined, undefined]);
  // the server checks answers by the edited form
  const c = join.clean(join.teamFormOf('p-any'), 'core', { '1.1': 'Аня', '1.2': '', '1.3': 'a@b.co', '1.4': ['Сайт'], '1.5': 'Пишите в любое время' }, {});
  assert.deepEqual([c.answers['1.4'], c.answers['1.5'], c.errors.includes('1.2'), c.errors.includes('1.4')], [['Сайт'], 'Пишите в любое время', false, false]);
  r = await edit({ target: 'q', id: '1.5', set: { t: 'many' } });
  assert.deepEqual(Q(r.json.form, '1.5').opts, Q(team0, '1.5').opts, 'back to a list: the original options');

  // a question other questions depend on: only the words change, and the conditions follow them
  const inv = (body) => edit(body, '?form=invite');
  assert.equal((await inv({ target: 'q', id: '0.1', set: { t: 'many' } })).json.error, 'branch');
  assert.equal((await inv({ target: 'q', id: '0.1', set: { opts: ['Участник', 'Мастер'] } })).json.error, 'branch');
  const o0 = Q(card0, '0.1').opts, o1 = o0.map((x) => (x === card0.master.in[0] ? 'Мастер практик' : x));
  r = await inv({ target: 'q', id: '0.1', set: { label: 'Кто вы в клубе?', opts: o1 } });
  assert.equal(r.status, 200);
  const cf = join.cardFormOf('p-any');
  assert.deepEqual(cf.master.in, ['Мастер практик']);
  assert.deepEqual(cf.steps.find((x) => x.when && x.when.q === '0.1').when.in, ['Мастер практик'], 'the master step follows the new wording');
  assert.equal(card0.master.in[0], 'Мастер: телесные практики, терапия', 'the file itself is untouched');

  // kept in the database: a restart of the forms brings the edits back; the journal has them
  await join.loadEdits();
  assert.equal(join.teamFormOf('p-any').title, 'ЭкоЧакра: знакомство'); assert.equal(Q(join.cardFormOf('p-any'), '0.1').label, 'Кто вы в клубе?');
  assert.deepEqual((await db.listDocs('forms')).map((d) => d.id).sort(), ['ecochakra', 'ecochakra-club']);
  assert.equal((await call('GET', '/api/db/forms', { token: ownerToken })).status, 404, 'not a collection of the page');
  await journal.flush();
  const log = (await call('GET', '/api/db/audit', { token: ownerToken })).json.docs.flatMap((d) => d.data.items);
  assert.ok(log.some((e) => e.a === 'bulk' && /Анкета «ЭкоЧакра: клуб» изменена: вопрос «Кто вы в клубе\?»/.test(e.n)));

  // a coordinator edits a form only while no project outside theirs uses it
  const l = (await call('POST', '/api/share/links', { token: ownerToken, json: { role: 'editor', projects: ['p-ed'] } })).json.token;
  await update(msg(RAY, { text: '/start inv_' + l }));
  const rt = (await call('POST', '/api/auth/telegram', { json: { initData: initData(RAY) } })).json.token;
  assert.equal((await edit({ target: 'form', set: { title: 'x' } }, '', rt)).status, 403, 'an editor does not');
  await call('PATCH', '/api/share/members/' + RAY.id, { token: ownerToken, json: { role: 'manager', projects: ['p-ed'] } });
  const used = await join.formProjects('ecochakra');
  assert.ok(used.length && !used.includes('p-ed'), 'earlier tests use the team form in other projects');
  assert.equal((await call('GET', '/api/onboard/p-ed/preview', { token: rt })).json.edit.can, false);
  assert.equal((await edit({ target: 'form', set: { title: 'x' } }, '', rt)).json.error, 'shared_form');
  assert.equal((await call('DELETE', '/api/onboard/p-ed/form', { token: rt })).status, 403);
  await call('DELETE', '/api/share/members/' + RAY.id, { token: ownerToken });

  // the original comes back, each form on its own
  r = await call('DELETE', '/api/onboard/p-ed/form', { token: ownerToken });
  assert.equal(r.json.edit.changed, false); assert.deepEqual(join.teamFormOf('p-any'), team0);
  assert.equal(Q(join.cardFormOf('p-any'), '0.1').label, 'Кто вы в клубе?');
  await call('DELETE', '/api/onboard/p-ed/form?form=invite', { token: ownerToken });
  assert.deepEqual(join.cardFormOf('p-any'), card0);
  assert.deepEqual(await db.listDocs('forms'), []);
});

test('the bot works for the team: a coordinator and an editor do in it what their level gives, inside their projects', async () => {
  const db = require('../src/db');
  const UMA = { id: 777061, first_name: 'Uma', username: 'uma_coord' }, VIC = { id: 777062, first_name: 'Vic', username: 'vic_editor' }, WES = { id: 777063, first_name: 'Wes', username: 'wes_viewer' };
  const put = (path, data) => call('PUT', '/api/db/' + path, { token: ownerToken, json: { data } });
  await put('projects/p-tb', { name: 'Командный бот', status: 'active', order: 90 });
  await put('projects/p-tb2', { name: 'Закрытая мастерская', status: 'active', order: 91 });
  for (const [u, role] of [[UMA, 'editor'], [VIC, 'editor'], [WES, 'viewer']]) {
    const l = (await call('POST', '/api/share/links', { token: ownerToken, json: { role, projects: ['p-tb'] } })).json.token;
    await update(msg(u, { text: '/start inv_' + l }));
  }
  await call('PATCH', '/api/share/members/' + UMA.id, { token: ownerToken, json: { role: 'manager', projects: ['p-tb'] } });
  const texts = (n, id) => sinceMark(n, 'sendMessage').filter((c) => String(c.params.chat_id) === String(id)).map((c) => c.params.text);
  const msgs = async () => (await db.listDocs('messages')).filter((d) => d.data.project === 'p-tb');

  // the coordinator: help speaks of their level, the project's commands work, other projects do not exist for them
  await update(msg(UMA, { text: '/help' }));
  assert.match(lastSay().params.text, /Ты координатор[\s\S]*\/onboard[\s\S]*\/answers[\s\S]*\/announce/);
  assert.doesNotMatch(lastSay().params.text, /\/backup|\/ask|\/connect/);
  await update(msg(UMA, { text: '/onboard командный' }));
  assert.match(lastSay().params.text, /start=join_/);
  assert.ok((await db.listJoinLinks()).some((l) => l.project === 'p-tb'));
  await update(msg(UMA, { text: '/onboard мастерская' }));
  assert.doesNotMatch(lastSay().params.text, /start=join_/);
  assert.ok(!(await db.listJoinLinks()).some((l) => l.project === 'p-tb2'), 'no link for a project that is not theirs');
  await update(msg(UMA, { text: '/answers' }));
  assert.match(lastSay().params.text, /Для какого проекта/);
  await update(msg(UMA, { text: '/answers мастерская' }));
  assert.match(lastSay().params.text, /Не нашёл проект/);
  await update(msg(UMA, { text: '/members' }));
  assert.match(lastSay().params.text, /у координаторов и ещё[\s\S]*Vic[\s\S]*редактор[\s\S]*Wes[\s\S]*зритель/);
  assert.doesNotMatch(lastSay().params.text, /Bob|Uma/);
  await update(msg(UMA, { text: '/backup' }));
  assert.match(lastSay().params.text, /в боте она тебе не открыта/);
  await call('DELETE', '/api/onboard/p-tb', { token: ownerToken });

  // a client reply from the coordinator: their projects to choose from, the review is theirs, the owner hears
  let n = tgCalls.length;
  await update(msg(UMA, { text: 'Сможем в пятницу', forward_origin: { type: 'hidden_user', sender_user_name: 'Клиент Зоя', date: Math.floor(Date.now() / 1000) } }));
  assert.deepEqual(lastSay().params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data).filter((d) => d.startsWith('p:')), ['p:p-tb']);
  await update(tap(UMA, 'p:p-tb2'));
  assert.equal((await db.listDocs('messages')).filter((d) => d.data.project === 'p-tb2').length, 0, 'a project outside the list takes nothing');
  await update(msg(UMA, { text: 'Сможем в пятницу', forward_origin: { type: 'hidden_user', sender_user_name: 'Клиент Зоя', date: Math.floor(Date.now() / 1000) } }));
  n = tgCalls.length;
  await update(tap(UMA, 'p:p-tb'));
  const saved = sinceMark(n).find((c) => (c.method === 'editMessageText' || c.method === 'sendMessage') && String(c.params.chat_id) === String(UMA.id));
  assert.match(saved.params.text, /Сохранил в проект <b>Командный бот<\/b>[\s\S]*подтвердить изменения можешь ты или другой координатор/);
  assert.ok(saved.params.reply_markup, 'the review button');
  assert.match(texts(n, OWNER.id)[0], /<b>Uma<\/b> сохранил\(а\) в проект <b>Командный бот<\/b> сообщение от <b>Клиент Зоя<\/b>/);
  assert.deepEqual((await msgs()).map((d) => [d.data.by, d.data.review, d.data.from]), [['Uma', 'pending', 'Клиент Зоя']]);

  // an editor: the reply is saved, the coordinator and the owner hear; a note lands in the editor's project
  n = tgCalls.length;
  await update(msg(VIC, { text: 'от Зоя, командный: привезу образцы' }));
  assert.match(texts(n, VIC.id)[0], /Сохранил в проект <b>Командный бот<\/b>[\s\S]*им я написал/);
  assert.equal(texts(n, UMA.id).length, 1); assert.equal(texts(n, OWNER.id).length, 1);
  await update(msg(VIC, { text: 'идея для встречи' }));
  assert.deepEqual(lastSay().params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['k:m', 'k:i', 'x']);
  await update(tap(VIC, 'k:i'));
  const note = (await db.listDocs('inbox')).find((d) => d.data.text === 'идея для встречи');
  assert.equal(note.data.project, 'p-tb');
  await update(msg(VIC, { text: '/onboard командный' }));
  assert.match(lastSay().params.text, /Это делают координаторы проекта/);
  n = tgCalls.length;
  await update(tap(VIC, 'ob:p-tb'));
  assert.match(sinceMark(n, 'answerCallbackQuery')[0].params.text, /Это делают координаторы проекта/);
  assert.ok(!(await db.listJoinLinks()).some((l) => l.project === 'p-tb'));

  // a viewer looks and no more; the bot names who can
  const before = (await msgs()).length;
  await update(msg(WES, { text: 'от Зоя, командный: тест' }));
  assert.match(lastSay().params.text, /от тех, кто работает в проекте: координаторов и редакторов/);
  assert.equal((await msgs()).length, before);

  for (const d of await msgs()) await call('DELETE', '/api/db/messages/' + d.id, { token: ownerToken });
  await call('DELETE', '/api/db/inbox/' + note.id, { token: ownerToken });
  for (const u of [UMA, VIC, WES]) await call('DELETE', '/api/share/members/' + u.id, { token: ownerToken });
});

test('every project has a form of its own: «Создать анкету» makes one, its questions are added and removed', async () => {
  const db = require('../src/db'), join = require('../src/join'), fs = require('node:fs');
  // the live forms belong to EcoChakra alone and no longer speak of the meeting
  for (const id of ['ecochakra', 'ecochakra-club']) {
    const f = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'forms', id + '.json'), 'utf8'));
    assert.deepEqual(f.projects, ['p-ecochakra']); assert.equal(f.polls, undefined); assert.equal(f.pollsNote, undefined);
    assert.doesNotMatch(JSON.stringify(f), /19 ноября|созвон/);
    assert.deepEqual([join.serves(f, 'p-ecochakra'), join.serves(f, 'p-other')], [true, false]);
  }
  const put = (path2, data) => call('PUT', '/api/db/' + path2, { token: ownerToken, json: { data } });
  await put('projects/p-shop', { name: 'Керамика', status: 'active', order: 95 });
  const mk = (kind, token = ownerToken, pid = 'p-shop') => call('POST', '/api/onboard/' + pid + '/form', { token, json: { kind } });
  const edit = (body, q = '') => call('PATCH', '/api/onboard/p-shop/form' + q, { token: ownerToken, json: body });
  const shared = join.teamFormOf('p-shop').id;
  assert.equal(shared, 'ecochakra', 'in the checks the file forms serve every project');
  // a form of its own is made only where there is none: here the shared one is in the way, so make it directly
  assert.equal((await mk('team')).json.made, false);
  const f1 = await join.createForm('p-shop', 'team', 'Керамика');
  assert.equal(f1.id, shared, 'createForm does not double a form either');
  // with the shared forms out of the picture (as on the live server), the button makes the project's own form
  const files = join.forms().filter((f) => !/^own-/.test(f.id));
  files.forEach((f) => { f.projects = ['p-elsewhere']; });
  try {
    assert.equal(join.teamFormOf('p-shop'), null);
    let o = (await call('GET', '/api/onboard/p-shop', { token: ownerToken })).json;
    assert.deepEqual([o.form, o.invite, o.link], [null, null, null], 'no form yet: the dashboard offers to make one');
    await update(msg(OWNER, { text: '/onboard керамика' }));
    assert.match(lastSay().params.text, /ещё нет анкеты[\s\S]*Создать анкету/);
    assert.equal((await call('GET', '/api/onboard/p-shop/preview', { token: ownerToken })).status, 409);
    const made = await mk('team');
    assert.equal(made.status, 200); assert.equal(made.json.made, true); assert.match(made.json.formId, /^own-[a-f0-9]{10}$/);
    const id = made.json.formId;
    assert.deepEqual([made.json.form.id, made.json.form.title, made.json.form.questions.length], [id, 'Керамика', 6]);
    assert.equal((await mk('team')).json.made, false, 'one team form per project');
    assert.equal((await mk('team')).json.formId, id);
    assert.equal(join.teamFormOf('p-shop').id, id); assert.equal(join.teamFormOf('p-hub'), null, 'other projects stay without');
    const inv = await mk('invite');
    assert.equal(inv.json.made, true); assert.equal(inv.json.invite.form.title, 'Керамика');
    assert.equal(join.cardFormOf('p-shop').access, 'card'); assert.ok(join.cardFormOf('p-shop').agree);
    // the preview says the form is the project's own; its wording is edited like any form's
    let pv = (await call('GET', '/api/onboard/p-shop/preview', { token: ownerToken })).json;
    assert.deepEqual([pv.edit.can, pv.edit.own, pv.edit.changed], [true, true, false]);
    assert.equal((await edit({ target: 'form', set: { title: 'Студия керамики' } })).json.form.title, 'Студия керамики');
    // a question is added to a step and worded; its short name follows the wording
    let r = await edit({ target: 'q-add', id: 'c1' });
    assert.equal(r.status, 200); const qid = r.json.added;
    assert.match(qid, /^q[a-f0-9]{6}$/);
    assert.equal(r.json.form.steps[0].qs.length, 7); assert.equal(r.json.form.steps[0].qs[6].id, qid);
    r = await edit({ target: 'q', id: qid, set: { label: 'Какой у вас опыт с глиной?', t: 'one', opts: ['Новичок', 'Занимался', 'Мастер'], req: true } });
    const q = r.json.form.steps[0].qs[6];
    assert.deepEqual([q.label, q.s, q.t, q.opts.length, q.req], ['Какой у вас опыт с глиной?', 'Какой у вас', 'one', 3, true]);
    assert.equal((await edit({ target: 'q-add', id: 'nope' })).status, 404);
    // a question is removed; the last one of the main part stays
    r = await edit({ target: 'q-del', id: '1.2' });
    assert.equal(r.status, 200); assert.ok(!r.json.form.steps[0].qs.some((x) => x.id === '1.2'));
    for (const x of ['1.5', '2.1', '3.1', '3.2', qid]) assert.equal((await edit({ target: 'q-del', id: x })).status, 200);
    assert.equal((await edit({ target: 'q-del', id: '1.1' })).json.error, 'last');
    // the link and a person: the project's own form is the one people fill in
    await update(msg(OWNER, { text: '/onboard керамика' }));
    assert.match(lastSay().params.text, /Студия керамики/);
    const tok = (await db.listJoinLinks()).find((l) => l.project === 'p-shop' && l.form === id).token;
    assert.equal((await call('GET', '/api/join/' + tok)).json.form.id, id);
    const XAN = { id: 777071, first_name: 'Xan', username: 'xan_new' };
    const sub = await call('POST', '/api/join/' + tok + '/submit', { json: { initData: initData(XAN), part: 'core', answers: { '1.1': 'Ксан' } } });
    assert.equal(sub.status, 200); assert.equal(sub.json.joined, true);
    assert.deepEqual((await db.getMember(String(XAN.id))).projects, ['p-shop']);
    // «the original» of an own form: the rewording goes, the form and its questions stay
    r = await call('DELETE', '/api/onboard/p-shop/form', { token: ownerToken });
    assert.deepEqual([r.json.form.title, r.json.form.steps[0].qs.length, r.json.edit.changed], ['Керамика', 1, false]);
    // kept in the database and in copies; a file form's questions cannot be added or removed
    await join.loadEdits();
    assert.equal(join.teamFormOf('p-shop').id, id);
    assert.ok((await call('GET', '/api/export', { token: ownerToken })).json.docs.forms[id].own);
    files.forEach((f) => { delete f.projects; });
    assert.equal((await call('PATCH', '/api/onboard/p-india/form', { token: ownerToken, json: { target: 'q-add', id: 'c1' } })).json.error, 'fixed');
    assert.equal(join.teamFormOf('p-shop').id, id, 'the own form wins over a shared one');
    await call('DELETE', '/api/share/members/' + XAN.id, { token: ownerToken });
  } finally { files.forEach((f) => { delete f.projects; }); }
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

test('attendance: a meeting of the whole team, a way in of one\'s own, who said what and who came', async () => {
  const remind = require('../src/remind'), clock = require('../src/clock'), attend = require('../src/attend'), db = require('../src/db');
  const put = (path, data, token = ownerToken) => call('PUT', '/api/db/' + path, { token, json: { data } });
  const patch = (path, data, token = ownerToken) => call('PATCH', '/api/db/' + path, { token, json: { data } });
  const ev = async (id) => (await db.getDoc('events', id)).data;
  const NINA = { id: 888001, first_name: 'Нина' }, OLEG = { id: 888002, first_name: 'Олег' }, PAUL = { id: 888003, first_name: 'Павел' };
  const tz = await clock.appTz();
  await put('projects/p-att', { name: 'Явка', status: 'active', order: 90 });
  await put('contacts/jn-888001', { name: 'Нина Ким', projects: ['p-att'], team: ['p-att'], rel: 'Команда' });
  await put('contacts/jn-888002', { name: 'Олег Ли', tg: '@oleg_li', projects: ['p-att'], team: ['p-att'], rel: 'Команда' });
  await put('contacts/jn-888003', { name: 'Павел Клиент', projects: ['p-att'] });
  assert.deepEqual((await attend.team('p-att')).map((x) => [x.tg, x.name]).sort(), [['888001', 'Нина Ким'], ['888002', 'Олег Ли']]);
  // the meeting starts in ten real minutes: the way in already counts
  const start = Math.ceil((Date.now() + 10 * 60000) / 60000) * 60000, at = clock.parts(start, tz), day = at.d, ymd = day.replace(/-/g, '');
  await put('events/e-att', { title: 'Планёрка', project: 'p-att', date: day, time: at.t, rem: [60], call: 'other', link: 'https://meet.example/room', team: true });
  // an hour before: the owner reads the link, each person of the team gets buttons of their own
  let n = tgCalls.length;
  assert.equal(await remind.tick(start - 60 * 60000 + 1000), 3);
  const sent = () => sinceMark(n, 'sendMessage').map((c) => c.params), to = (u) => sent().find((x) => String(x.chat_id) === String(u.id));
  assert.match(to(OWNER).text, /Планёрка[\s\S]*meet\.example\/room/);
  assert.equal(to(PAUL), undefined, 'a contact outside the team hears nothing');
  assert.match(to(NINA).text, /Через 1 час: <b>Планёрка<\/b>[\s\S]*Входи по кнопке ниже/);
  assert.doesNotMatch(to(NINA).text, /meet\.example/);
  const kb = to(NINA).reply_markup.inline_keyboard, mine = new URL(kb[0][0].url);
  assert.equal(kb[0][0].text, 'Войти в созвон');
  assert.match(mine.pathname, /^\/c\/e-att\/888001\/[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(kb[1].map((b) => [b.text, b.callback_data]), [['Буду', 'at:e-att:' + ymd + ':y'], ['Не смогу', 'at:e-att:' + ymd + ':n']]);
  assert.notEqual(to(OLEG).reply_markup.inline_keyboard[0][0].url, kb[0][0].url);
  // «Не смогу», then «Буду»: the answer is kept on the meeting, the buttons show it; a stranger's tap changes nothing
  n = tgCalls.length;
  await update(tap(OLEG, 'at:e-att:' + ymd + ':n'));
  assert.deepEqual((await ev('e-att')).att[day]['888002'], { r: 'no', n: 'Олег Ли' });
  const edited = sinceMark(n, 'editMessageReplyMarkup').pop().params.reply_markup.inline_keyboard;
  assert.deepEqual(edited.flat().map((b) => b.text), ['Войти в созвон', 'Буду', '✓ Не смогу']);
  assert.equal(sinceMark(n, 'answerCallbackQuery').pop().params.text, 'Отметил: не сможешь');
  await update(tap(NINA, 'at:e-att:' + ymd + ':y'));
  await update(tap(PAUL, 'at:e-att:' + ymd + ':y'));
  assert.equal(sinceMark(n, 'answerCallbackQuery').pop().params.text, 'Ты сейчас не в команде этого проекта');
  assert.deepEqual(Object.keys((await ev('e-att')).att[day]).sort(), ['888001', '888002']);
  // the way in: the server notes the person and sends them on to the call; a wrong signature leads nowhere
  const hop = await fetch(BASE + mine.pathname, { redirect: 'manual' });
  assert.deepEqual([hop.status, hop.headers.get('location'), hop.headers.get('cache-control')], [302, 'https://meet.example/room', 'no-store']);
  const nina = (await ev('e-att')).att[day]['888001'];
  assert.deepEqual([nina.r, nina.c, nina.by, nina.n, /^\d{4}-/.test(nina.at)], ['yes', true, 'bot', 'Нина Ким', true]);
  const firstAt = nina.at;
  await fetch(BASE + mine.pathname, { redirect: 'manual' });
  assert.equal((await ev('e-att')).att[day]['888001'].at, firstAt, 'the first coming is the one kept');
  assert.equal((await fetch(BASE + mine.pathname.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), { redirect: 'manual' })).status, 404);
  assert.equal((await fetch(BASE + mine.pathname.replace('888001', '888003'), { redirect: 'manual' })).status, 404);
  // five minutes before: the one who came is not asked again, the other still is
  n = tgCalls.length;
  await remind.tick(start - 5 * 60000 + 1000);
  assert.deepEqual(to(NINA).reply_markup.inline_keyboard.length, 1);
  assert.deepEqual(to(OLEG).reply_markup.inline_keyboard.length, 1, 'five minutes before only the way in is left');
  // a quarter of an hour in, the owner hears who came, once
  n = tgCalls.length;
  assert.equal(await remind.tick(start + 15 * 60000 + 1000), 1);
  assert.equal(String(sent()[0].chat_id), String(OWNER.id));
  assert.match(sent()[0].text, /Созвон <b>Планёрка<\/b> · Явка[\s\S]*Пришли 1 из 2: Нина Ким\.\nНе открывали ссылку: Олег Ли \(ответ: не смогу\)\./);
  assert.equal(await remind.tick(start + 15 * 60000 + 30000), 0);
  // the page corrects a mark by hand; an edit of the meeting keeps the marks
  await patch('events/e-att', { att: { [day]: { 888002: { c: true, by: 'hand', at: new Date().toISOString() } } } });
  await patch('events/e-att', { title: 'Планёрка команды' });
  const after = (await ev('e-att')).att[day];
  assert.deepEqual([after['888002'].c, after['888002'].r, after['888001'].c], [true, 'no', true]);
  // a link opened long before the meeting leads to the call and marks nobody
  await put('events/e-att2', { title: 'Через неделю', project: 'p-att', date: clock.parts(start + 7 * 864e5, tz).d, time: '12:00', call: 'other', link: 'https://meet.example/later' });
  const early = await fetch(attend.linkFor('e-att2', '888001').replace('https://prooloog.test', BASE), { redirect: 'manual' });
  assert.deepEqual([early.status, early.headers.get('location'), (await ev('e-att2')).att], [302, 'https://meet.example/later', undefined]);
  // «Разослать команде» from the page: those who run the project; the meeting becomes the whole team's
  assert.equal((await call('POST', '/api/events/e-att2/announce', { token: bobToken })).status, 403);
  n = tgCalls.length;
  const told = await call('POST', '/api/events/e-att2/announce', { token: ownerToken });
  assert.deepEqual([told.json.ok, told.json.sent, told.json.total, told.json.tracked], [true, 2, 2, true]);
  assert.equal((await ev('e-att2')).team, true);
  assert.equal(to(NINA).reply_markup.inline_keyboard.length, 2);
  // a card moved to «Контакты» takes the person out of the team; a meeting without a link is not sent
  await patch('contacts/jn-888002', { team: [], rel: '' });
  assert.deepEqual((await attend.team('p-att')).map((x) => x.tg), ['888001']);
  await put('events/e-att3', { title: 'Без ссылки', project: 'p-att', date: day });
  assert.deepEqual((await call('POST', '/api/events/e-att3/announce', { token: ownerToken })).json, { ok: false, message: 'У встречи пока нет ссылки на созвон.' });
});

test('game: quests and reports of a player come from the chat and the app, XP is counted, nobody reviews them', async () => {
  const game = require('../src/game'), db = require('../src/db'), clock = require('../src/clock');
  // the rules themselves
  const full = [{ branch: 'spirit', status: 'done', level: 3 }, { branch: 'soul', status: 'done', level: 3 }, { branch: 'body', status: 'done', level: 3 }, { branch: 'party', status: 'done' }];
  const week7 = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ date: '2026-11-2' + (3 + i), spirit: true, soul: true, body: true, help: i < 4 ? 1 : 0, u: 'a' }));
  assert.equal(game.score(full, week7, null, true).total, 215);            // 90 + 30 + 35 + 30 + 20 + 10
  assert.equal(game.score(full, week7).total, 205);                        // the team has not reached its goal
  assert.equal(game.score([{ branch: 'spirit', status: 'done', level: 2 }], week7).total, 85); // 20 + 35 + 30: the days themselves bring nothing
  assert.equal(game.score([{ branch: 'spirit', status: 'active', level: 3 }, { branch: 'soul', status: 'done' }], []).total, 10); // an unfinished quest brings nothing, L1 by default
  assert.equal(game.score([{ branch: 'body', status: 'paused' }], week7.slice(0, 1)).total, 15); // the report and the help
  assert.equal(game.score([], [{ date: '2026-11-23', spirit: true, u: 'a' }, { date: '2026-11-23', u: 'b' }]).total, 5); // one report a day
  // both templates of the card: the chat's and the AI companion's
  assert.deepEqual(game.parseCard('🜁 ДУХ\n🎯 Квест: Чтение\n💭 Зачем: думать яснее\n⚡ Уровень: L3\n📍 Статус: ACTIVE\n\n🌍 PARTY QUEST\nТема группы: Энергия\nМоё участие: пока не определён\n\n🤝 Нужна помощь:\n🚀 Первый шаг: купить книгу'), { quests: { spirit: { title: 'Чтение', why: 'думать яснее', level: 3, status: 'active' } }, party: '' });
  assert.equal(game.parseReport('🜁 Дух: ✅\n💡 Что заметил: легче утром\n🚦 Статус: 🟢 FLOW').insight, 'легче утром');
  assert.equal(game.weekOf('2026-11-29'), '2026-11-23');

  const GID = -1001234500888, CH = 'g1001234500888', chat = { id: GID, type: 'supergroup', title: 'Life Game', is_forum: true };
  const KOLYA = { id: 777301, first_name: 'Коля', username: 'kolya_t' }, VLAD = { id: 777302, first_name: 'Влад', last_name: 'Исаков' }, IRA = { id: 777303, first_name: 'Ира' };
  const sec = () => Math.floor(Date.now() / 1000);
  const root = (name) => ({ message_id: 1, forum_topic_created: { name } });
  const gmsg = (from, extra, key) => ({ update_id: ++mid, [key || 'message']: Object.assign({ message_id: ++mid, date: sec(), chat, from }, extra) });
  const inTopic = (id, name, extra) => Object.assign({ is_topic_message: true, message_thread_id: id, reply_to_message: Object.assign({ message_thread_id: id }, root(name)) }, extra);
  const gtap = (from, data, msgId) => ({ update_id: ++mid, callback_query: { id: 'cq' + (++mid), from, data, message: { message_id: msgId, chat, is_topic_message: true, message_thread_id: 13 } } });
  const said = (n, method) => sinceMark(n, method || 'sendMessage').filter((c) => String(c.params.chat_id) === String(GID));
  const acks = (n) => sinceMark(n, 'answerCallbackQuery').map((c) => c.params);
  const docs = async (coll, token) => (await call('GET', '/api/db/' + coll, { token: token || ownerToken })).json.docs;
  const mine = async (coll) => (await docs(coll)).filter((d) => d.data.project === 'p-game');
  const cbs = (c) => c.params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  const day = clock.parts(Date.now(), await clock.appTz()).d, week = game.weekOf(day), key = day.replace(/-/g, '');

  await call('PUT', '/api/db/projects/p-game', { token: ownerToken, json: { data: { name: 'Life Game', status: 'active', order: 95 } } });
  await update(gmsg(OWNER, { text: '/start p_p-game' }));
  // without the game a card in the chat is only a message
  await update(gmsg(VLAD, { text: '🜁 ДУХ\n🎯 Квест: Рано вставать' }));
  assert.equal((await mine('quests')).length, 0);
  // the game is switched on in the project: the chat hears what the bot now keeps
  let n = tgCalls.length;
  assert.equal((await call('PATCH', '/api/db/projects/p-game', { token: ownerToken, json: { data: { game: { on: true } } } })).status, 200);
  assert.match(said(n)[0].params.text, /включена игра[\s\S]*Quest Board[\s\S]*Daily Log[\s\S]*правилам 1\.1[\s\S]*подтверждать его никому не нужно[\s\S]*\/game/);
  n = tgCalls.length;
  await call('PATCH', '/api/db/projects/p-game', { token: ownerToken, json: { data: { next: 'Первый спринт' } } });
  assert.equal(said(n).length, 0);

  // topics: the bot learns their names
  await update(gmsg(KOLYA, { is_topic_message: true, message_thread_id: 5, forum_topic_created: { name: '📜 QUEST BOARD' } }));
  await update(gmsg(KOLYA, { is_topic_message: true, message_thread_id: 18, forum_topic_created: { name: '🔥 CAMPFIRE' } }));
  // the empty templates and the rules of a topic are neither a card nor a report
  n = tgCalls.length;
  await update(gmsg(KOLYA, inTopic(5, '📜 QUEST BOARD', { text: '🎮 PLAYER CARD — SPRINT 01\n👤 Игрок:\n⭐ XP: 0\n\n🜁 ДУХ\n\n🎯 Квест:\n🏁 Результат:\n⚡ Сложность: L1 / L2 / L3\n📍 Статус: 🎯 ACTIVE\n\n🏆 ИТОГ НЕДЕЛИ\n\n🜁 Дух:\n♡ Душа:' })));
  await update(gmsg(KOLYA, inTopic(13, '⚡ DAILY LOG', { text: '⚡ DAILY LOG — DAY __\n\n👤 Игрок:\n\n🜁 Дух: ✅ / ❌ / —\n♡ Душа: ✅ / ❌ / —\n△ Тело: ✅ / ❌ / —\n\n🎯 Что сделал:\n\n💡 Открытие дня:\n\n🚦 Статус: 🟢 / 🟡 / 🔴' })));
  await update(gmsg(KOLYA, inTopic(13, '⚡ DAILY LOG', { text: '⚡ DAILY LOG\nЗдесь мы фиксируем ежедневный прогресс!\n' + 'Регулярность важнее идеальности. '.repeat(45) })));
  assert.equal((await mine('quests')).length + (await mine('checkins')).length, 0);
  assert.equal(said(n).length, 0);
  assert.deepEqual((await docs('chats')).find((d) => d.id === CH).data.topics, { 5: '📜 QUEST BOARD', 18: '🔥 CAMPFIRE', 13: '⚡ DAILY LOG' });

  // a player's card: the quests of this week
  n = tgCalls.length;
  const card = (title) => '🎮 PLAYER CARD — SPRINT 01\n👤 Игрок: Влад\n\n⸻\n\n🜁 ДУХ\n\n🎯 Квест: ' + title + '\n🏁 Результат: 5 уроков\n🔁 Действие: урок в приложении\n🌱 Дневной минимум: 10 минут\n📅 Частота: 5 дней\n⚡ Сложность: L2\n📍 Статус: 🎯 ACTIVE\n\n⸻\n\n♡ ДУША\n\n🎯 Квест:\n⚡ Сложность: L1 / L2 / L3\n\n⸻\n\n△ ТЕЛО\n\n🎯 Квест: Бег\n🌱 Дневной минимум: 2 км\n📅 Частота: каждый день\n⚡ Сложность: L3\n\n🌍 PARTY QUEST\n\nМоё участие: сон до 23\n\n🏆 ИТОГ НЕДЕЛИ\n\n🜁 Дух:\n△ Тело:';
  const cardMsg = gmsg(VLAD, inTopic(5, '📜 QUEST BOARD', { text: card('Английский') }));
  await update(cardMsg);
  let qs = await mine('quests');
  assert.deepEqual(qs.map((d) => [d.data.branch, d.data.title, d.data.level, d.data.freq, d.data.status, d.data.player, d.data.week]).sort(), [['body', 'Бег', 3, 7, 'active', '777302', week], ['party', 'сон до 23', undefined, undefined, 'active', '777302', week], ['spirit', 'Английский', 2, 5, 'active', '777302', week]]);
  assert.equal(qs.find((d) => d.data.branch === 'spirit').data.min, '10 минут');
  assert.match(said(n)[0].params.text, /Квесты <b>Влад Исаков<\/b> на спринт[\s\S]*🜁 Дух: Английский · L2\n△ Тело: Бег · L3\n🌍 Общий квест: сон до 23\nКвест завершён\? Отметь кнопкой/);
  const wkey = week.replace(/-/g, ''), cardAck = said(n)[0];
  assert.deepEqual(cbs(cardAck), ['gz:s:' + wkey + ':777302', 'gz:b:' + wkey + ':777302', 'gz:p:' + wkey + ':777302']);
  assert.equal(said(n)[0].params.message_thread_id, 5);
  // the card was edited: the quests follow, the bot does not answer twice
  n = tgCalls.length;
  await update(gmsg(VLAD, Object.assign({}, cardMsg.message, { text: card('Английский: 20 минут'), edit_date: sec() }), 'edited_message'));
  qs = await mine('quests');
  assert.equal(qs.length, 3);
  assert.equal(qs.find((d) => d.data.branch === 'spirit').data.title, 'Английский: 20 минут');
  assert.equal(said(n).length, 0);
  // nothing of it waits for a review
  assert.equal((await docs('messages')).filter((d) => d.data.project === 'p-game' && d.data.proposal).length, 0);

  // a message in Daily Log is the report of the day; the branches are marked on the buttons
  n = tgCalls.length;
  const rep1 = gmsg(VLAD, inTopic(13, '⚡ DAILY LOG', { text: 'Сделал урок, пробежка вечером' }));
  await update(rep1);
  let ck = (await mine('checkins'))[0];
  assert.equal(ck.id, 'k' + key + '-777302-p-game');
  assert.deepEqual([ck.data.spirit, ck.data.body, ck.data.chat, ck.data.date, ck.data.week], [null, null, 'Сделал урок, пробежка вечером', day, week]);
  let ack = said(n)[0];
  assert.match(ack.params.text, /Отчёт: <b>Влад Исаков<\/b>[\s\S]*🜁 Дух — · ♡ Душа — · △ Тело —\n\+5 XP за отчёт · 5 XP за спринт/);
  assert.deepEqual(cbs(ack), ['gq:s:' + key + ':777302', 'gq:b:' + key + ':777302', 'gq:h:' + key + ':777302']);
  assert.equal(ack.params.reply_parameters.message_id, rep1.message.message_id);
  const ackId = (await mine('checkins'))[0].data.ack.id;
  // somebody else's report is not theirs to mark
  n = tgCalls.length;
  await update(gtap(IRA, 'gq:s:' + key + ':777302', ackId));
  assert.match(acks(n)[0].text, /другого игрока/);
  assert.equal((await mine('checkins'))[0].data.spirit, null);
  await update(gtap(VLAD, 'gq:s:' + key + ':777302', ackId));
  assert.equal((await mine('checkins'))[0].data.spirit, true);
  const ed = said(n, 'editMessageText')[0];
  assert.equal(ed.params.message_id, ackId);
  assert.match(ed.params.text, /🜁 Дух ✅[\s\S]*\+5 XP за отчёт · 5 XP за спринт/); // a day's mark is progress, not XP
  // an answer to another player in the topic is support, not a report
  await update(gmsg(IRA, { is_topic_message: true, message_thread_id: 13, text: 'Круто!', reply_to_message: { message_id: rep1.message.message_id, from: VLAD, text: 'Сделал урок' } }));
  assert.equal((await mine('checkins')).length, 1);
  // a report by the template, from anywhere: the marks join the day's report, a call for help reaches Campfire
  n = tgCalls.length;
  await update(gmsg(VLAD, { text: '⚡ DAILY LOG — DAY 1\n👤 Игрок: Влад\n🜁 Дух: ✅\n♡ Душа: ✅\n△ Тело: ✅\n🎯 Что сделал: 2 км\n💡 Открытие дня: утром легче\n🚦 Статус: 🔴' }));
  ck = (await mine('checkins'))[0];
  assert.deepEqual([ck.data.spirit, ck.data.soul, ck.data.body, ck.data.insight, ck.data.signal], [true, true, true, 'утром легче', 'help']);
  assert.equal(ck.data.chat, 'Сделал урок, пробежка вечером\n2 км');
  assert.match(said(n, 'editMessageText')[0].params.text, /Дух ✅ · ♡ Душа ✅ · △ Тело ✅\n\+5 XP за отчёт · 5 XP за спринт\n🔴 Нужна помощь/);
  const fire = said(n).find((c) => c.params.message_thread_id === 18);
  assert.match(fire.params.text, /🔴 <b>Влад Исаков<\/b> просит помощи[\s\S]*t\.me\/c\/1234500888\//);
  // the help button: up to three a week
  await update(gtap(VLAD, 'gq:h:' + key + ':777302', ackId));
  assert.equal((await mine('checkins'))[0].data.help, 1);
  // a quest brings its XP once, when the player says it is done: the button under the card
  n = tgCalls.length;
  await update(gtap(IRA, 'gz:s:' + wkey + ':777302', 9001));
  assert.match(acks(n)[0].text, /другого игрока/);
  await update(gtap(VLAD, 'gz:s:' + wkey + ':777302', 9001));
  assert.equal((await mine('quests')).find((d) => d.data.branch === 'spirit').data.status, 'done');
  assert.match(said(n, 'editMessageText')[0].params.text, /🜁 Дух: Английский: 20 минут · L2 — ✅ \+20 XP\n△ Тело: Бег · L3\n/);
  await update(gtap(VLAD, 'gz:b:' + wkey + ':777302', 9001));
  await update(gtap(VLAD, 'gz:b:' + wkey + ':777302', 9001));                      // taken back
  assert.equal((await mine('quests')).find((d) => d.data.branch === 'body').data.status, 'active');
  // /game: the week by players, by name
  n = tgCalls.length;
  await update(gmsg(IRA, inTopic(13, '⚡ DAILY LOG', { text: 'Сегодня отдыхала' })));
  await update(gmsg(IRA, { text: '/game' }));
  const tbl = said(n).pop().params.text;
  assert.match(tbl, /<b>Life Game<\/b> · спринт[\s\S]*<b>Влад Исаков<\/b> — 35 XP \(🜁 20 · отчёты 5 · помощь 10\)\n<b>Ира<\/b> — 5 XP \(отчёты 5\)/);

  // the app: a player writes their own records whatever their level, and nobody else's
  await db.upsertMember(String(VLAD.id), '', 'Влад Исаков', 'viewer'); await db.setMemberAccess(String(VLAD.id), 'viewer', ['p-game']);
  await db.upsertMember(String(IRA.id), '', 'Ира', 'editor'); await db.setMemberAccess(String(IRA.id), 'editor', ['p-game', 'p-feed']);
  const vlad = (await call('POST', '/api/auth/telegram', { json: { initData: initData(VLAD) } })).json, ira = (await call('POST', '/api/auth/telegram', { json: { initData: initData(IRA) } })).json;
  assert.equal(vlad.role, 'viewer');
  assert.deepEqual(vlad.user.id, '777302');
  assert.equal((await docs('quests', vlad.token)).length, 3);
  const w = (m, path, token, data) => call(m, '/api/db/' + path, { token, json: data ? { data } : undefined });
  const q = (player, extra) => Object.assign({ project: 'p-game', player, name: 'x', week, branch: 'soul', title: 'Рисовать', status: 'active', level: 1 }, extra);
  assert.equal((await w('PUT', 'quests/q-v-soul', vlad.token, q('777302'))).status, 200);
  assert.equal((await w('PATCH', 'quests/q-v-soul', vlad.token, { status: 'done' })).status, 200);
  assert.equal((await w('PUT', 'quests/q-fake', vlad.token, q('777303'))).status, 403);
  assert.equal((await w('PATCH', 'quests/q-v-soul', ira.token, { title: 'Чужое' })).status, 403);
  assert.equal((await w('PATCH', 'quests/q-v-soul', vlad.token, { player: '777303' })).status, 403);
  assert.equal((await w('DELETE', 'quests/q-v-soul', ira.token)).status, 403);
  assert.equal((await w('PATCH', 'checkins/' + ck.id, ira.token, { spirit: false })).status, 403);
  assert.equal((await w('PATCH', 'checkins/' + ck.id, vlad.token, { text: 'из приложения' })).status, 200);
  assert.equal((await w('PUT', 'checkins/k-ira', ira.token, { project: 'p-game', player: '777303', name: 'Ира', date: day, week, body: true })).status, 200);
  // a viewer stays a viewer for the rest of the project; a game that is off takes nothing
  assert.equal((await w('PUT', 'tasks/t-v', vlad.token, { project: 'p-game', title: 'x' })).status, 403);
  assert.equal((await w('PUT', 'quests/q-off', ira.token, q('777303', { project: 'p-feed' }))).status, 403);
  assert.equal((await w('PUT', 'quests/q-else', vlad.token, q('777302', { project: 'p-feed' }))).status, 403);
  // an idea for the library belongs to the one who brought it; those who run the project change anything
  assert.equal((await w('PUT', 'quests/q-lib', ira.token, { project: 'p-game', lib: true, by: '777303', branch: 'body', title: 'Планка', l1: '30 секунд' })).status, 200);
  assert.equal((await w('DELETE', 'quests/q-lib', vlad.token)).status, 403);
  assert.equal((await w('PATCH', 'quests/q-v-soul', ownerToken, { title: 'Рисовать каждый день' })).status, 200);
  assert.equal((await w('DELETE', 'quests/q-lib', ownerToken)).status, 200);
  assert.equal((await w('DELETE', 'quests/q-v-soul', vlad.token)).status, 200);
});

test('a meeting set in a zone of its own is told in that zone', async () => {
  const remind = require('../src/remind'), clock = require('../src/clock'), attend = require('../src/attend');
  const put = (path, data) => call('PUT', '/api/db/' + path, { token: ownerToken, json: { data } });
  const tz = await clock.appTz(), start = Date.UTC(2031, 4, 10, 9, 0), at = clock.parts(start, tz);   // 12:00 in Moscow and in Cairo (summer time there)
  await put('events/e-zone', { title: 'По Москве', date: at.d, time: at.t, rem: [60], zone: 'Europe/Moscow' });
  await put('events/e-zone2', { title: 'По Каиру', date: at.d, time: at.t, rem: [60], zone: 'Africa/Cairo', link: 'https://meet.example/z', share: 'zonesharetoken01' });
  await put('events/e-zone3', { title: 'Без пояса', date: at.d, time: at.t, rem: [60], zone: 'Nowhere/Land' });
  const n = tgCalls.length;
  await remind.tick(start - 60 * 60000 + 1000);
  const texts = sinceMark(n, 'sendMessage').filter((c) => String(c.params.chat_id) === String(OWNER.id)).map((c) => c.params.text);
  assert.match(texts.find((t) => /По Москве/.test(t)), /\n10 мая, 12:00 \(МСК, UTC\+3\)/);
  assert.match(texts.find((t) => /По Каиру/.test(t)), /\n10 мая, 12:00 \(Каир, UTC\+3\)/);
  const plain = texts.find((t) => /Без пояса/.test(t));
  assert.ok(plain.includes('\n' + remind.dayLabel(at.d) + ', ' + at.t) && !/UTC/.test(plain), 'an unknown zone is ignored: the app\'s clock, as before');
  // a participant reads the same zone, in their language; the report to the owner too
  await update(msg(EVE, { text: '/start even_zonesharetoken01', from: Object.assign({}, EVE, { language_code: 'en' }) }));
  assert.match(lastSay().params.text, /May 10, 2031, 12:00 \(Cairo, UTC\+3\)/);
  assert.match(attend.reportText({ title: 'По Москве', time: at.t, zone: 'Europe/Moscow' }, at.d, [], '', tz), /10 мая 12:00 \(МСК, UTC\+3\)/);
  assert.deepEqual([clock.okZone('Asia/Tbilisi'), clock.okZone('x'), clock.okZone('')], [true, false, false]);
});

test('game: the AI companion talks to a player in the private chat, saves what the player agreed to, keeps the talk to itself', async () => {
  const game = require('../src/game'), db = require('../src/db'), clock = require('../src/clock');
  const GID = -1001234500888, chat = { id: GID, type: 'supergroup', title: 'Life Game', is_forum: true };
  const VLAD = { id: 777302, first_name: 'Влад', last_name: 'Исаков' }, DAVID = { id: 777305, first_name: 'David' }, OUT = { id: 777306, first_name: 'Чужой' };
  const sec = () => Math.floor(Date.now() / 1000);
  const said = (n, to, method) => sinceMark(n, method || 'sendMessage').filter((c) => String(c.params.chat_id) === String(to));
  const day = clock.parts(Date.now(), await clock.appTz()).d, week = game.weekOf(day);
  const mine = async (coll, uid) => (await call('GET', '/api/db/' + coll, { token: ownerToken })).json.docs.filter((d) => d.data.project === 'p-game' && String(d.data.player) === String(uid));
  const tool = (name, input) => ({ content: [{ type: 'tool_use', id: 'tu' + (++mid), name, input }], stop_reason: 'tool_use' });
  const text = (t) => ({ content: [{ type: 'text', text: t }] });

  // the way in from the chat of the game
  let n = tgCalls.length;
  await update({ update_id: ++mid, message: { message_id: ++mid, date: sec(), chat, from: DAVID, text: '/companion' } });
  const door = said(n, GID)[0];
  assert.match(door.params.text, /AI-компаньон игры[\s\S]*Никуда выходить из Telegram не нужно[\s\S]*видит только сам игрок/);
  assert.equal(door.params.reply_markup.inline_keyboard[0][0].url, 'https://t.me/prooloog_test_bot?start=gm_p-game');

  // somebody who is not in the chat and has no project does not get in
  tgMember[String(OUT.id)] = 'left';
  n = tgCalls.length;
  await update(msg(OUT, { text: '/start gm_p-game' }));
  assert.match(said(n, OUT.id)[0].params.text, /открыт её игрокам/);
  assert.equal(await db.kvGet('comp:' + OUT.id), null);

  // a member of the chat without any access to the dashboard: the talk opens, the companion knows the rules and the player
  n = tgCalls.length;
  aiScript.push(text('Привет, David! **Что** хочется изменить за неделю?'));
  await update(msg(DAVID, { text: '/start gm_p-game' }));
  let out = said(n, DAVID.id);
  assert.match(out[0].params.text, /AI-компаньон игры «Life Game»[\s\S]*видишь только ты[\s\S]*Стереть разговор/);
  assert.equal(out[1].params.text, 'Привет, David! Что хочется изменить за неделю?');
  assert.equal(out[1].params.parse_mode, undefined);
  assert.deepEqual(out[1].params.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['cm:end', 'cm:wipe']);
  let req = aiSrv.last.body;
  assert.match(req.system, /личный AI-компаньон[\s\S]*правила 1\.1[\s\S]*L1 10, L2 20, L3 30[\s\S]*Игрок: David[\s\S]*Квестов в этом спринте у игрока пока нет/);
  assert.deepEqual(req.tools.map((t) => t.name), ['save_quests', 'save_report', 'finish_quest', 'add_idea']);
  assert.equal(req.messages.length, 1);

  // plain messages now go to the companion; it saves the quests only through its tool, and posts the card when asked
  n = tgCalls.length;
  aiScript.push(tool('save_quests', { quests: [{ branch: 'soul', title: 'Гитара', why: 'для радости', result: '5 занятий', min: '15 минут', freq: 5, level: 2 }, { branch: 'nope', title: 'x', level: 1 }], party: 'ранний сон', publish: true }), text('Сохранил и опубликовал карточку.'));
  await update(msg(DAVID, { text: 'Да, сохраняй и публикуй. Мой секрет: боюсь сцены' }));
  let qs = await mine('quests', DAVID.id);
  assert.deepEqual(qs.map((d) => [d.data.branch, d.data.title, d.data.level, d.data.freq, d.data.week, d.data.name, d.data.src]).sort(), [['party', 'ранний сон', undefined, undefined, week, 'David', 'companion'], ['soul', 'Гитара', 2, 5, week, 'David', 'companion']]);
  assert.equal(said(n, DAVID.id).pop().params.text, 'Сохранил и опубликовал карточку.');
  const card = said(n, GID)[0];
  assert.match(card.params.text, /Квесты <b>David<\/b> на спринт[\s\S]*♡ Душа: Гитара · L2\n🌍 Общий квест: ранний сон/);
  assert.equal(card.params.message_thread_id, 5);                           // the Quest Board topic
  req = aiSrv.last.body;
  assert.equal(req.messages[req.messages.length - 1].content[0].type, 'tool_result');
  assert.match(req.messages[req.messages.length - 1].content[0].content, /"published":true/);

  // the day's report and a finished quest
  aiScript.push(tool('save_report', { soul: true, text: 'Играл гаммы', insight: 'утром проще', signal: 'flow' }), tool('finish_quest', { branch: 'soul', done: true }), text('Отчёт сохранён, квест завершён.'));
  await update(msg(DAVID, { text: 'Сегодня играл гаммы, и квест уже выполнен' }));
  const ck = (await mine('checkins', DAVID.id))[0];
  assert.deepEqual([ck.id, ck.data.soul, ck.data.spirit, ck.data.text, ck.data.insight, ck.data.signal, ck.data.date], [game.checkId('p-game', '777305', day), true, null, 'Играл гаммы', 'утром проще', 'flow', day]);
  assert.equal((await mine('quests', DAVID.id)).find((d) => d.data.branch === 'soul').data.status, 'done');
  const row = (await game.table(await db.getDoc('projects', 'p-game'), week)).find((r) => r.player === '777305');
  assert.equal(row.xp.total, 25);                                           // L2 quest 20 + report 5
  // the next request carries what the player has by now
  aiScript.push(text('Дальше — по плану.'));
  await update(msg(DAVID, { text: 'Что дальше?' }));
  assert.match(aiSrv.last.body.system, /- Душа, L2: Гитара; результат: 5 занятий; дневной минимум: 15 минут; дней в неделю: 5; статус: done[\s\S]*XP игрока: за спринт 25/);

  // the talk stays with the bot: not in the project's messages, not in a copy of the data
  const exp = JSON.stringify((await call('GET', '/api/export', { token: ownerToken })).json);
  assert.ok(!exp.includes('боюсь сцены') && exp.includes('Гитара'));
  assert.ok(!JSON.stringify((await call('GET', '/api/db/messages', { token: ownerToken })).json).includes('боюсь сцены'));
  assert.ok(JSON.stringify(await db.kvGet('comp:' + DAVID.id)).includes('боюсь сцены'));

  // the owner plays too, with a talk of their own; a player's /end closes the talk, plain text then goes the usual way
  aiScript.push(text('Привет, Alex!'));
  await update(msg(OWNER, { text: '/companion' }));
  assert.match(aiSrv.last.body.system, /Игрок: Alex Owner/);
  await update(msg(OWNER, { text: '/end' }));
  assert.equal((await db.kvGet('comp:' + OWNER.id)).on, false);
  n = tgCalls.length;
  await update(msg(DAVID, { text: '/end' }));
  assert.match(said(n, DAVID.id)[0].params.text, /завершён, я помню его/);
  n = tgCalls.length;
  await update(msg(DAVID, { text: 'ещё вопрос' }));
  assert.doesNotMatch(said(n, DAVID.id)[0].params.text, /по плану/);       // the closed dashboard answers, not the companion
  // coming back: the talk goes on; «Стереть разговор» wipes it and leaves the records of the game
  aiScript.push(text('Мы остановились на гитаре.'));
  await update(msg(DAVID, { text: '/companion' }));
  assert.ok(aiSrv.last.body.messages.length > 4);
  n = tgCalls.length;
  await update({ update_id: ++mid, callback_query: { id: 'cq' + (++mid), from: DAVID, data: 'cm:wipe', message: { message_id: 5100, chat: { id: DAVID.id, type: 'private' } } } });
  assert.match(said(n, DAVID.id)[0].params.text, /Разговор стёрт/);
  assert.deepEqual((await db.kvGet('comp:' + DAVID.id)).turns, []);
  assert.equal((await mine('quests', DAVID.id)).length, 2);
  // an error of Claude is said in words, the message is not lost in the talk
  aiMode = 'badkey';
  n = tgCalls.length;
  await update(msg(DAVID, { text: '/companion' }));
  assert.match(said(n, DAVID.id).pop().params.text, /не принял ключ/);
  aiMode = 'ok';
});
