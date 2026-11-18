'use strict';
// Local playground: the real server with stand-ins for Telegram and the Claude API.
// Used by the browser checks; never deployed.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT = +process.env.DEV_PORT || 18081, BOT = '123456:DEVTOKEN';
const calls = [], files = { 'files/VOICEFILE12345': Buffer.from('OggS-fake') };
function body(req) { return new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c))); }); }
function initData(user) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAE', user: JSON.stringify(user) });
  const check = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}
(async () => {
  const tg = http.createServer(async (req, res) => {
    if (req.url === '/__calls') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(calls)); }
    const raw = await body(req), m = /^\/bot[^/]+\/(\w+)/.exec(req.url), f = /^\/file\/bot[^/]+\/(.+)$/.exec(req.url);
    if (f) { const b = files[decodeURIComponent(f[1])]; if (!b) { res.statusCode = 404; return res.end(); } return res.end(b); }
    if (!m) { res.statusCode = 404; return res.end(); }
    let params = {}; try { params = JSON.parse(raw.toString('utf8') || '{}'); } catch (e) { params = {}; }
    calls.push({ method: m[1], params });
    let result = true;
    if (m[1] === 'getMe') result = { id: 1, is_bot: true, username: 'prooloog_dev_bot' };
    if (m[1] === 'sendMessage' || m[1] === 'editMessageText') result = { message_id: 1000 + calls.length };
    if (m[1] === 'getFile') result = { file_id: params.file_id, file_path: 'files/' + params.file_id, file_size: 9 };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise((r) => tg.listen(0, '127.0.0.1', r));
  const ai = http.createServer(async (req, res) => {
    await body(req);
    res.setHeader('content-type', 'text/event-stream');
    const ev = (n, d) => res.write('event: ' + n + '\ndata: ' + JSON.stringify(d) + '\n\n');
    ev('message_start', { type: 'message_start', message: {} });
    for (const t of ['Короткая версия ', 'на 30 секунд ', 'подойдёт агенту лучше.']) { ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }); await new Promise((r) => setTimeout(r, 60)); }
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }); ev('message_stop', { type: 'message_stop' }); res.end();
  });
  await new Promise((r) => ai.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    PORT: String(PORT), DATABASE_URL: process.env.DEV_DATABASE_URL || 'postgres://prooloog@127.0.0.1:54329/prooloog_dev',
    BOT_TOKEN: BOT, TG_API_ROOT: 'http://127.0.0.1:' + tg.address().port, APP_URL: 'https://prooloog.test',
    OWNER_USERNAME: 'alex_owner', SESSION_SECRET: 'dev-session-secret', WEBHOOK_SECRET: 'dev-hook',
    ANTHROPIC_API_KEY: process.env.DEV_NO_AI ? '' : 'sk-dev', AI_API_ROOT: 'http://127.0.0.1:' + ai.address().port,
    SEED_FILE: process.env.DEV_SEED || path.join(__dirname, 'fixture-seed.json'),
  });
  const db = require('../src/db');
  await db.init(process.env.DATABASE_URL);
  await db.q('DROP TABLE IF EXISTS docs, kv, members, invites, login_codes, bot_state, files, sent_reminders, invite_links');
  await db.close();
  await require('../src/server').start();
  const cfg = require('../src/config');
  fs.writeFileSync('/tmp/dev.json', JSON.stringify({
    base: 'http://127.0.0.1:' + PORT, tg: 'http://127.0.0.1:' + tg.address().port, hookPath: cfg.webhookPath, hookSecret: cfg.webhookSecret,
    owner: initData({ id: 777001, first_name: 'Alex', last_name: 'Owner', username: 'alex_owner' }),
    viewer: initData({ id: 777004, first_name: 'Vera', username: 'vera_viewer' }),
    stranger: initData({ id: 777005, first_name: 'Sam', username: 'sam_stranger' }),
  }));
  console.log('dev server ready on ' + PORT);
})().catch((e) => { console.error(e); process.exit(1); });
