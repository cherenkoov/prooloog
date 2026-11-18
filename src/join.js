'use strict';
// Onboarding: a person opens a link from the bot, fills in a form inside Telegram and ends up attached
// to one project. Their answers are kept for the owner, they become a contact of the project, and they
// get access to that project alone. A form may carry small polls ("which time suits you").
const fs = require('fs');
const path = require('path');
const express = require('express');
const cfg = require('./config');
const db = require('./db');
const auth = require('./auth');
const hub = require('./realtime');
const T = require('./telegram');

const FORMS = path.join(__dirname, '..', 'forms');
const TOKEN_RE = /^[A-Za-z0-9_-]{12,40}$/;
const OTHER = 'Другое';
const cache = {};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const https = () => /^https:\/\//.test(cfg.baseUrl);
const say = (chat, html, markup) => T.tg('sendMessage', { chat_id: chat, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup });
const appBtn = (text, p) => (https() ? { inline_keyboard: [[{ text, web_app: { url: cfg.baseUrl + p } }]] } : undefined);

/* ---------- forms ---------- */
function form(id) {
  if (!/^[a-z0-9-]{1,40}$/.test(String(id || ''))) return null;
  if (cache[id] && process.env.NODE_ENV !== 'development') return cache[id];
  try { cache[id] = JSON.parse(fs.readFileSync(path.join(FORMS, id + '.json'), 'utf8')); } catch (e) { return null; }
  return cache[id];
}
function forms() {
  try { return fs.readdirSync(FORMS).filter((f) => /^[a-z0-9-]+\.json$/.test(f)).map((f) => form(f.slice(0, -5))).filter(Boolean); } catch (e) { return []; }
}
const questions = (f, part) => f.steps.filter((s) => !part || s.part === part).reduce((a, s) => a.concat(s.qs), []);

const okChoice = (q, v) => typeof v === 'string' && (q.opts.includes(v) || (!!q.other && (v === OTHER || (v.startsWith(OTHER + ': ') && v.length <= 220))));
// Takes what the page sent and keeps only valid answers of this part. errors lists the questions to fix.
function clean(f, part, input) {
  const answers = {}, errors = [], src = input && typeof input === 'object' ? input : {};
  for (const q of questions(f, part)) {
    let v = src[q.id];
    if (q.t === 'many') {
      v = Array.isArray(v) ? [...new Set(v.filter((x) => okChoice(q, x)))] : [];
      if ((q.req && !v.length) || (q.max && v.length > q.max)) errors.push(q.id);
      else if (v.length) answers[q.id] = v;
    } else if (q.t === 'one') {
      if (okChoice(q, v)) answers[q.id] = v;
      else if (q.req) errors.push(q.id);
    } else {
      v = typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, q.t === 'area' ? 2000 : 200) : '';
      const bad = v && ((q.t === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) || (q.t === 'tel' && v.replace(/\D/g, '').length < 5));
      if (bad || (q.req && !v)) errors.push(q.id);
      else if (v) answers[q.id] = v;
    }
  }
  return { answers, errors };
}
const flat = (v) => (Array.isArray(v) ? v.join('; ') : String(v == null ? '' : v));

/* ---------- storage ---------- */
const docId = (f, tgId) => (f.id + '-' + tgId).slice(0, 64);
// in the order people came
async function entries(f) { return (await db.listDocs('joins')).filter((d) => d.data.form === f.id).sort((a, b) => String(a.data.at || '').localeCompare(String(b.data.at || ''))); }

function tally(f, list, myId) {
  return (f.polls || []).map((p) => {
    const mine = [];
    const opts = p.opts.map((o) => {
      const who = list.filter((d) => ((d.data.votes || {})[p.id] || []).includes(o));
      if (who.some((d) => d.data.tg === String(myId))) mine.push(o);
      return { t: o, n: who.length, who: who.map((d) => d.data.name || (d.data.username ? '@' + d.data.username : 'Участник')) };
    });
    return { id: p.id, title: p.title, q: p.q, multi: !!p.multi, opts, mine, voters: list.filter((d) => ((d.data.votes || {})[p.id] || []).length).length };
  });
}

function summaryLines(f, a) {
  const by = {}; questions(f).forEach((q) => { by[q.id] = q; });
  return (f.summary || []).filter((id) => by[id] && a[id] !== undefined).map((id) => (by[id].s || by[id].label) + ': ' + flat(a[id]));
}

// The person becomes a contact of the project: found by Telegram name, otherwise a new one.
async function saveContact(f, link, user, a) {
  const uname = String(user.username || '').toLowerCase(), id0 = 'jn-' + user.id;
  const all = await db.listDocs('contacts');
  const cur = all.find((c) => c.id === id0) || (uname ? all.find((c) => String(c.data.tg || '').replace(/^@/, '').toLowerCase() === uname) : null);
  const mark = 'Анкета «' + f.title + '»', block = mark + ', ' + new Date().toISOString().slice(0, 10) + '\n' + summaryLines(f, a).join('\n');
  const old = cur ? cur.data : {}, notes = String(old.notes || ''), at = notes.indexOf(mark);
  const data = Object.assign({ rel: '' }, old, {
    name: old.name || flat(a['1.1']) || auth.fullName(user) || 'Без имени',
    role: old.role || flat(a['2.1']).slice(0, 80),
    tg: old.tg || (user.username ? '@' + user.username : ''),
    phone: old.phone || flat(a['1.2']), email: old.email || flat(a['1.3']),
    projects: [...new Set((Array.isArray(old.projects) ? old.projects : []).concat([link.project]))],
    notes: ((at >= 0 ? notes.slice(0, at) : notes ? notes + '\n\n' : '') + block).slice(0, 4000),
    u: new Date().toISOString(),
  });
  const d = await db.setDoc('contacts', cur ? cur.id : id0, data);
  hub.publish('contacts', d.id, d.data, d.version, '', cur && cur.data);
  return d.id;
}

// Access to this one project, with editing. Whoever already has access keeps it; the project lists add up.
async function grant(user, project) {
  const id = String(user.id), cur = await db.getMember(id);
  const list = cur && !Array.isArray(cur.projects) ? null : [...new Set((cur ? cur.projects : []).concat([project]))];
  await db.upsertMember(id, user.username || '', auth.fullName(user), 'editor');
  await db.setMemberAccess(id, 'editor', list);
  hub.setAccess(id, 'editor', list);
}

/* ---------- API ---------- */
function router(botName) {
  const r = express.Router();
  const ctx = async (req, res, needUser) => {
    const link = TOKEN_RE.test(req.params.token) ? await db.getJoinLink(req.params.token) : null;
    const f = link && form(link.form), p = link && await db.getDoc('projects', link.project);
    if (!f || !p) { res.status(404).json({ error: 'link_closed' }); return null; }
    const user = needUser ? auth.checkInitData(req.body && req.body.initData) : null;
    if (needUser && !user) { res.status(401).json({ error: 'unauthorized' }); return null; }
    return { link, f, p, user, owner: !!user && String(user.id) === await auth.ownerId() };
  };
  const state = async (c) => {
    const list = await entries(c.f), mine = list.find((d) => d.data.tg === String(c.user.id));
    return {
      user: { name: auth.fullName(c.user), username: c.user.username || '' }, owner: c.owner,
      joined: !!(mine && mine.data.core), more: !!(mine && mine.data.more), answers: mine ? mine.data.answers || {} : {},
      people: list.filter((d) => d.data.core).length, polls: tally(c.f, list, c.user.id),
    };
  };

  r.get('/:token', async (req, res) => {
    const c = await ctx(req, res, false); if (!c) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ form: c.f, project: String(c.p.data.name || ''), app: cfg.appName, bot: botName() });
  });
  r.post('/:token/me', async (req, res) => {
    const c = await ctx(req, res, true); if (!c) return;
    res.json(await state(c));
  });
  r.post('/:token/submit', async (req, res) => {
    const c = await ctx(req, res, true); if (!c) return;
    const part = req.body.part === 'more' ? 'more' : 'core';
    const { answers, errors } = clean(c.f, part, req.body.answers);
    if (errors.length) return res.status(400).json({ error: 'bad_answers', fields: errors });
    const id = docId(c.f, c.user.id), had = await db.getDoc('joins', id);
    if (part === 'more' && !(had && had.data.core)) return res.status(409).json({ error: 'core_first' });
    const now = new Date().toISOString();
    const d = await db.mutateDoc('joins', id, (cur) => {
      // answers of the other part stay; this part is replaced whole, so a cleared answer is cleared
      const keep = {}; questions(c.f, part === 'core' ? 'more' : 'core').forEach((q) => { if (cur.answers && cur.answers[q.id] !== undefined) keep[q.id] = cur.answers[q.id]; });
      return Object.assign({}, cur, {
        form: c.f.id, project: c.link.project, tg: String(c.user.id), username: c.user.username || '', name: auth.fullName(c.user),
        answers: Object.assign(keep, answers), core: true, more: part === 'more' ? true : !!cur.more, at: cur.at || now, u: now,
      });
    });
    if (part === 'core') {
      if (!c.owner) await grant(c.user, c.link.project);
      await saveContact(c.f, c.link, c.user, d.data.answers);
      if (!(had && had.data.core)) await welcome(c, d.data.answers).catch((e) => console.error('[join] notify failed:', e.message));
    } else if (!(had && had.data.more)) {
      const owner = await auth.ownerId();
      if (owner && !c.owner) await say(owner, esc(auth.fullName(c.user) || 'Участник') + ' дополняет расширенную анкету «' + esc(c.f.title) + '». Все ответы: /answers').catch(() => {});
    }
    res.json(Object.assign({ ok: true }, await state(c)));
  });
  r.post('/:token/vote', async (req, res) => {
    const c = await ctx(req, res, true); if (!c) return;
    const poll = (c.f.polls || []).find((p) => p.id === req.body.poll);
    if (!poll || !Array.isArray(req.body.picks)) return res.status(400).json({ error: 'bad_request' });
    let picks = poll.opts.filter((o) => req.body.picks.includes(o));
    if (!poll.multi) picks = picks.slice(0, 1);
    const id = docId(c.f, c.user.id), had = await db.getDoc('joins', id);
    // the form comes first; the owner may vote without it
    if (!c.owner && !(had && had.data.core)) return res.status(409).json({ error: 'core_first' });
    const now = new Date().toISOString();
    await db.mutateDoc('joins', id, (cur) => Object.assign({ form: c.f.id, project: c.link.project, tg: String(c.user.id), answers: {}, at: now }, cur, {
      username: c.user.username || '', name: auth.fullName(c.user), votes: Object.assign({}, cur.votes, { [poll.id]: picks }), u: now,
    }));
    res.json(Object.assign({ ok: true }, await state(c)));
  });
  return r;
}

// First time through the form: a word to the person and a word to the owner.
async function welcome(c, a) {
  const name = auth.fullName(c.user) || 'Участник', pn = String(c.p.data.name || 'проект');
  if (!c.owner) {
    if (https()) await T.tg('setChatMenuButton', { chat_id: c.user.id, menu_button: { type: 'web_app', text: cfg.appName, web_app: { url: cfg.baseUrl + '/' } } }).catch(() => {});
    await say(c.user.id, 'Анкета принята, вы в проекте <b>' + esc(pn) + '</b>. Проект открывается кнопкой ниже: там задачи, майлстоуны и комментарии команды.', appBtn('Открыть ' + cfg.appName, '/')).catch(() => {});
  }
  const owner = await auth.ownerId();
  if (owner && !c.owner) {
    await say(owner, '<b>' + esc(name) + '</b>' + (c.user.username ? ' (@' + esc(c.user.username) + ')' : '') + ' заполнил(а) анкету «' + esc(c.f.title) + '» и теперь в проекте <b>' + esc(pn) + '</b>: видит только его, может вести задачи.\n\n' +
      esc(summaryLines(c.f, a).join('\n')) + '\n\nКонтакт создан в проекте. Все ответы: /answers, голоса: /votes', appBtn('Открыть ' + cfg.appName, '/'));
  }
}

/* ---------- the bot's side ---------- */
// «/start join_<token>»: anyone may come in by this link.
async function start(m, token) {
  const link = TOKEN_RE.test(token) ? await db.getJoinLink(token) : null;
  const f = link && form(link.form), p = link && await db.getDoc('projects', link.project);
  if (!f || !p) return say(m.chat.id, 'Эта ссылка больше не действует. Попросите у организатора новую.');
  const polls = (f.polls || []).map((x) => x.title).join(', ');
  return say(m.chat.id, '<b>' + esc(f.title) + '</b>\n' + esc(f.kicker || 'Анкета') + '\n\nОсновная часть занимает ' + esc(f.coreTime || 'пару минут') + ': вопросы с вариантами ответа, прямо здесь, в Telegram. После неё вы сразу окажетесь в проекте «' + esc(String(p.data.name || '')) + '»' +
    (polls ? ' и сможете проголосовать: ' + esc(polls) : '') + '.' + (https() ? '' : '\n\nУ сервера пока нет публичного адреса, анкету открыть нельзя.'), appBtn('Заполнить анкету', '/join/' + token));
}
const url = (botName, token) => 'https://t.me/' + botName + '?start=join_' + token;
// The owner's link for a project: the same one every time, until it is switched off.
async function linkFor(project, formId) {
  const cur = (await db.listJoinLinks()).find((l) => l.project === project && l.form === formId);
  return cur ? cur.token : db.createJoinLink(project, formId);
}
async function votesText() {
  const out = [];
  for (const f of forms()) {
    const list = await entries(f);
    tally(f, list, '').forEach((p) => {
      out.push('<b>' + esc(p.title) + '</b> · проголосовали: ' + p.voters);
      p.opts.forEach((o) => out.push(esc(o.t) + ' — ' + o.n + (o.who.length ? ': ' + esc(o.who.join(', ')) : '')));
      out.push('');
    });
  }
  return out.join('\n').trim() || 'Голосований пока нет.';
}
// Every answer as a table: one row per person, opens in Excel and Google Sheets.
async function csv(f) {
  const qs = questions(f), polls = f.polls || [], cell = (v) => '"' + flat(v).replace(/"/g, '""') + '"';
  const rows = [['Дата', 'Имя в Telegram', 'Telegram'].concat(qs.map((q) => q.id + ' ' + q.label), polls.map((p) => p.title)).map(cell).join(',')];
  const list = (await entries(f)).sort((a, b) => String(a.data.at || '').localeCompare(String(b.data.at || '')));
  for (const d of list) {
    const x = d.data, a = x.answers || {};
    rows.push([String(x.at || '').slice(0, 10), x.name || '', x.username ? '@' + x.username : ''].concat(qs.map((q) => a[q.id]), polls.map((p) => (x.votes || {})[p.id])).map(cell).join(','));
  }
  return { n: list.length, body: Buffer.from('﻿' + rows.join('\r\n'), 'utf8') };
}

module.exports = { router, start, url, linkFor, votesText, csv, form, forms, clean, entries, tally };
