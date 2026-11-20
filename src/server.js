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
const mcp = require('./mcp');
const remind = require('./remind');
const groups = require('./groups');
const journal = require('./journal');
const asks = require('./session');
const calls = require('./calls');
const google = require('./google');
const T = require('./telegram');
const join = require('./join');
const avatar = require('./avatar');

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
  // the owner's collections: a coordinator gets some of them, cut down to their projects
  if (cfg.ownerOnly.has(coll) && req.user.role !== 'owner' && !(req.user.role === 'manager' && cfg.managed.has(coll))) { res.status(403).json({ error: 'forbidden' }); return null; }
  if (write && req.user.role === 'viewer') { res.status(403).json({ error: 'forbidden' }); return null; }
  if (write && coll === 'audit') { res.status(403).json({ error: 'forbidden' }); return null; } // the journal is written by the server only
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
  // The onboarding page: a form that ends with the person attached to a project.
  app.get('/join/:token', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(path.join(PUBLIC, 'join.html')); });
  // The same page as a preview inside the dashboard: it asks /api/onboard/:project/preview and saves nothing.
  app.get('/preview/:project', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(path.join(PUBLIC, 'join.html')); });
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

  /* ---------- connector for Claude ---------- */
  const mcpJson = express.json({ limit: '30mb' });
  const mcpLimit = limiter(240, 60000);
  app.post(['/mcp/:token', '/mcp'], mcpLimit, mcpJson, (req, res, next) => mcp.handle(req, res).catch(next));
  app.all(['/mcp/:token', '/mcp'], (req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Use POST' } }));

  /* ---------- API ---------- */
  const api = express.Router();
  const json = express.json({ limit: '400kb' });
  const authLimit = limiter(Math.max(1, +process.env.AUTH_LIMIT || 30), 60000); // sign-in attempts from one address
  const actLimit = limiter(60, 60000);                                         // the owner's actions that reach Telegram

  const session = async (user, role) => (avatar.soon(user.id), { // the person's Telegram photo, without waiting for it
    token: auth.signSession(user.id), role, user: await auth.profileOf(String(user.id), role),
    caps: { ai: ai.enabled(), files: true }, app: { name: cfg.appName, bot: bot.name(), readsAll: bot.readsAll(), zoom: calls.zoomOn(), meet: await google.on() }, ownerOnly: [...cfg.ownerOnly], managed: [...cfg.managed],
    projects: role === 'owner' ? null : await auth.scopeOf(user.id),
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
    res.json({ role: req.user.role, user: await auth.profileOf(req.user.id, req.user.role), caps: { ai: ai.enabled(), files: true }, app: { name: cfg.appName, bot: bot.name(), readsAll: bot.readsAll(), zoom: calls.zoomOn(), meet: await google.on() }, ownerOnly: [...cfg.ownerOnly], managed: [...cfg.managed], projects: req.user.projects });
    bot.maybeBackup();
  });

  api.get('/db/:coll', auth.guard(), async (req, res) => {
    const coll = collOf(req, res, false); if (!coll) return;
    res.setHeader('Cache-Control', 'no-store');
    const docs = await db.listDocs(coll), sc = req.user.projects;
    res.json({ docs: sc ? docs.map((d) => ({ id: d.id, version: d.version, data: auth.view(sc, coll, d.id, d.data) })).filter((d) => d.data) : docs });
  });
  // A member with a project list writes only inside those projects and cannot add or remove projects.
  // cur is the record now (or null), next is what it becomes (null for a deletion).
  const mayWrite = (req, res, coll, id, cur, next) => {
    const sc = req.user.projects;
    if (!sc) return true;
    const bad = coll === 'settings' || (coll === 'projects' ? !cur || !sc.includes(id) || next === null
      : (cur && !auth.sees(sc, coll, id, cur.data)) || (next !== null && !auth.sees(sc, coll, id, next)));
    if (bad) res.status(403).json({ error: 'forbidden' });
    return !bad;
  };
  // who is behind a request, for the journal: '' for the owner, a name for anybody else
  const names = new Map();
  const who = async (req) => {
    if (req.user.role === 'owner') return '';
    const hit = names.get(req.user.id);
    if (hit && Date.now() - hit.at < 60000) return hit.name;
    const m = await db.getMember(req.user.id), name = (m && (m.name || (m.username ? '@' + m.username : ''))) || 'гость';
    names.set(req.user.id, { name, at: Date.now() });
    return name;
  };
  api.put('/db/:coll/:id', auth.guard('write'), json, async (req, res) => {
    const coll = collOf(req, res, true); if (!coll) return;
    if (!ID_RE.test(req.params.id) || !isObj(req.body && req.body.data)) return res.status(400).json({ error: 'bad_request' });
    const cur = await db.getDoc(coll, req.params.id);
    const data = coll === 'contacts' && req.user.projects ? auth.cardWrite(req.user.projects, cur && cur.data, req.body.data) : req.body.data;
    if (!mayWrite(req, res, coll, req.params.id, cur, data)) return;
    const d = await db.setDoc(coll, req.params.id, data);
    hub.publish(coll, d.id, d.data, d.version, srcOf(req), cur && cur.data);
    journal.note(cur ? 'upd' : 'add', coll, d.id, d.data, cur && cur.data, await who(req));
    if (coll === 'events') await calls.ensure(d.id).catch((e) => console.error('[calls]', e.message));
    if (coll === 'chats') await groups.onSettings(cur && cur.data, d).catch((e) => console.error('[chats]', e.message));
    res.json({ ok: true, version: d.version });
  });
  api.patch('/db/:coll/:id', auth.guard('write'), json, async (req, res) => {
    const coll = collOf(req, res, true); if (!coll) return;
    if (!ID_RE.test(req.params.id) || !isObj(req.body && req.body.data)) return res.status(400).json({ error: 'bad_request' });
    const cur = await db.getDoc(coll, req.params.id);
    const card = coll === 'contacts' && req.user.projects && cur ? auth.cardWrite(req.user.projects, cur.data, Object.assign({}, cur.data, req.body.data)) : null;
    if (!mayWrite(req, res, coll, req.params.id, cur, card || Object.assign({}, cur ? cur.data : {}, req.body.data))) return;
    const d = card ? await db.setDoc(coll, req.params.id, card) : await db.updateDoc(coll, req.params.id, req.body.data);
    if (!d) return res.status(404).json({ error: 'not_found' });
    hub.publish(coll, d.id, d.data, d.version, srcOf(req), cur && cur.data);
    journal.note('upd', coll, d.id, d.data, cur && cur.data, await who(req));
    if (coll === 'events') await calls.ensure(d.id).catch((e) => console.error('[calls]', e.message));
    if (coll === 'chats') await groups.onSettings(cur && cur.data, d).catch((e) => console.error('[chats]', e.message));
    res.json({ ok: true, version: d.version });
  });
  api.delete('/db/:coll/:id', auth.guard('write'), async (req, res) => {
    const coll = collOf(req, res, true); if (!coll) return;
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'bad_request' });
    const cur = await db.getDoc(coll, req.params.id);
    if (!mayWrite(req, res, coll, req.params.id, cur, null)) return;
    // a card that also belongs to projects outside the coordinator's list is not theirs to delete
    if (coll === 'contacts' && req.user.projects && cur && auth.cardProjects(cur.data).some((p) => !req.user.projects.includes(p))) return res.status(403).json({ error: 'forbidden' });
    const was = await db.deleteDoc(coll, req.params.id);
    hub.publish(coll, req.params.id, null, 0, srcOf(req), cur && cur.data);
    if (was) journal.note('del', coll, req.params.id, null, cur && cur.data, await who(req));
    // A deletion leaves a mark: when two copies of the data are merged, the record does not come back.
    if (was && coll !== 'gone' && coll !== 'activity') {
      const at = new Date().toISOString();
      const g = await db.setDoc('gone', (coll + '-' + req.params.id).slice(0, 64), { c: coll, i: req.params.id, at, u: at });
      hub.publish('gone', g.id, g.data, g.version, srcOf(req));
    }
    res.json({ ok: true });
  });

  api.get('/stream', auth.guard(), (req, res) => hub.attach(req, res, req.user));

  /* ---------- sharing: who has access, invite links ---------- */
  // by: who asks. Only the owner makes a coordinator, and a coordinator always has a list of projects.
  // A coordinator gives and changes the two lower levels, inside their own projects.
  const cleanAccess = async (b, by) => {
    const want = b && b.role, mine = by.role === 'manager' ? by.projects : null;
    const role = want === 'manager' && by.role === 'owner' ? 'manager' : want === 'editor' ? 'editor' : want === 'manager' ? null : 'viewer';
    if (!role) return null;
    if (!b || b.projects === null || b.projects === undefined || b.projects === '*') return role === 'manager' || mine ? null : { role, projects: null };
    if (!Array.isArray(b.projects)) return null;
    const known = new Set((await db.listDocs('projects')).map((p) => p.id));
    const list = [...new Set(b.projects.filter((x) => typeof x === 'string' && known.has(x)))];
    if (mine && list.some((p) => !mine.includes(p))) return null;
    return list.length ? { role, projects: list } : null;
  };
  const LEVEL = { manager: 'координатор', editor: 'редактирует', viewer: 'смотрит' };
  const inside = (list, mine) => Array.isArray(list) && list.length > 0 && list.every((p) => mine.includes(p));
  // May this person change or close the access of the member? The owner: anybody's. A coordinator: an editor or
  // a viewer whose projects are all the coordinator's own; never another coordinator, never themselves.
  const mayTouch = (by, m) => by.role === 'owner' || (!!m && String(m.id) !== String(by.id) && auth.memberRole(m.role, m.projects) !== 'manager' && inside(m.projects, by.projects));
  api.get('/share', auth.guard('manage'), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const mine = req.user.role === 'owner' ? null : req.user.projects;
    const cut = (list) => (mine && Array.isArray(list) ? list.filter((p) => mine.includes(p)) : Array.isArray(list) ? list : null);
    const members = (await db.listMembers()).filter((m) => !mine || (Array.isArray(m.projects) && m.projects.some((p) => mine.includes(p))));
    const photos = await Promise.all(members.map((m) => avatar.urlOf(m.id)));
    res.json({
      bot: bot.name(),
      // fixed: this person's access is not for the asker to change
      members: members.map((m, i) => ({ id: m.id, name: m.name, username: m.username, role: auth.memberRole(m.role, m.projects), projects: cut(m.projects), photo: photos[i], fixed: !mayTouch(req.user, m) })),
      links: (await db.listInviteLinks()).filter((l) => !mine || inside(l.projects, mine)).map((l) => ({ token: l.token, role: l.role, projects: Array.isArray(l.projects) ? l.projects : null, expires: l.expires_at, url: bot.name() ? 'https://t.me/' + bot.name() + '?start=inv_' + l.token : '' })),
      // invited through the bot by name (/invite @name), have not come in yet: all projects
      names: mine ? [] : (await db.listInvites()).map((x) => ({ username: x.username, role: x.role === 'editor' ? 'editor' : 'viewer' })),
    });
  });
  api.post('/share/links', auth.guard('manage'), actLimit, json, async (req, res) => {
    // a link makes an editor or a viewer; a coordinator is named by the owner, person by person
    const a = req.body && req.body.role === 'manager' ? null : await cleanAccess(req.body, req.user);
    if (!a) return res.status(400).json({ error: 'bad_request' });
    if (!bot.name()) return res.status(409).json({ error: 'no_bot' });
    const token = await db.createInviteLink(a.role, a.projects, 7);
    journal.event('acc', 'Создана ссылка-приглашение: ' + (a.role === 'editor' ? 'редактировать' : 'смотреть') + ', ' + (a.projects ? 'проектов: ' + a.projects.length : 'все проекты'), await who(req));
    res.json({ token, url: 'https://t.me/' + bot.name() + '?start=inv_' + token, role: a.role, projects: a.projects });
  });
  api.delete('/share/links/:token', auth.guard('manage'), async (req, res) => {
    if (req.user.role !== 'owner') {
      const l = (await db.listInviteLinks()).find((x) => x.token === String(req.params.token));
      if (!l || !inside(l.projects, req.user.projects)) return res.status(403).json({ error: 'forbidden' });
    }
    res.json({ ok: await db.dropInviteLink(String(req.params.token)) });
  });
  api.delete('/share/names/:username', auth.guard('owner'), async (req, res) => { res.json({ ok: (await db.removeInvite(String(req.params.username).toLowerCase())) > 0 }); });
  api.patch('/share/members/:id', auth.guard('manage'), json, async (req, res) => {
    const a = await cleanAccess(req.body, req.user);
    if (!a || !/^\d{1,20}$/.test(req.params.id)) return res.status(400).json({ error: 'bad_request' });
    const was = await db.getMember(req.params.id);
    if (was && !mayTouch(req.user, was)) return res.status(403).json({ error: 'forbidden' });
    const ok = await db.setMemberAccess(req.params.id, a.role, a.projects);
    if (ok) hub.setAccess(req.params.id, a.role, a.projects);
    if (ok) { const m = await db.getMember(req.params.id); journal.event('acc', 'Доступ изменён: ' + ((m && (m.name || m.username)) || req.params.id) + ' — ' + LEVEL[a.role] + ', ' + (a.projects ? 'проектов: ' + a.projects.length : 'все проекты'), await who(req)); }
    // a new coordinator hears it from the bot: the dashboard now shows them more
    if (ok && a.role === 'manager' && auth.memberRole(was.role, was.projects) !== 'manager') {
      const names = (await db.listDocs('projects')).filter((p) => a.projects.includes(p.id)).map((p) => String(p.data.name || '')).join(', ');
      await T.tg('sendMessage', { chat_id: req.params.id, text: 'Ты теперь координатор: ' + names + '. В дэшборде открылись деньги, контакты и анкеты, переписка, онбординг и доступ этого проекта.' }).catch(() => {});
    }
    res.status(ok ? 200 : 404).json({ ok });
  });
  // The chat with a person who has no name in Telegram: the bot sends the asker a message where the person's
  // name is a link to their profile. Telegram opens a person by id only from such a message.
  api.post('/share/members/:id/chat', auth.guard('manage'), actLimit, async (req, res) => {
    if (!/^\d{1,20}$/.test(req.params.id)) return res.status(400).json({ error: 'bad_request' });
    const m = await db.getMember(req.params.id);
    if (!m || (req.user.role !== 'owner' && !(Array.isArray(m.projects) && m.projects.some((p) => req.user.projects.includes(p))))) return res.status(404).json({ error: 'not_found' });
    const name = String(m.name || (m.username ? '@' + m.username : '') || 'Без имени').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    try {
      await T.tg('sendMessage', { chat_id: req.user.id, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, text: 'Чат с человеком: <a href="tg://user?id=' + req.params.id + '">' + name + '</a>\nНажми на имя: откроется профиль, оттуда можно написать.' });
    } catch (e) { return res.status(502).json({ error: 'bot_unavailable' }); }
    res.json({ ok: true });
  });
  api.delete('/share/members/:id', auth.guard('manage'), async (req, res) => {
    if (!/^\d{1,20}$/.test(req.params.id)) return res.status(400).json({ error: 'bad_request' });
    const gone = await db.getMember(req.params.id);
    if (gone && !mayTouch(req.user, gone)) return res.status(403).json({ error: 'forbidden' });
    const ok = await db.removeMember(req.params.id);
    if (ok) hub.dropUser(req.params.id);
    if (ok) journal.event('acc', 'Доступ закрыт: ' + ((gone && (gone.name || gone.username)) || req.params.id), await who(req));
    res.json({ ok });
  });

  // Pictures for service cards. Stored in the database: the server's own disk is wiped on every deploy.
  /* ---------- work chats: the owner writes through the bot, or takes the bot out ---------- */
  const chatCall = (fn) => async (req, res) => {
    if (!/^g\d{1,20}$/.test(req.params.id)) return res.status(400).json({ error: 'bad_request' });
    if (req.user.role !== 'owner') { // a coordinator: the chats of their projects
      const ch = await db.getDoc('chats', req.params.id);
      if (!ch || !auth.manages(req.user, ch.data.project)) return res.status(404).json({ error: 'no_chat' });
    }
    try { await fn(req); res.json({ ok: true }); } catch (e) {
      if (e.code === 'no_chat') return res.status(404).json({ error: 'no_chat' });
      if (e.code === 'bad_request') return res.status(400).json({ error: 'bad_request' });
      console.error('[chats]', e.message);
      res.status(502).json({ error: 'not_sent' });
    }
  };
  api.post('/chats/:id/post', auth.guard('manage'), actLimit, json, chatCall((req) => groups.post(req.params.id, req.body && req.body.text, !!(req.body && req.body.buttons))));
  api.post('/chats/:id/leave', auth.guard('manage'), actLimit, chatCall((req) => groups.leave(req.params.id)));

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
    const n = await db.importAll(b.docs, cfg.allCollections, b.mode === 'replace');
    await join.loadEdits();
    journal.event('bulk', (b.mode === 'replace' ? 'Данные заменены копией' : 'Загружена копия') + ': записей ' + n);
    hub.reloadAll();
    res.json({ ok: true, imported: n });
  });

  // «Скачать файлом» inside Telegram: the bot sends the copy to the owner's chat.
  api.post('/backup/send', auth.guard('owner'), actLimit, async (req, res) => {
    try { await bot.sendBackup(req.user.id, true); } catch (e) { return res.status(502).json({ error: 'bot_unavailable' }); }
    res.json({ ok: true });
  });

  // Voice messages the bot has saved: played in the dashboard straight from Telegram.
  api.get('/tg/file/:fileId', auth.guard('manage'), async (req, res) => {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(req.params.fileId)) return res.status(400).end();
    // a coordinator plays only what is attached to a message of their projects
    if (req.user.role !== 'owner' && !(await db.listDocs('messages')).some((m) => m.data.file && m.data.file.tg === req.params.fileId && auth.manages(req.user, m.data.project))) return res.status(404).end();
    let f;
    try { f = await T.openFile(req.params.fileId); } catch (e) { return res.status(404).end(); }
    const ext = path.extname(f.path).toLowerCase();
    res.setHeader('Content-Type', { '.oga': 'audio/ogg', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav' }[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(Buffer.from(await f.res.arrayBuffer()));
  });

  api.post('/ai', auth.guard('write'), json, (req, res) => ai.handle(req, res));

  api.use('/join', limiter(120, 60000), json, join.router(() => bot.name()));

  // Google sends the owner back here after the sign-in that /google started. The one-time state in the link
  // is the proof that it is the owner; the page only says how it went, the rest is told by the bot.
  api.get('/google/callback', limiter(20, 60000), async (req, res) => {
    const page = (title, text) => res.status(200).type('html').send('<!DOCTYPE html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>' + title + '</title>' +
      '<body style="font:16px/1.5 system-ui,sans-serif;max-width:420px;margin:18vh auto;padding:0 20px;color:#14161c"><h1 style="font-size:22px">' + title + '</h1><p>' + text + '</p></body></html>');
    if (!google.configured()) return page('Google не настроен', 'На сервере нет ключей Google.');
    if (req.query.error) return page('Вход отменён', 'Google не дал доступ. Напишите боту /google и попробуйте ещё раз.');
    const bad = await google.finish(String(req.query.code || ''), String(req.query.state || ''));
    if (bad) return page('Не получилось', bad.replace(/[&<>]/g, ''));
    await bot.googleConnected().catch((e) => console.error('[google]', e.message));
    page('Google подключён', 'Комнаты Google Meet теперь создаются сами. Это окно можно закрыть: подробности прислал бот.');
  });

  /* ---------- onboarding of a project: the owner's view in the dashboard ---------- */
  const obProject = async (req, res) => {
    const id = String(req.params.project || ''), p = ID_RE.test(id) ? await db.getDoc('projects', id) : null;
    if (!p) { res.status(404).json({ error: 'no_project' }); return null; }
    if (!auth.manages(req.user, p.id)) { res.status(403).json({ error: 'forbidden' }); return null; }
    return p;
  };
  // A form is one for every project that uses it. The owner changes it freely; a coordinator only while no project
  // outside their own uses it.
  const mayEditForm = async (user, f) => user.role === 'owner' || (await join.formProjects(f.id)).every((x) => user.projects.includes(x));
  const obView = async (req, res, p) => { res.setHeader('Cache-Control', 'no-store'); res.json(await join.overview(p.id, bot.name())); };
  api.get('/onboard/:project', auth.guard('manage'), async (req, res) => { const p = await obProject(req, res); if (p) await obView(req, res, p); });
  api.post('/onboard/:project', auth.guard('manage'), actLimit, json, async (req, res) => {
    const p = await obProject(req, res); if (!p) return;
    // {form: "invite"} is the invitation of the project; a form id picks that form; nothing is the team form
    const want = req.body && req.body.form;
    const f = want === 'invite' ? join.cardForm() : join.form(want) || join.teamForm();
    if (!f) return res.status(409).json({ error: 'no_form' });
    if (!bot.name()) return res.status(409).json({ error: 'no_bot' });
    const had = (await db.listJoinLinks()).some((l) => l.project === p.id && l.form === f.id);
    await join.linkFor(p.id, f.id);
    if (!had) journal.event('acc', (join.isCard(f) ? 'Приглашение включено' : 'Онбординг включён') + ': проект «' + String(p.data.name || '') + '», анкета «' + f.title + '»', await who(req));
    await obView(req, res, p);
  });
  api.delete('/onboard/:project', auth.guard('manage'), async (req, res) => {
    const p = await obProject(req, res); if (!p) return;
    // ?form=invite switches off the invitation alone; without it, the team link alone
    const card = req.query.form === 'invite', ids = join.forms().filter((f) => join.isCard(f) === card).map((f) => f.id);
    if (await db.revokeJoinLinks(p.id, ids)) journal.event('acc', (card ? 'Приглашение выключено' : 'Онбординг выключен') + ': проект «' + String(p.data.name || '') + '»', await who(req));
    await obView(req, res, p);
  });
  // the form as a person will see it, before the link goes out: ?form=invite is the invitation, otherwise the team form
  api.get('/onboard/:project/preview', auth.guard('manage'), async (req, res) => {
    const p = await obProject(req, res); if (!p) return;
    const f = req.query.form === 'invite' ? join.cardForm() : join.teamForm();
    if (!f) return res.status(409).json({ error: 'no_form' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(await join.preview(f, p, bot.name(), await mayEditForm(req.user, f)));
  });
  // Changing a form from its preview: the wording, and the kind of input of a question. One change per call:
  // {target: 'form' | 'step' | 'q', id, set}. The answer is the preview again, with the change in.
  api.patch('/onboard/:project/form', auth.guard('manage'), actLimit, json, async (req, res) => {
    const p = await obProject(req, res); if (!p) return;
    const f = req.query.form === 'invite' ? join.cardForm() : join.teamForm();
    if (!f) return res.status(409).json({ error: 'no_form' });
    if (!(await mayEditForm(req.user, f))) return res.status(403).json({ error: 'shared_form' });
    const b = req.body || {}, r = await join.editForm(f.id, b.target, String(b.id || ''), b.set);
    if (r.error) return res.status(r.error === 'not_found' ? 404 : 400).json({ error: r.error });
    journal.event('bulk', 'Анкета «' + f.title + '» изменена: ' + r.what, await who(req));
    res.json(await join.preview(join.form(f.id), p, bot.name(), true));
  });
  // back to the form as it is written in its file
  api.delete('/onboard/:project/form', auth.guard('manage'), async (req, res) => {
    const p = await obProject(req, res); if (!p) return;
    const f = req.query.form === 'invite' ? join.cardForm() : join.teamForm();
    if (!f) return res.status(409).json({ error: 'no_form' });
    if (!(await mayEditForm(req.user, f))) return res.status(403).json({ error: 'shared_form' });
    if (await join.resetForm(f.id)) journal.event('bulk', 'Анкета «' + f.title + '» возвращена к исходному виду', await who(req));
    res.json(await join.preview(join.form(f.id), p, bot.name(), true));
  });
  // the invitation as a QR code, to show from the phone at a meeting
  api.get('/onboard/:project/qr', auth.guard('manage'), async (req, res) => {
    const p = await obProject(req, res); if (!p) return;
    const o = await join.overview(p.id, bot.name());
    if (!o.invite || !o.invite.link) return res.status(409).json({ error: 'no_link' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ url: o.invite.link.url, svg: await join.qrSvg(o.invite.link.url) });
  });
  // the table of answers goes to the owner's chat with the bot: a file is of little use inside Telegram's window
  api.post('/onboard/:project/csv', auth.guard('manage'), actLimit, async (req, res) => {
    const p = await obProject(req, res); if (!p) return;
    const o = await join.overview(p.id, bot.name()), card = req.query.form === 'invite';
    const f = card ? o.invite && join.form(o.invite.form.id) : o.form && join.form(o.form.id);
    if (!f || !(card ? o.invite.people : o.people).length) return res.status(409).json({ error: 'empty' });
    const t = await join.csv(f, p.id);
    try {
      await require('./telegram').sendDocument(req.user.id, 'answers-' + f.id + '-' + p.id + '.csv', t.body, 'Анкета «' + f.title + '», проект «' + String(p.data.name || '') + '»: ответов ' + t.n + '. Открывается в Excel и Google Таблицах.');
      res.json({ ok: true, n: t.n });
    } catch (e) { console.error('[onboard]', e.message); res.status(502).json({ error: 'not_sent' }); }
  });

  // all the answers of the project's onboarding as one file, csv or json. {send: true}: the bot sends it to the
  // owner's chat (inside Telegram a page cannot save files); otherwise the text comes back and the page saves it
  api.post('/onboard/:project/export', auth.guard('manage'), actLimit, json, async (req, res) => {
    const p = await obProject(req, res); if (!p) return;
    const fmt = req.body && req.body.format === 'json' ? 'json' : 'csv', x = await join.exportProject(p.id, fmt);
    if (!x.n) return res.status(409).json({ error: 'empty' });
    journal.event('acc', 'Выгрузка онбординга (' + fmt.toUpperCase() + '): проект «' + x.project + '», ответов ' + x.n, await who(req));
    if (!(req.body && req.body.send)) return res.json({ ok: true, n: x.n, filename: x.filename, text: x.body.toString('utf8') });
    try {
      await require('./telegram').sendDocument(req.user.id, x.filename, x.body, 'Онбординг проекта «' + x.project + '»: ответов ' + x.n + (fmt === 'csv' ? '. Открывается в Excel и Google Таблицах.' : ', формат JSON.'));
      res.json({ ok: true, n: x.n, sent: true });
    } catch (e) { console.error('[onboard]', e.message); res.status(502).json({ error: 'not_sent' }); }
  });

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
  const n = await db.importAll(j.docs || {}, cfg.allCollections, false);
  await db.kvSet('seeded', { at: new Date().toISOString(), docs: n });
  console.log('[seed] imported ' + n + ' records');
  return n;
}

async function start() {
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set');
  if (!cfg.sessionSecretFixed) console.warn('[auth] SESSION_SECRET is not set: sessions will not survive a restart');
  await db.init(cfg.databaseUrl);
  await seedIfEmpty();
  await join.loadEdits();
  await join.migrateTeam().then((n) => { if (n) console.log('[team] ' + n + ' cards got their team'); }).catch((e) => console.error('[team]', e.message));
  const app = build();
  const server = await new Promise((resolve) => { const s = app.listen(cfg.port, '0.0.0.0', () => resolve(s)); });
  console.log('[http] ' + cfg.appName + ' is on port ' + cfg.port + (cfg.baseUrl ? ', public address ' + cfg.baseUrl : ''));
  bot.setup();
  remind.use({ bot: () => bot.name() });
  asks.start();
  if (process.env.REMINDERS !== '0') remind.start();
  const stop = async () => { remind.stop(); asks.stop(); await journal.stop(); hub.closeAll(); server.close(); await db.close(); };
  return { app, server, stop };
}

if (require.main === module) {
  start().then(({ stop }) => {
    const bye = () => stop().finally(() => process.exit(0));
    process.on('SIGTERM', bye); process.on('SIGINT', bye);
  }).catch((e) => { console.error('[fatal]', e.message); process.exit(1); });
}

module.exports = { start, build, seedIfEmpty };
