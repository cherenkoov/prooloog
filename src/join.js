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
const clock = require('./clock');
const journal = require('./journal');
const calls = require('./calls');
const avatar = require('./avatar');

const FORMS = cfg.formsDir || path.join(__dirname, '..', 'forms');
const TOKEN_RE = /^[A-Za-z0-9_-]{12,40}$/;
const OTHER = 'Другое';
const cache = {};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const https = () => /^https:\/\//.test(cfg.baseUrl);
const say = (chat, html, markup) => T.tg('sendMessage', { chat_id: chat, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup });
const appBtn = (text, p) => (https() ? { inline_keyboard: [[{ text, web_app: { url: cfg.baseUrl + p } }]] } : undefined);

/* ---------- forms ---------- */
// the form as it was made: a project's own form from the database, or forms/<id>.json
function fileForm(id) {
  if (!/^[a-z0-9-]{1,40}$/.test(String(id || ''))) return null;
  if (own[id]) return own[id].def;
  if (cache[id] && process.env.NODE_ENV !== 'development') return cache[id];
  try { cache[id] = JSON.parse(fs.readFileSync(path.join(FORMS, id + '.json'), 'utf8')); } catch (e) { return null; }
  return cache[id];
}
// the form people get: the file with the edits made in the dashboard laid over it
function form(id) {
  const b = fileForm(id);
  if (!b || !edits[id]) return b;
  if (!merged[id] || process.env.NODE_ENV === 'development') merged[id] = applyEdits(b, edits[id]);
  return merged[id];
}

/* ---------- edits made in the dashboard ---------- */
// The owner or a coordinator changes a form in its preview: the wording and the kind of input of a question.
// The edits live in the database (collection `forms`, one record per form: {top, steps, qs}) and are laid over the
// file. Ids, the order and the conditions never change, so the answers already given still match their questions.
const edits = {}, merged = {};
// Every project has a form of its own. `own`: the forms made in the dashboard («Создать анкету»), id → {own, project,
// kind, def}. `bound`: the projects a file form already serves (a live link, answers), beside those its file names.
const own = {}, bound = {};
const TYPES = ['text', 'area', 'tel', 'email', 'url', 'one', 'many'];
const TOP = { kicker: 80, title: 80, intro: 600, moreIntro: 400, consent: 400, agree: 300 };
const isChoice = (t) => t === 'one' || t === 'many';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// other questions, steps or the «master» mark depend on the answer to this one
const feeds = (f, qid) => (!!f.master && f.master.q === qid) || f.steps.some((s) => (s.when && s.when.q === qid) || s.qs.some((q) => q.when && q.when.q === qid));
function applyEdits(base, e) {
  const f = JSON.parse(JSON.stringify(base));
  for (const k of Object.keys(TOP)) if (isObj(e.top) && typeof e.top[k] === 'string' && e.top[k]) f[k] = e.top[k];
  for (const s of f.steps) {
    const se = isObj(e.steps) && e.steps[s.id];
    if (se) { if (se.title) s.title = se.title; if (typeof se.text === 'string') { if (se.text) s.text = se.text; else delete s.text; } }
    for (const q of s.qs) {
      const o = isObj(e.qs) && e.qs[q.id];
      if (!o) continue;
      const was = Array.isArray(q.opts) ? q.opts.slice() : null, t0 = q.t;
      if (o.label) { q.label = o.label; if (q.auto) q.s = short(o.label); }
      for (const k of ['hint', 'ph']) if (typeof o[k] === 'string') { if (o[k]) q[k] = o[k]; else delete q[k]; }
      if (typeof o.req === 'boolean') { if (o.req) q.req = true; else delete q.req; }
      if (TYPES.includes(o.t)) q.t = o.t;
      if (isChoice(q.t)) {
        if (Array.isArray(o.opts) && o.opts.length >= 2) q.opts = o.opts.slice();
        if (typeof o.other === 'boolean') { if (o.other) q.other = true; else delete q.other; }
        if (q.t === 'many' && o.max !== undefined) { if (o.max > 0) q.max = o.max; else delete q.max; }
        if (q.t === 'one') { delete q.max; delete q.lead; }
        if (q.max && q.max > q.opts.length + (q.other ? 1 : 0)) delete q.max;
        if (q.fill === 'telegram' && !q.opts.includes('Telegram')) delete q.fill;
        delete q.ph;
      } else { for (const k of ['opts', 'other', 'max', 'lead', 'row']) delete q[k]; }
      if (q.t !== t0) { delete q.ac; if (q.fill && !(q.fill === 'telegram' && isChoice(q.t))) delete q.fill; }
      // an option that got a new wording: the conditions that name it follow
      if (was && Array.isArray(q.opts) && was.length === q.opts.length) {
        const ren = {}; was.forEach((x, i) => { if (x !== q.opts[i]) ren[x] = q.opts[i]; });
        if (Object.keys(ren).length) {
          const fix = (w) => { if (w && w.q === q.id && Array.isArray(w.in)) w.in = w.in.map((x) => (ren[x] !== undefined ? ren[x] : x)); };
          fix(f.master); f.steps.forEach((x) => { fix(x.when); x.qs.forEach((y) => fix(y.when)); });
        }
      }
    }
  }
  return f;
}
async function loadEdits() {
  for (const k of Object.keys(edits)) delete edits[k];
  for (const k of Object.keys(merged)) delete merged[k];
  for (const k of Object.keys(own)) delete own[k];
  for (const k of Object.keys(bound)) delete bound[k];
  for (const d of await db.listDocs('forms')) if (isObj(d.data)) { if (d.data.own && isObj(d.data.def)) own[d.id] = d.data; edits[d.id] = d.data; }
  // a file form keeps the projects that already use it, whatever its file says: nobody loses a form on a deploy
  const used = (await db.listJoinLinks()).map((l) => [l.form, l.project]).concat((await db.listDocs('joins')).map((d) => [d.data.form, d.data.project]));
  for (const [f, p] of used) if (f && p && !own[f]) (bound[f] = bound[f] || new Set()).add(p);
}
// Does this form belong to the project? A form made in the dashboard: to its project. A file form: to the projects
// its file names in "projects" (without the list, to every project) and to those that already use it.
const serves = (f, project) => !!f && (own[f.id] ? own[f.id].project === project : !Array.isArray(f.projects) || f.projects.includes(project) || !!(bound[f.id] && bound[f.id].has(project)));
// the project's own form first, then a file form that names the project, then one that serves every project
const pickForm = (project, card) => { const l = forms().filter((f) => isCard(f) === card && serves(f, project)); return l.find((f) => own[f.id]) || l.find((f) => Array.isArray(f.projects)) || l[0] || null; };
const teamFormOf = (project) => pickForm(project, false);
const cardFormOf = (project) => pickForm(project, true);
const short = (s) => String(s || '').replace(/[?!.:]+$/, '').split(/\s+/).slice(0, 3).join(' ').slice(0, 24);
const rid = () => require('crypto').randomBytes(5).toString('hex');
// «Создать анкету»: a short form to start from, kept in the database. Its wording, its questions and the kind of
// each answer are then changed in the preview. kind: 'team' (gives access to the project) or 'invite' (a card and the showcase).
function starter(kind, name) {
  const qs = [
    { id: '1.1', t: 'text', req: true, label: 'Как вас зовут?', s: 'Имя', fill: 'name', ac: 'name' },
    { id: '1.5', t: 'many', req: true, label: 'Как с вами удобнее связаться?', s: 'Связь', opts: ['Telegram', 'WhatsApp', 'Телефон', 'E-mail'], fill: 'telegram' },
    { id: '1.2', t: 'tel', label: 'Телефон', s: 'Телефон', ph: '+995 555 12 34 56', ac: 'tel' },
    { id: '2.1', t: 'text', req: true, label: 'Чем вы занимаетесь?', s: 'Занятие' },
    { id: '3.1', t: 'area', label: kind === 'invite' ? 'Что вам интересно в проекте?' : 'Чем хотите заниматься в проекте?', s: 'Интерес' },
  ];
  if (kind !== 'invite') qs.push({ id: '3.2', t: 'one', label: 'Сколько времени в неделю готовы уделять?', s: 'Время', opts: ['До 2 часов', '2–5 часов', '5–10 часов', 'Больше 10 часов'] });
  const def = { title: String(name || 'Проект').slice(0, 80), kicker: kind === 'invite' ? 'Анкета гостя' : 'Анкета участника', coreTime: 'около минуты',
    intro: kind === 'invite' ? 'Расскажите немного о себе: так мы поймём, чем можем быть полезны друг другу.' : 'Ответьте на несколько вопросов, и вы сразу окажетесь в проекте вместе с командой.',
    summary: ['1.1', '1.5', '2.1', '3.1'], steps: [{ id: 'c1', part: 'core', title: 'Знакомство', qs }] };
  if (kind === 'invite') { def.access = 'card'; def.agree = 'Я согласен(на) на хранение моих ответов и контактов в базе проекта'; def.about = { text: '', points: [] }; }
  else def.consent = 'Ответы увидят координаторы проекта. Нажимая «Отправить», вы соглашаетесь передать им эти данные.';
  return def;
}
async function createForm(project, kind, name) {
  kind = kind === 'invite' ? 'invite' : 'team';
  const had = kind === 'invite' ? cardFormOf(project) : teamFormOf(project);
  if (had) return had;
  const id = 'own-' + rid(), def = Object.assign({ id }, starter(kind, name));
  const rec = { own: true, project, kind, def, u: new Date().toISOString() };
  await db.setDoc('forms', id, rec);
  own[id] = rec; edits[id] = rec; delete merged[id];
  return form(id);
}
const str = (v, max) => String(v == null ? '' : v).replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
// One change. target: 'form' | 'step' | 'q'; id: the step's or the question's id; set: the new values.
// Returns {error} with a code the page explains, or {ok, what} for the journal.
async function editForm(formId, target, id, set) {
  const f = form(formId);
  const struct = target === 'q-add' || target === 'q-del';   // these take no values
  if (!f || (!struct && !isObj(set))) return { error: 'bad_request' };
  const e = JSON.parse(JSON.stringify(edits[formId] || {}));
  let what = '';
  if (target === 'form') {
    e.top = isObj(e.top) ? e.top : {};
    for (const k of Object.keys(TOP)) {
      if (set[k] === undefined) continue;
      const v = str(set[k], TOP[k]);
      if (!v && (k === 'title' || f[k])) return { error: 'empty' };   // a text that is there cannot be emptied, only reworded
      if (v) e.top[k] = v;
    }
    what = 'заголовок и тексты';
  } else if (target === 'step') {
    const s = f.steps.find((x) => x.id === id);
    if (!s) return { error: 'not_found' };
    e.steps = isObj(e.steps) ? e.steps : {};
    const o = Object.assign({}, e.steps[s.id]);
    if (set.title !== undefined) { const v = str(set.title, 80); if (!v) return { error: 'empty' }; o.title = v; }
    if (set.text !== undefined) o.text = str(set.text, 400);
    e.steps[s.id] = o; what = 'шаг «' + (o.title || s.title) + '»';
  } else if (target === 'q') {
    const q = questions(f).find((x) => x.id === id);
    if (!q) return { error: 'not_found' };
    e.qs = isObj(e.qs) ? e.qs : {};
    const o = Object.assign({}, e.qs[q.id]), fed = feeds(f, q.id);
    if (set.label !== undefined) { const v = str(set.label, 300); if (!v) return { error: 'empty' }; o.label = v; }
    if (set.hint !== undefined) o.hint = str(set.hint, 300);
    if (set.ph !== undefined) o.ph = str(set.ph, 80);
    if (set.req !== undefined) o.req = !!set.req;
    const t = set.t === undefined ? q.t : set.t;
    if (!TYPES.includes(t)) return { error: 'bad_type' };
    if (fed && t !== q.t) return { error: 'branch' };
    // the question as its file has it: going back to a list brings the file's options back
    const q0 = questions(fileForm(formId)).find((x) => x.id === id) || {};
    if (t !== q.t) o.t = t;
    if (o.t === q0.t) delete o.t;
    if (isChoice(t)) {
      let opts = q.opts || q0.opts;
      if (set.opts !== undefined) {
        if (!Array.isArray(set.opts)) return { error: 'bad_request' };
        opts = [...new Set(set.opts.map((x) => str(x, 120)).filter((x) => x && x !== OTHER && !x.startsWith(OTHER + ':')))].slice(0, 30);
        if (fed && opts.length !== (q.opts || []).length) return { error: 'branch' };
        o.opts = opts;
      }
      if (!Array.isArray(opts) || opts.length < 2) return { error: 'need_opts' };
      if (set.other !== undefined) o.other = !!set.other;
      if (t === 'many' && set.max !== undefined) { const m = Math.floor(+set.max) || 0; o.max = m > 0 && m < opts.length ? m : 0; }
    } else { delete o.opts; delete o.other; delete o.max; }
    e.qs[q.id] = o; what = 'вопрос «' + (o.label || q.label).slice(0, 60) + '»';
  } else if (target === 'q-add' || target === 'q-del') {
    // the set of questions changes only in a form made in the dashboard: a file form keeps its questions
    if (!own[formId]) return { error: 'fixed' };
    const def = e.def;
    if (target === 'q-add') {
      const s = def.steps.find((x) => x.id === id);
      if (!s) return { error: 'not_found' };
      if (questions(def).length >= 60) return { error: 'too_many' };
      const q = { id: 'q' + rid().slice(0, 6), t: 'text', label: 'Новый вопрос', s: 'Новый вопрос', auto: true };
      s.qs.push(q); what = 'добавлен вопрос'; e.added = q.id;
    } else {
      const s = def.steps.find((x) => x.qs.some((q) => q.id === id));
      if (!s) return { error: 'not_found' };
      if (feeds(f, id)) return { error: 'branch' };
      if (questions(def, 'core').length <= 1 && s.part === 'core') return { error: 'last' };
      what = 'удалён вопрос «' + String(questions(f).find((q) => q.id === id).label).slice(0, 60) + '»';
      s.qs = s.qs.filter((q) => q.id !== id);
      if (isObj(e.qs)) delete e.qs[id];
      if (Array.isArray(def.summary)) def.summary = def.summary.filter((x) => x !== id);
    }
  } else return { error: 'bad_request' };
  const added = e.added; delete e.added;
  e.u = new Date().toISOString();
  await db.setDoc('forms', formId, e);
  edits[formId] = e; delete merged[formId];
  if (e.own) own[formId] = e;
  return { ok: true, what, added };
}
async function resetForm(formId) {
  // a project's own form goes back to how it was made (with the questions added since): only the rewording is dropped
  if (own[formId]) {
    const e = edits[formId], had = !!(e.top || e.steps || e.qs), rec = { own: true, project: e.project, kind: e.kind, def: e.def, u: new Date().toISOString() };
    await db.setDoc('forms', formId, rec);
    own[formId] = rec; edits[formId] = rec; delete merged[formId];
    return had;
  }
  const had = !!edits[formId];
  await db.deleteDoc('forms', formId);
  delete edits[formId]; delete merged[formId];
  return had;
}
// the projects that use a form: a link is live or somebody has answered. A form is one for all of them.
async function formProjects(formId) {
  if (own[formId]) return [own[formId].project];
  const a = (await db.listJoinLinks()).filter((l) => l.form === formId).map((l) => l.project);
  const b = (await db.listDocs('joins')).filter((d) => d.data.form === formId).map((d) => d.data.project);
  return [...new Set(a.concat(b).filter(Boolean))];
}
function forms() {
  let files = [];
  try { files = fs.readdirSync(FORMS).filter((f) => /^[a-z0-9-]+\.json$/.test(f)).map((f) => f.slice(0, -5)); } catch (e) { files = []; }
  // a project's own form comes first: it wins over a file form that serves every project
  return Object.keys(own).concat(files.filter((id) => !own[id])).map(form).filter(Boolean);
}
const questions = (f, part) => f.steps.filter((s) => !part || s.part === part).reduce((a, s) => a.concat(s.qs), []);
// A form with "access": "card" is an invitation: the person becomes a contact of the project and sees its
// showcase, nothing else. Any other form is a team form: it gives access to the project.
const isCard = (f) => !!f && f.access === 'card';

// "when": {"q": id, "in": [options]} on a question or a step: it is asked only when that answer holds one of the options.
const holds = (w, a) => {
  if (!w || !w.q) return true;
  const v = a[w.q], list = Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [String(v)];
  return (Array.isArray(w.in) ? w.in : []).some((o) => list.includes(o));
};

const okChoice = (q, v) => typeof v === 'string' && (q.opts.includes(v) || (!!q.other && (v === OTHER || (v.startsWith(OTHER + ': ') && v.length <= 220))));
// Takes what the page sent and keeps only valid answers of this part. errors lists the questions to fix.
// base holds the saved answers of the other part: a condition may look at them. A question whose condition
// does not hold is not asked: its answer is dropped and it is never an error.
function clean(f, part, input, base) {
  const answers = {}, errors = [], src = input && typeof input === 'object' ? input : {};
  const known = Object.assign({}, base);
  for (const st of f.steps.filter((x) => x.part === part)) for (const q of st.qs) {
    delete known[q.id];
    if (!holds(st.when, known) || !holds(q.when, known)) continue;
    const n = errors.length;
    cleanOne(q, src[q.id], answers, errors);
    if (errors.length === n && answers[q.id] !== undefined) known[q.id] = answers[q.id];
  }
  return { answers, errors };
}
function cleanOne(q, v, answers, errors) {
  {
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
    // the choice of the majority: the most votes, the earlier option when equal
    const top = opts.reduce((a, o) => (o.n > (a ? a.n : 0) ? o : a), null);
    return { id: p.id, kind: p.kind || '', title: p.title, q: p.q, multi: !!p.multi, closed: !!p.closed, date: p.date || '', offset: p.offset || '', zone: p.zone || '', toEvent: !!p.event,
      opts, mine, lead: top ? top.t : '', voters: list.filter((d) => ((d.data.votes || {})[p.id] || []).length).length };
  });
}

const CALL = { 'Zoom': 'zoom', 'Google Meet': 'meet', 'Discord': 'other' };
const RU_MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const ruDay = (d) => +d.slice(8, 10) + ' ' + RU_MON[+d.slice(5, 7) - 1];
// The time most people chose becomes the start of the meeting in the project's calendar, and the platform
// most people chose becomes its kind of call. Runs after every vote and writes only when the answer moved.
async function syncEvents(f, link) {
  const res = tally(f, await entries(f), '');
  for (const p of f.polls || []) {
    if (!p.event || p.kind !== 'time') continue;
    const time = res.find((x) => x.id === p.id), plat = res.find((x) => x.id === p.event.call);
    if (!time || !time.lead) continue;
    const tz = await clock.appTz(), ms = Date.parse(p.date + 'T' + time.lead + ':00' + (p.offset || 'Z'));
    if (!isFinite(ms)) continue;
    const wall = clock.parts(ms, tz), where = plat && plat.lead ? plat.lead : '', call = CALL[where] || '';
    const cur = await db.getDoc('events', p.event.id), old = cur ? cur.data : null;
    const title = p.event.title + (where && !['zoom', 'meet'].includes(call) ? ' · ' + where : '');
    const ours = !old || !old.title || old.title.startsWith(p.event.title);
    if (old && old.date === wall.d && old.time === wall.t && (old.call || '') === call && (!ours || old.title === title)) continue;
    let d = await db.mutateDoc('events', p.event.id, (c) => Object.assign({ repeat: '', until: '', contact: '', rem: [] }, c, {
      project: link.project, title: ours ? title : c.title, date: wall.d, time: wall.t, call,
      link: (c.call || '') === call ? c.link || '' : '', u: new Date().toISOString(),
    }));
    hub.publish('events', d.id, d.data, d.version, '', old);
    journal.note(old ? 'upd' : 'add', 'events', d.id, d.data, old, 'голосование');
    // a call without a link gets one: a Zoom room of its own when the Zoom keys are set, otherwise the owner's standing link
    d = (await calls.ensure(d.id).catch((e) => { console.error('[join] call link failed:', e.message); return null; })) || d;
    const owner = await auth.ownerId();
    if (owner) {
      const lead = time.opts.find((o) => o.t === time.lead), zoneTime = time.lead + (p.zone ? ' ' + p.zone : '');
      const inCal = ruDay(wall.d) + ', ' + wall.t, same = wall.d === p.date && wall.t === time.lead;
      const team = d.data.link ? await teamOf(d.data.project) : [];
      await tell(link.project, '', '<b>' + esc(p.event.title) + '</b>\nБольшинство за ' + esc(zoneTime) + ': голосов ' + lead.n + ' из ' + time.voters + '.' + (where ? '\nПлощадка: ' + esc(where) + '.' : '') +
        '\nВ календаре проекта встреча стоит на ' + esc(inCal) + (same ? '' : ' по часовому поясу приложения') + '.' + (d.data.link ? '\nСсылка: ' + esc(d.data.link) : call ? '\nСсылки на созвон у встречи пока нет.' : ''), team.length ? Object.assign(announceKb(d.id, team.length), { owner: true }) : undefined).catch(() => {});
    }
  }
}

function summaryLines(f, a) {
  const by = {}; questions(f).forEach((q) => { by[q.id] = q; });
  return (f.summary || []).filter((id) => by[id] && a[id] !== undefined).map((id) => (by[id].s || by[id].label) + ': ' + flat(a[id]));
}

// The person becomes a contact of the project: found by Telegram name, otherwise a new one.
async function saveContact(f, link, user, a, first) {
  const uname = String(user.username || '').toLowerCase(), id0 = 'jn-' + user.id;
  const all = await db.listDocs('contacts');
  const cur = all.find((c) => c.id === id0) || (uname ? all.find((c) => String(c.data.tg || '').replace(/^@/, '').toLowerCase() === uname) : null);
  const mark = 'Анкета «' + f.title + '»', block = mark + ', ' + new Date().toISOString().slice(0, 10) + '\n' + summaryLines(f, a).join('\n');
  const old = cur ? cur.data : {}, notes = String(old.notes || ''), at = notes.indexOf(mark);
  const card = isCard(f), master = holds(f.master, a) && !!f.master;
  const team = Array.isArray(old.team) ? old.team : [];
  const data = Object.assign({ rel: '' }, old, {
    name: old.name || flat(a['1.1']) || auth.fullName(user) || 'Без имени',
    role: old.role || (master && f.master.role ? f.master.role + (a[f.master.by] ? ': ' + flat(a[f.master.by]) : '') : flat(a['2.1'])).slice(0, 80),
    tg: old.tg || (user.username ? '@' + user.username : ''),
    phone: old.phone || flat(a['1.2']), email: old.email || flat(a['1.3']),
    projects: [...new Set((Array.isArray(old.projects) ? old.projects : []).concat([link.project]))],
    notes: ((at >= 0 ? notes.slice(0, at) : notes ? notes + '\n\n' : '') + block).slice(0, 4000),
    u: new Date().toISOString(),
  });
  // a master is marked on the card and stays marked: the form never takes the mark away
  if (master) data.master = true;
  // the first time through a team form puts the person into the team of the project; after that the card
  // stays where the owner has placed it. An invitation never changes it.
  if (!card && first) { data.team = [...new Set(team.concat([link.project]))]; if (!data.rel) data.rel = 'Команда'; }
  const d = await db.setDoc('contacts', cur ? cur.id : id0, data);
  hub.publish('contacts', d.id, d.data, d.version, '', cur && cur.data);
  return d.id;
}

// What a guest may know about the project: its name and the text the owner wrote for guests
// (the project's field `show`), or the form's own text when the owner has written none.
function showcase(f, p) {
  const own = String((p.data && p.data.show) || '').trim(), about = f.about || {};
  return { title: String(p.data.name || ''), text: (own || String(about.text || '')).slice(0, 4000), points: own ? [] : (Array.isArray(about.points) ? about.points : []).slice(0, 8).map(String) };
}

// What the owner hears about a project, its coordinators hear too. skip: the person the news is about.
// The bot's commands in the text are the owner's; a coordinator is pointed to the dashboard instead.
async function tell(project, skip, text, extra) {
  const owner = await auth.ownerId();
  if (owner && String(owner) !== String(skip)) await say(owner, text, extra && extra.owner ? { inline_keyboard: extra.inline_keyboard } : extra);
  for (const id of await auth.managersOf(project)) {
    if (id === String(skip) || id === String(owner)) continue;
    await say(id, text.replace('Все ответы: /answers, голоса: /votes', 'Все ответы и голоса: в дэшборде, блок «Онбординг»').replace('Все ответы: /answers', 'Все ответы: в дэшборде, блок «Онбординг»'), extra && extra.owner ? undefined : extra).catch(() => {});
  }
}

// Access to this one project, with editing. Whoever already has access keeps it; the project lists add up.
async function grant(user, project) {
  const id = String(user.id), cur = await db.getMember(id);
  // A coordinator stays as they are: the level is one for all of a person's projects, so adding a project here
  // would make them its coordinator, and that is for the owner to decide.
  if (cur && auth.memberRole(cur.role, cur.projects) === 'manager') return;
  const list = cur && !Array.isArray(cur.projects) ? null : [...new Set((cur ? cur.projects : []).concat([project]))];
  await db.upsertMember(id, user.username || '', auth.fullName(user), 'editor');
  await db.setMemberAccess(id, 'editor', list);
  hub.setAccess(id, 'editor', list);
}

// The form as a person gets it, for the owner or a coordinator to look through in the dashboard: the same page,
// nothing is saved. `me` is a newcomer who has answered nothing; `show` is the showcase an invitation opens afterwards.
async function preview(f, p, botName, canEdit) {
  const list = await entries(f), card = isCard(f);
  return {
    form: f, project: String(p.data.name || ''), app: cfg.appName, bot: botName, access: card ? 'card' : 'project', preview: true,
    // edit.can: this person may change the form here; edit.changed: it differs from its file; edit.fed: the questions other questions depend on
    edit: { can: !!canEdit, own: !!own[f.id], changed: !!(edits[f.id] && (edits[f.id].top || edits[f.id].steps || edits[f.id].qs)), fed: questions(f).filter((q) => feeds(f, q.id)).map((q) => q.id), answers: list.length },
    me: { user: { name: '', username: '' }, owner: false, joined: false, more: false, answers: {}, agreed: false,
      people: card ? 0 : list.filter((d) => d.data.core && d.data.project === p.id).length, polls: tally(f, list, ''), show: null },
    show: card ? showcase(f, p) : null,
  };
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
    const joined = !!(mine && mine.data.core), card = isCard(c.f);
    return {
      user: { name: auth.fullName(c.user), username: c.user.username || '' }, owner: c.owner,
      joined, more: !!(mine && mine.data.more), answers: mine ? mine.data.answers || {} : {}, agreed: !!(mine && mine.data.agreed),
      // an invitation does not tell a guest how many people came before
      people: card && !c.owner ? 0 : list.filter((d) => d.data.core && d.data.project === c.link.project).length, polls: tally(c.f, list, c.user.id),
      // the showcase of the project: what it is, for those who filled in the invitation
      show: card && (joined || c.owner) ? showcase(c.f, c.p) : null,
    };
  };

  r.get('/:token', async (req, res) => {
    const c = await ctx(req, res, false); if (!c) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ form: c.f, project: String(c.p.data.name || ''), app: cfg.appName, bot: botName(), access: isCard(c.f) ? 'card' : 'project' });
  });
  r.post('/:token/me', async (req, res) => {
    const c = await ctx(req, res, true); if (!c) return;
    res.json(await state(c));
  });
  r.post('/:token/submit', async (req, res) => {
    const c = await ctx(req, res, true); if (!c) return;
    const part = req.body.part === 'more' ? 'more' : 'core';
    const id = docId(c.f, c.user.id), had = await db.getDoc('joins', id);
    const other = {}; questions(c.f, part === 'core' ? 'more' : 'core').forEach((q) => { if (had && had.data.answers && had.data.answers[q.id] !== undefined) other[q.id] = had.data.answers[q.id]; });
    const { answers, errors } = clean(c.f, part, req.body.answers, other);
    if (errors.length) return res.status(400).json({ error: 'bad_answers', fields: errors });
    if (part === 'more' && !(had && had.data.core)) return res.status(409).json({ error: 'core_first' });
    // the form asks for consent to keep the data: without it nothing is saved, neither the answers nor the card
    if (part === 'core' && c.f.agree && req.body.agree !== true) return res.status(400).json({ error: 'no_consent' });
    const now = new Date().toISOString();
    const d = await db.mutateDoc('joins', id, (cur) => {
      // answers of the other part stay; this part is replaced whole, so a cleared answer is cleared
      const keep = {}; questions(c.f, part === 'core' ? 'more' : 'core').forEach((q) => { if (cur.answers && cur.answers[q.id] !== undefined) keep[q.id] = cur.answers[q.id]; });
      return Object.assign({}, cur, {
        form: c.f.id, project: c.link.project, tg: String(c.user.id), username: c.user.username || '', name: auth.fullName(c.user),
        answers: Object.assign(keep, answers), core: true, more: part === 'more' ? true : !!cur.more, at: cur.at || now, u: now,
      }, part === 'core' && c.f.agree ? { agreed: cur.agreed || now } : null);
    });
    if (part === 'core') {
      if (!c.owner && !isCard(c.f)) await grant(c.user, c.link.project);
      await saveContact(c.f, c.link, c.user, d.data.answers, !(had && had.data.core));
      avatar.soon(c.user.id); // the Telegram photo for the card, without waiting for it
      if (!(had && had.data.core)) await welcome(c, d.data.answers).catch((e) => console.error('[join] notify failed:', e.message));
    } else if (!(had && had.data.more)) {
      await tell(c.link.project, c.user.id, esc(auth.fullName(c.user) || 'Участник') + ' дополняет расширенную анкету «' + esc(c.f.title) + '». Все ответы: /answers').catch(() => {});
    }
    res.json(Object.assign({ ok: true }, await state(c)));
  });
  r.post('/:token/vote', async (req, res) => {
    const c = await ctx(req, res, true); if (!c) return;
    const poll = (c.f.polls || []).find((p) => p.id === req.body.poll);
    if (!poll || !Array.isArray(req.body.picks)) return res.status(400).json({ error: 'bad_request' });
    if (poll.closed) return res.status(409).json({ error: 'closed' });
    let picks = poll.opts.filter((o) => req.body.picks.includes(o));
    if (!poll.multi) picks = picks.slice(0, 1);
    const id = docId(c.f, c.user.id), had = await db.getDoc('joins', id);
    // the form comes first; the owner may vote without it
    if (!c.owner && !(had && had.data.core)) return res.status(409).json({ error: 'core_first' });
    const now = new Date().toISOString();
    await db.mutateDoc('joins', id, (cur) => Object.assign({ form: c.f.id, project: c.link.project, tg: String(c.user.id), answers: {}, at: now }, cur, {
      username: c.user.username || '', name: auth.fullName(c.user), votes: Object.assign({}, cur.votes, { [poll.id]: picks }), u: now,
    }));
    await syncEvents(c.f, c.link).catch((e) => console.error('[join] calendar failed:', e.message));
    res.json(Object.assign({ ok: true }, await state(c)));
  });
  return r;
}

// First time through the form: a word to the person and a word to the owner.
async function welcome(c, a) {
  const name = auth.fullName(c.user) || 'Участник', pn = String(c.p.data.name || 'проект');
  if (isCard(c.f)) {
    const master = !!c.f.master && holds(c.f.master, a);
    if (!c.owner) await say(c.user.id, 'Анкета принята, спасибо! Мы свяжемся с вами в Telegram.\n\nЧто такое «' + esc(pn) + '», можно посмотреть по кнопке ниже. Там же можно изменить ответы.', appBtn('О проекте «' + pn.slice(0, 40) + '»', '/join/' + c.link.token)).catch(() => {});
    {
      await tell(c.link.project, c.user.id, '<b>' + esc(name) + '</b>' + (c.user.username ? ' (@' + esc(c.user.username) + ')' : '') + ' заполнил(а) анкету «' + esc(c.f.title) + '»' + (master ? ' как <b>мастер</b>' : '') + '. Карточка лежит в контактах проекта <b>' + esc(pn) + '</b>' + (master ? ' с пометкой «Мастер»' : '') + '; доступа к проекту у человека нет, он видит только витрину.\n\n' +
        esc(summaryLines(c.f, a).join('\n')) + '\n\nВсе ответы: /answers', appBtn('Открыть ' + cfg.appName, '/'));
    }
    return;
  }
  if (!c.owner) {
    if (https()) await T.tg('setChatMenuButton', { chat_id: c.user.id, menu_button: { type: 'web_app', text: cfg.appName, web_app: { url: cfg.baseUrl + '/' } } }).catch(() => {});
    await say(c.user.id, 'Анкета принята, вы в проекте <b>' + esc(pn) + '</b>. Проект открывается кнопкой ниже: там задачи, вёрсты и комментарии команды.', appBtn('Открыть ' + cfg.appName, '/')).catch(() => {});
  }
  {
    await tell(c.link.project, c.user.id, '<b>' + esc(name) + '</b>' + (c.user.username ? ' (@' + esc(c.user.username) + ')' : '') + ' заполнил(а) анкету «' + esc(c.f.title) + '» и теперь в проекте <b>' + esc(pn) + '</b>: видит только его, может вести задачи.\n\n' +
      esc(summaryLines(c.f, a).join('\n')) + '\n\nКонтакт создан в проекте. Все ответы: /answers, голоса: /votes', appBtn('Открыть ' + cfg.appName, '/'));
  }
}

/* ---------- telling the team about a meeting ---------- */
const PLAT = { zoom: 'Zoom', meet: 'Google Meet' };
// the people of the project's team: those who went through its form, without the owner
async function teamOf(project) {
  const owner = await auth.ownerId();
  return (await db.listDocs('joins')).filter((d) => d.data.project === project && d.data.core && d.data.tg && d.data.tg !== owner && !isCard(form(d.data.form)));
}
const announceKb = (eventId, n) => ({ inline_keyboard: [[{ text: 'Разослать команде (' + n + ')', callback_data: 'an:' + eventId }]] });
// When the meeting is, in words. A meeting set by a poll is told in the poll's own zone, any other in the app's zone.
async function whenText(e) {
  const tz = await clock.appTz(), timed = /^\d{2}:\d{2}$/.test(e.time || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) return '';
  if (!timed) return ruDay(e.date);
  const ms = clock.wallToMs(e.date, e.time, tz);
  return ruDay(e.date) + ', ' + e.time + ' (' + require('./remind').offsetLabel(ms, tz) + ')';
}
async function pollWhen(id, e) {
  for (const f of forms()) for (const p of f.polls || []) {
    if (!p.event || p.event.id !== id || !/^[+-]\d{2}:\d{2}$/.test(p.offset || '') || !/^\d{2}:\d{2}$/.test(e.time || '')) continue;
    const ms = clock.wallToMs(e.date, e.time, await clock.appTz()), sign = p.offset[0] === '-' ? -1 : 1, min = sign * (+p.offset.slice(1, 3) * 60 + +p.offset.slice(4, 6));
    const w = new Date(ms + min * 60000).toISOString();
    return ruDay(w.slice(0, 10)) + ', ' + w.slice(11, 16) + (p.zone ? ' ' + p.zone : '');
  }
  return whenText(e);
}
// Sends the meeting with its link to everyone in the team. Returns how many got it and how many could not be reached.
async function announce(eventId) {
  const doc = await db.getDoc('events', String(eventId));
  if (!doc) return { error: 'Этой встречи уже нет.' };
  const e = doc.data, team = await teamOf(e.project);
  if (!team.length) return { error: 'В команде проекта пока никого нет: рассылать некому.' };
  if (!calls.okLink(e.link)) return { error: 'У встречи пока нет ссылки на созвон.' };
  const p = e.project ? await db.getDoc('projects', e.project) : null;
  const text = '<b>' + esc(e.title || 'Встреча') + '</b>\n' + esc(await pollWhen(doc.id, e)) + '\n' + esc(PLAT[e.call] || 'Ссылка') + ': ' + esc(e.link) + (p ? '\n\nПроект «' + esc(String(p.data.name || '')) + '»' : '');
  let sent = 0;
  for (const d of team) { try { await say(d.data.tg, text); sent++; } catch (err) { /* blocked the bot or never opened it */ } }
  return { sent, total: team.length, title: e.title || 'Встреча' };
}
// The meetings the team could be told about now: those of projects with a team, not yet past.
async function announceable() {
  const today = clock.parts(Date.now(), await clock.appTz()).d, out = [];
  for (const d of await db.listDocs('events')) {
    const e = d.data;
    if (!e.project || !calls.okLink(e.link) || (!e.repeat && String(e.date || '') < today)) continue;
    const n = (await teamOf(e.project)).length;
    if (n) out.push({ id: d.id, project: e.project, title: e.title || 'Встреча', when: await pollWhen(d.id, e), n });
  }
  return out;
}

/* ---------- the bot's side ---------- */
// «/start join_<token>»: anyone may come in by this link.
async function start(m, token) {
  const link = TOKEN_RE.test(token) ? await db.getJoinLink(token) : null;
  const f = link && form(link.form), p = link && await db.getDoc('projects', link.project);
  if (!f || !p) return say(m.chat.id, 'Эта ссылка больше не действует. Попросите у организатора новую.');
  const polls = (f.polls || []).length ? f.pollsNote || 'проголосовать' : '';
  if (isCard(f)) return say(m.chat.id, '<b>' + esc(f.title) + '</b>\n' + esc(f.kicker || 'Анкета') + '\n\n' + esc(f.hello || 'Рады знакомству!') + ' Анкета занимает ' + esc(f.coreTime || 'пару минут') + ': вопросы с вариантами ответа, прямо здесь, в Telegram.' +
    (https() ? '' : '\n\nУ сервера пока нет публичного адреса, анкету открыть нельзя.'), appBtn('Заполнить анкету', '/join/' + token));
  return say(m.chat.id, '<b>' + esc(f.title) + '</b>\n' + esc(f.kicker || 'Анкета') + '\n\nОсновная часть занимает ' + esc(f.coreTime || 'пару минут') + ': вопросы с вариантами ответа, прямо здесь, в Telegram. После неё вы сразу окажетесь в проекте «' + esc(String(p.data.name || '')) + '»' +
    (polls ? ' и сможете ' + esc(polls) : '') + '.' + (https() ? '' : '\n\nУ сервера пока нет публичного адреса, анкету открыть нельзя.'), appBtn('Заполнить анкету', '/join/' + token));
}
const url = (botName, token) => 'https://t.me/' + botName + '?start=join_' + token;
// The owner's link for a project: the same one every time, until it is switched off.
async function linkFor(project, formId) {
  const cur = (await db.listJoinLinks()).find((l) => l.project === project && l.form === formId);
  if (!own[formId]) (bound[formId] = bound[formId] || new Set()).add(project);
  return cur ? cur.token : db.createJoinLink(project, formId);
}
// only: the projects to count (a coordinator's own); without it, all of them
async function votesText(only) {
  const out = [];
  for (const f of forms()) {
    const list = (await entries(f)).filter((d) => !only || only.includes(d.data.project));
    if (only && !list.length) continue;
    tally(f, list, '').forEach((p) => {
      out.push('<b>' + esc(p.title) + '</b> · проголосовали: ' + p.voters + (p.zone ? ' · время ' + esc(p.zone) : ''));
      p.opts.filter((o) => o.n || p.opts.length <= 4).forEach((o) => out.push((o.t === p.lead ? '✅ ' : '') + esc(o.t) + ' — ' + o.n + (o.who.length ? ': ' + esc(o.who.join(', ')) : '')));
      if (!p.voters && p.opts.length > 4) out.push('Пока никто не голосовал.');
      out.push('');
    });
  }
  return out.join('\n').trim() || 'Голосований пока нет.';
}
// Every answer as a table: one row per person, opens in Excel and Google Sheets.
async function csv(f, project) {
  const qs = questions(f), polls = f.polls || [], cell = (v) => '"' + flat(v).replace(/"/g, '""') + '"';
  const rows = [['Дата', 'Имя в Telegram', 'Telegram'].concat(qs.map((q) => q.id + ' ' + q.label), polls.map((p) => p.title)).map(cell).join(',')];
  const list = (await entries(f)).filter((d) => !project || d.data.project === project).sort((a, b) => String(a.data.at || '').localeCompare(String(b.data.at || '')));
  for (const d of list) {
    const x = d.data, a = x.answers || {};
    rows.push([String(x.at || '').slice(0, 10), x.name || '', x.username ? '@' + x.username : ''].concat(qs.map((q) => a[q.id]), polls.map((p) => (x.votes || {})[p.id])).map(cell).join(','));
  }
  return { n: list.length, body: Buffer.from('﻿' + rows.join('\r\n'), 'utf8') };
}

// Everything the onboarding of one project has gathered, as one file: the team form and the invitation together.
// csv: one row per person per form, the columns are all the questions of these forms; opens in Excel and Google Sheets.
// json: the same with the questions, the options and the polls spelled out, for another program to read.
async function exportProject(project, format) {
  const p = await db.getDoc('projects', project), pname = String((p && p.data.name) || '');
  const parts = [];
  for (const f of forms()) {
    const list = (await entries(f)).filter((d) => d.data.project === project);
    if (list.length) parts.push({ f, list });
  }
  const n = parts.reduce((k, x) => k + x.list.length, 0), kind = (f) => (isCard(f) ? 'invite' : 'team');
  const isMaster = (f, a) => !!f.master && holds(f.master, a || {});
  const stamp = new Date().toISOString(), base = 'onboarding-' + project + '-' + stamp.slice(0, 10);
  if (format === 'json') {
    const out = {
      app: 'prooloog', kind: 'onboarding', version: 1, exportedAt: stamp, project: { id: project, name: pname }, people: n,
      forms: parts.map(({ f, list }) => ({
        id: f.id, title: f.title, kind: kind(f),
        questions: questions(f).map((q) => Object.assign({ id: q.id, label: q.label, type: q.t, part: (f.steps.find((s) => s.qs.includes(q)) || {}).part || '', required: !!q.req },
          Array.isArray(q.opts) ? { options: q.opts.concat(q.other ? [OTHER] : []) } : null, q.when ? { when: q.when } : null)),
        polls: tally(f, list, '').map((x) => ({ id: x.id, title: x.title, lead: x.lead, voters: x.voters, options: x.opts.map((o) => ({ option: o.t, votes: o.n, who: o.who })) })),
        people: list.map((d) => {
          const x = d.data;
          return { telegramId: x.tg || '', username: x.username || '', name: x.name || '', filledAt: x.at || '', updatedAt: x.u || '', core: !!x.core, more: !!x.more,
            master: isMaster(f, x.answers), consentAt: x.agreed || '', contact: 'jn-' + x.tg, answers: x.answers || {}, votes: x.votes || {} };
        }),
      })),
    };
    return { n, filename: base + '.json', body: Buffer.from(JSON.stringify(out, null, 2), 'utf8'), project: pname };
  }
  const cell = (v) => '"' + flat(v).replace(/"/g, '""') + '"', cols = [], seen = new Set(), polls = [], seenP = new Set();
  parts.forEach(({ f }) => {
    questions(f).forEach((q) => { if (!seen.has(q.id)) { seen.add(q.id); cols.push(q); } });
    (f.polls || []).forEach((x) => { if (!seenP.has(x.id)) { seenP.add(x.id); polls.push(x); } });
  });
  const rows = [['Анкета', 'Дата', 'Изменено', 'Имя в Telegram', 'Telegram', 'Telegram ID', 'Мастер', 'Согласие', 'Расширенная часть'].concat(cols.map((q) => q.id + ' ' + q.label), polls.map((x) => x.title)).map(cell).join(',')];
  parts.forEach(({ f, list }) => list.forEach((d) => {
    const x = d.data, a = x.answers || {};
    rows.push([f.title, String(x.at || '').slice(0, 10), String(x.u || '').slice(0, 10), x.name || '', x.username ? '@' + x.username : '', x.tg || '', isMaster(f, a) ? 'да' : '', String(x.agreed || '').slice(0, 10), x.more ? 'да' : '']
      .concat(cols.map((q) => a[q.id]), polls.map((k) => (x.votes || {})[k.id])).map(cell).join(','));
  }));
  return { n, filename: base + '.csv', body: Buffer.from('\ufeff' + rows.join('\r\n'), 'utf8'), project: pname };
}

// The onboarding of one project as its owner sees it in the dashboard: the link, who came and what they
// answered, how the polls stand.
async function overview(project, botName) {
  const all = forms().filter((x) => !isCard(x) && serves(x, project)), links = (await db.listJoinLinks()).filter((l) => l.project === project);
  const link = links.find((l) => !isCard(form(l.form))) || null;
  const out = { forms: all.map((x) => ({ id: x.id, title: x.title })), link: null, form: null, people: [], polls: [], invite: await inviteView(project, links, botName) };
  // the form of the live link; without a link, the form people of this project have already filled in
  let f = link ? form(link.form) : null;
  if (!f) { const mine = (await db.listDocs('joins')).find((d) => d.data.project === project && !isCard(form(d.data.form))); f = (mine && form(mine.data.form)) || all[0] || null; }
  if (!f) return out;
  const list = (await entries(f)).filter((d) => d.data.project === project);
  if (link && botName) {
    const u = url(botName, link.token);
    out.link = { url: u, form: link.form, text: 'Коллеги, анкету «' + f.title + '» можно заполнить в Telegram: ' + (f.coreTime || 'пара минут') + ', вопросы с вариантами ответа.' +
      ((f.polls || []).length ? ' После анкеты можно ' + (f.pollsNote || 'проголосовать') + ': видно, кто за что проголосовал.' : '') + '\n\n' + u };
  }
  out.form = { id: f.id, title: f.title, questions: questions(f).map((q) => ({ id: q.id, label: q.label })) };
  out.people = list.map((d) => ({ id: d.id, tg: d.data.tg, name: d.data.name || '', username: d.data.username || '', at: d.data.at || '', core: !!d.data.core, more: !!d.data.more, summary: summaryLines(f, d.data.answers || {}), answers: d.data.answers || {} }));
  // a grid of hours is long: the dashboard gets only the hours somebody chose
  out.polls = tally(f, list, '').map((x) => (x.kind === 'time' && x.voters ? Object.assign({}, x, { opts: x.opts.filter((o) => o.n) }) : x));
  // the answers side by side: for every question with choices, how many picked each one and who
  const name = (d) => d.data.name || (d.data.username ? '@' + d.data.username : 'Участник');
  out.stats = questions(f).filter((q) => (q.t === 'one' || q.t === 'many') && Array.isArray(q.opts)).map((q) => {
    const rows = {}, add = (k, d) => { (rows[k] = rows[k] || []).push(name(d)); };
    list.forEach((d) => { const v = (d.data.answers || {})[q.id]; (Array.isArray(v) ? v : v ? [v] : []).forEach((x) => add(String(x).startsWith(OTHER + ': ') ? OTHER : String(x), d)); });
    const opts = q.opts.concat(rows[OTHER] && !q.opts.includes(OTHER) ? [OTHER] : []).map((o) => ({ t: o, n: (rows[o] || []).length, who: rows[o] || [] })).filter((o) => o.n);
    return { id: q.id, label: q.s || q.label, opts: opts.sort((a, b) => b.n - a.n) };
  }).filter((q) => q.opts.length);
  return out;
}

// The invitation of a project: a standing link for meeting people in person. Whoever fills in its form
// becomes a contact of the project and sees the showcase; the texts are ready to send, one for a guest, one for a master.
function inviteTexts(f, u) {
  const t = f.invite || {}, put = (x) => String(x || '').replace(/\{link\}/g, u);
  return { guest: put(t.guest || 'Анкета «' + f.title + '»: {link}'), master: put(t.master || t.guest || 'Анкета «' + f.title + '»: {link}') };
}
async function inviteView(project, links, botName) {
  const link = links.find((l) => isCard(form(l.form))) || null, f = link ? form(link.form) : cardFormOf(project);
  if (!f) return null;
  const list = (await entries(f)).filter((d) => d.data.project === project && d.data.core), u = link && botName ? url(botName, link.token) : '';
  return {
    form: { id: f.id, title: f.title, questions: questions(f).map((q) => ({ id: q.id, label: q.label })) },
    link: u ? Object.assign({ url: u, form: f.id }, inviteTexts(f, u)) : null,
    people: list.map((d) => ({ id: d.id, tg: d.data.tg, name: d.data.name || '', username: d.data.username || '', at: d.data.at || '', core: true, more: !!d.data.more, master: !!f.master && holds(f.master, d.data.answers || {}),
      summary: summaryLines(f, d.data.answers || {}), answers: d.data.answers || {} })),
  };
}
// The link as a picture, for a meeting in person: the phone's camera opens the bot.
const QR = require('qrcode');
const qrSvg = (text) => QR.toString(text, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
const qrPng = (text) => QR.toBuffer(text, { type: 'png', margin: 3, width: 720, errorCorrectionLevel: 'M' });

// People who went through a team form before the team was kept on the card: their cards get the project
// in `team`, so the «Команда» of each project stays as it was. Runs once.
async function migrateTeam() {
  if (await db.kvGet('team.oncard')) return 0;
  const cs = await db.listDocs('contacts'), owner = await auth.ownerId();
  let n = 0;
  for (const d of await db.listDocs('joins')) {
    const x = d.data;
    if (!x.core || !x.project || !x.tg || x.tg === owner || isCard(form(x.form)) || !form(x.form)) continue;
    const un = String(x.username || '').toLowerCase();
    const c = cs.find((k) => k.id === 'jn-' + x.tg) || (un ? cs.find((k) => String(k.data.tg || '').replace(/^@/, '').toLowerCase() === un) : null);
    if (!c || (Array.isArray(c.data.team) && c.data.team.includes(x.project))) continue;
    const prev = c.data, next = await db.mutateDoc('contacts', c.id, (cur) => Object.assign({}, cur, { team: [...new Set((Array.isArray(cur.team) ? cur.team : []).concat([x.project]))], u: new Date().toISOString() }));
    c.data = next.data;
    hub.publish('contacts', next.id, next.data, next.version, '', prev);
    n++;
  }
  await db.kvSet('team.oncard', { at: new Date().toISOString(), n });
  return n;
}

module.exports = { tell, preview, loadEdits, editForm, resetForm, formProjects, exportProject, isCard, teamFormOf, cardFormOf, createForm, serves, inviteTexts, qrSvg, qrPng, migrateTeam, router, start, url, linkFor, votesText, csv, form, forms, clean, entries, tally, overview, announce, announceable, announceKb, teamOf };
