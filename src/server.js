'use strict';
// Prooloog server: serves the dashboard page, its data API, live updates and the Telegram webhook.
const fs = require('fs');
const path = require('path');
const express = require('express');
const cfg = require('./config');
const db = require('./db');
const auth = require('./auth');
const hub = require('./realtime');
const bot = require('./bot');
const ai = require('./ai');
const T = require('./telegram');

const PUBLIC = path.join(__dirname, '..', 'public');
const SEED = cfg.seedFile || path.join(__dirname, '..', 'seed', 'initial.json');
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* ---------- the page ---------- */
let pageCache = null;
function page() {
  if (pageCache && process.env.NODE_ENV !== 'development') return pageCache;
  let html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  // The page itself is the same one that runs inside Claude. On the server it gets a small adapter
  // (shim.js) that stands in for the platform: data, sign-in, files.
  html = html.replace(/<title>[\s\S]*?<\/title>/, '<title>' + cfg.appName.replace(/[<>&]/g, '') + '</title>');
  html = html.replace('</head>', '<script src="https://telegram.org/js/telegram-web-app.js"></script>\n<script src="/shim.js"></script>\n</head>');
  pageCache = html;
  return html;
}

/* ---------- small helpers ---------- */
// A plain in-memory limiter: enough for one small instance.
function limiter(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const k = req.ip || 'x', t = Date.now();
    const a = (hits.get(k) || []).filter((x) => t - x < windowMs);
    if (a.length >= max) return res.status(429).json({ error: 'rate_limited' });
    a.push(t); hits.set(k, a);
    if (hits.size > 5000) hits.clear();
    next();
  };
}
function collOf(req, res, write) {
  const coll = req.params.coll;
  if (!cfg.collections.includes(coll)) { res.status(404).json({ error: 'unknown_collection' }); return null; }
  if (cfg.ownerOnly.has(coll) && req.user.role !== 'owner') { res.status(403).json({ error: 'forbidden' }); return null; }
  if (write && req.user.role === 'viewer') { res.status(403).json({ error: 'forbidden' }); return null; }
  return coll;
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const srcOf = (req) => String(req.headers['x-client'] || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);

function build() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  app.get('/', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.type('html').send(page()); });
  app.get('/shim.js', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(PUBLIC, 'shim.js')); });
  app.get('/robots.txt', (req, res) => res.type('text').send('User-agent: *\nDisallow: /\n'));

  /* ---------- Telegram webhook ---------- */
  app.post('/tg/:secret', express.json({ limit: '2mb' }), async (req, res) => {
    if (req.params.secret !== cfg.webhookPath || req.headers['x-telegram-bot-api-secret-token'] !== cfg.webhookSecret) return res.status(404).end();
    // Answer only after the update is handled, so a crash makes Telegram deliver it again.
    const work = bot.handleUpdate(req.body);
    const timeout = new Promise((r) => setTimeout(r, 25000));
    await Promise.race([work, timeout]);
    res.json({ ok: true });
  });

  /* ---------- API ---------- */
  const api = express.Router();
  const json = express.json({ limit: '400kb' });
  const authLimit = limiter(30, 60000);

  const session = async (user, role) => ({
    token: auth.signSession(user.id), role, user: await auth.profileOf(String(user.id), role),
    caps: { ai: ai.enabled(), files: true }, app: { name: cfg.appName, bot: bot.name() }, ownerOnly: [...cfg.ownerOnly],
  });
  api.post('/auth/telegram', authLimit, json, async (req, res) => {
    const user = auth.checkInitData(req.body && req.body.initData);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    const role = await auth.roleOf(user);
    if (!role) return res.status(403).json({ error: 'no_access' });
    res.json(await session(user, role));
  });
  api.post('/auth/code', authLimit, json, async (req, res) => {
    const code = req.body && req.body.code;
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(code)) return res.status(401).json({ error: 'unauthorized' });
    const id = await db.useLoginCode(code);
    if (!id) return res.status(401).json({ error: 'code_expired' });
    const role = await auth.roleOf({ id });
    if (!role) return res.status(403).json({ error: 'no_access' });
    res.json(await session({ id }, role));
  });
  api.get('/me', auth.guard(), async (req, res) => {
    res.json({ role: req.user.role, user: await auth.profileOf(req.user.id, req.user.role), caps: { ai: ai.enabled(), files: true }, app: { name: cfg.appName, bot: bot.name() }, ownerOnly: [...cfg.ownerOnly] });
    bot.maybeBackup();
  });

  api.get('/db/:coll', auth.guard(), async (req, res) => {
    const coll = collOf(req, res, false); if (!coll) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ docs: await db.listDocs(coll) });
  });
  api.put('/db/:coll/:id', auth.guard('write'), json, async (req, res) => {
    const coll = collOf(req, res, true); if (!coll) return;
    if (!ID_RE.test(req.params.id) || !isObj(req.body && req.body.data)) return res.status(400).json({ error: 'bad_request' });
    const d = await db.setDoc(coll, req.params.id, req.body.data);
    hub.publish(coll, d.id, d.data, d.version, srcOf(req));
    res.json({ ok: true, version: d.version });
  });
  api.patch('/db/:coll/:id', auth.guard('write'), json, async (req, res) => {
    const coll = collOf(req, res, true); if (!coll) return;
    if (!ID_RE.test(req.params.id) || !isObj(req.body && req.body.data)) return res.status(400).json({ error: 'bad_request' });
    const d = await db.updateDoc(coll, req.params.id, req.body.data);
    if (!d) return res.status(404).json({ error: 'not_found' });
    hub.publish(coll, d.id, d.data, d.version, srcOf(req));
    res.json({ ok: true, version: d.version });
  });
  api.delete('/db/:coll/:id', auth.guard('write'), async (req, res) => {
    const coll = collOf(req, res, true); if (!coll) return;
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'bad_request' });
    await db.deleteDoc(coll, req.params.id);
    hub.publish(coll, req.params.id, null, 0, srcOf(req));
    res.json({ ok: true });
  });

  api.get('/stream', auth.guard(), (req, res) => hub.attach(req, res, req.user));

  // Pictures for service cards. Stored in the database: the server's own disk is wiped on every deploy.
  api.post('/files', auth.guard('write'), express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '3mb' }), async (req, res) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (!Buffer.isBuffer(req.body) || !req.body.length || !['image/jpeg', 'image/png', 'image/webp'].includes(type)) return res.status(400).json({ error: 'bad_request' });
    const id = await db.putFile(type, req.body, req.user.id);
    res.json({ url: '/f/' + id });
  });

  api.get('/export', auth.guard('owner'), async (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="prooloog-backup.json"');
    res.json({ app: 'prooloog', version: 1, exportedAt: new Date().toISOString(), docs: await db.exportAll() });
  });
  api.post('/import', auth.guard('owner'), express.json({ limit: '25mb' }), async (req, res) => {
    const b = req.body || {};
    if (b.app !== 'prooloog' || !isObj(b.docs)) return res.status(400).json({ error: 'bad_request' });
    const n = await db.importAll(b.docs, cfg.collections, b.mode === 'replace');
    hub.reloadAll();
    res.json({ ok: true, imported: n });
  });

  // Voice messages the bot has saved: played in the dashboard straight from Telegram.
  api.get('/tg/file/:fileId', auth.guard('owner'), async (req, res) => {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(req.params.fileId)) return res.status(400).end();
    let f;
    try { f = await T.openFile(req.params.fileId); } catch (e) { return res.status(404).end(); }
    const ext = path.extname(f.path).toLowerCase();
    res.setHeader('Content-Type', { '.oga': 'audio/ogg', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav' }[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(Buffer.from(await f.res.arrayBuffer()));
  });

  api.post('/ai', auth.guard('write'), json, (req, res) => ai.handle(req, res));

  api.use((req, res) => res.status(404).json({ error: 'not_found' }));
  app.use('/api', api);

  app.get('/f/:id', async (req, res) => {
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(req.params.id)) return res.status(404).end();
    const f = await db.getFile(req.params.id);
    if (!f) return res.status(404).end();
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(f.bytes);
  });

  app.use((req, res) => res.status(404).type('text').send('Not found'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.type === 'entity.too.large' ? 413 : err.type === 'entity.parse.failed' || err.code === 'bad_data' ? 400 : 500;
    if (status === 500) console.error('[http]', req.method, req.path, err.message);
    if (res.headersSent) return res.end();
    res.status(status).json({ error: status === 413 ? 'too_large' : status === 400 ? 'bad_request' : 'server_error' });
  });
  return app;
}

// First start with an empty database: bring in the data exported from the Claude-hosted dashboard.
async function seedIfEmpty() {
  if (!fs.existsSync(SEED) || (await db.countDocs()) > 0 || (await db.kvGet('seeded'))) return 0;
  const j = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const n = await db.importAll(j.docs || {}, cfg.collections, false);
  await db.kvSet('seeded', { at: new Date().toISOString(), docs: n });
  console.log('[seed] imported ' + n + ' records');
  return n;
}

async function start() {
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set');
  if (!cfg.sessionSecretFixed) console.warn('[auth] SESSION_SECRET is not set: sessions will not survive a restart');
  await db.init(cfg.databaseUrl);
  await seedIfEmpty();
  const app = build();
  const server = await new Promise((resolve) => { const s = app.listen(cfg.port, '0.0.0.0', () => resolve(s)); });
  console.log('[http] ' + cfg.appName + ' is on port ' + cfg.port + (cfg.baseUrl ? ', public address ' + cfg.baseUrl : ''));
  bot.setup();
  const stop = async () => { hub.closeAll(); server.close(); await db.close(); };
  return { app, server, stop };
}

if (require.main === module) {
  start().then(({ stop }) => {
    const bye = () => stop().finally(() => process.exit(0));
    process.on('SIGTERM', bye); process.on('SIGINT', bye);
  }).catch((e) => { console.error('[fatal]', e.message); process.exit(1); });
}

module.exports = { start, build, seedIfEmpty };
