'use strict';
// The player's own AI companion of a game, in the private chat with the bot. What «Life Game» asked every
// player to set up by hand (a separate chat with a neural network and a file of rules) happens here, inside
// Telegram: the companion knows the rules that are in force, sees the player's quests and reports, helps to
// choose quests, and saves the card and the day's report itself once the player has agreed.
// The talk belongs to the player. It is kept in the server's key-value table (not in the documents, so neither
// the dashboard nor a backup carries it), only to go on later; the player can wipe it. The project gets nothing
// but the quests and reports the player asked to save.
const cfg = require('./config');
const db = require('./db');
const hub = require('./realtime');
const clock = require('./clock');
const auth = require('./auth');
const ai = require('./ai');
const T = require('./telegram');
const game = require('./game');
const journal = require('./journal');

const IDLE_MS = 45 * 60000, MAX_TURNS = 40, MAX_CHARS = 40000, ROUNDS = 5;
const DAILY = Math.max(1, +process.env.COMPANION_DAILY || 80); // a player's messages a day: the owner's key pays for them
const BR = game.BR, BRN = { spirit: 'Дух', soul: 'Душа', body: 'Тело' };

let B = null; // what the bot lends: say(chat, html, markup), kb, esc, botName()
const init = (ctx) => { B = ctx; };
const key = (uid) => 'comp:' + uid;
const one = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const nowIso = () => new Date().toISOString();
const plain = (t) => String(t || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,4}\s+/gm, '').trim();
const person = (u) => auth.fullName(u || {}) || (u && u.username ? '@' + u.username : 'Игрок');
const get = async (uid) => { const s = await db.kvGet(key(uid)); return s && s.project && Array.isArray(s.turns) ? s : null; };
const active = async (uid) => { const s = await get(uid); return !!s && s.on === true && Date.now() - (+s.lastAt || 0) < IDLE_MS; };
const kb = () => B.kb([[{ text: 'Завершить разговор', callback_data: 'cm:end' }, { text: 'Стереть разговор', callback_data: 'cm:wipe' }]]);
const link = (projectId) => (B.botName() ? 'https://t.me/' + B.botName() + '?start=gm_' + projectId : '');

const ERR = {
  not_declared: 'AI-компаньон пока не подключён: на сервере нет ключа Claude. Квесты можно взять в приложении или карточкой в чате игры.',
  not_granted: 'Claude не принял ключ сервера. Напиши тем, кто ведёт проект.',
  rate_limited: 'Claude сейчас перегружен. Попробуй через минуту.',
  refused: 'На это сообщение Claude не ответил. Попробуй сказать иначе.',
  prompt_too_large: 'Разговор стал слишком длинным. Нажми «Стереть разговор» и начни заново: квесты и отчёты сохранены.',
};

/* ---------- who may talk ---------- */
// A player of the project: somebody with the project in the dashboard, with records in its game, or a member of a
// chat tied to it.
async function mayPlay(user, projectId) {
  const uid = String(user.id), role = await auth.roleOf({ id: uid });
  if (role === 'owner') return true;
  if (role) { const sc = await auth.scopeOf(uid); if (!sc || sc.includes(projectId)) return true; }
  const mine = (d) => d.data.project === projectId && String(d.data.player) === uid;
  if ((await db.listDocs('quests')).some(mine) || (await db.listDocs('checkins')).some(mine)) return true;
  for (const c of await db.listDocs('chats')) {
    if (c.data.project !== projectId || c.data.on === false) continue;
    try {
      const cm = await T.tg('getChatMember', { chat_id: c.data.tg, user_id: user.id });
      if (cm && !(cm.status === 'left' || cm.status === 'kicked' || (cm.status === 'restricted' && cm.is_member === false))) return true;
    } catch (e) { /* Telegram does not say: not a member as far as the bot knows */ }
  }
  return false;
}
async function games() { return (await db.listDocs('projects')).filter((p) => game.isOn(p.data)); }

/* ---------- what the companion knows ---------- */
async function stateOf(p, uid, name) {
  const tz = await clock.appTz(), now = clock.parts(Date.now(), tz), week = game.weekOf(now.d);
  const qs = (await db.listDocs('quests')).filter((d) => d.data.project === p.id).map((d) => d.data);
  const mine = qs.filter((q) => !q.lib && q.week === week && String(q.player) === uid);
  const reps = (await db.listDocs('checkins')).filter((d) => d.data.project === p.id && d.data.week === week && String(d.data.player) === uid).map((d) => d.data).sort((a, b) => (a.date < b.date ? -1 : 1));
  const row = (await game.table(p, week)).find((r) => r.player === uid);
  const party = (p.data.game.party && p.data.game.party[week]) || '';
  const L = ['Игрок: ' + name, 'Сегодня: ' + now.d + ', спринт: неделя с ' + week + ' (' + game.weekLabel(week) + ')'];
  L.push(mine.length ? 'Квесты игрока в этом спринте:' : 'Квестов в этом спринте у игрока пока нет.');
  for (const q of mine) L.push('- ' + (q.branch === 'party' ? 'вклад в общий квест' : BRN[q.branch] + ', L' + (Math.round(+q.level) || 1)) + ': ' + one(q.title, 200) + (q.result ? '; результат: ' + one(q.result, 200) : '') + (q.min ? '; дневной минимум: ' + one(q.min, 200) : '') + (+q.freq ? '; дней в неделю: ' + q.freq : '') + '; статус: ' + (q.status || 'active'));
  L.push(reps.length ? 'Отчёты игрока за спринт:' : 'Отчётов за спринт пока нет.');
  for (const c of reps) L.push('- ' + c.date + ': ' + BR.map((b) => BRN[b] + ' ' + (c[b] === true ? 'да' : c[b] === false ? 'нет' : '—')).join(', ') + (c.text || c.chat ? '; ' + one(c.text || c.chat, 300) : '') + (c.insight ? '; открытие: ' + one(c.insight, 200) : ''));
  L.push('XP игрока: за спринт ' + (row ? row.xp.total : 0) + ', за всю игру ' + (row ? row.all : 0) + '.');
  L.push(party ? 'Общий квест команды на спринт: ' + one(party, 200) + (game.wonOf(p.data, week) ? ' (цель достигнута)' : '') : 'Общий квест команды на этот спринт не выбран.');
  const lib = qs.filter((q) => q.lib).slice(0, 40).map((q) => BRN[q.branch] + ': ' + one(q.title, 80));
  if (lib.length) L.push('Идеи в библиотеке квестов: ' + lib.join('; '));
  return { text: L.join('\n'), week, day: now.d };
}
function systemText(p, st) {
  const R = Object.assign({}, game.RULES, p.data.game && p.data.game.rules), lv = game.LEVELS;
  return ['Ты — личный AI-компаньон игрока в игре «' + one(p.data.name, 80) + '». Разговор идёт в личном чате Telegram с ботом ' + cfg.appName + '.',
    '',
    'ИГРА. Кооперативная игра небольшой группы друзей: недельные спринты (с понедельника), личные квесты, отчёт дня, взаимная поддержка. Принципы: свобода выбора, прогресс важнее идеальности, поддержка вместо сравнения, реальные действия важнее очков. Пропуск дня ничего не обнуляет.',
    'Три ветки: ДУХ (мышление, внимание, обучение, навыки, дисциплина, карьера, финансы), ДУША (творчество, отношения, эмоции, общение, самовыражение, радость), ТЕЛО (сон, движение, питание, восстановление, здоровье, телесные и дыхательные практики). Ветку определяет главная цель квеста, а не действие.',
    'В спринте игрок берёт от одного до трёх личных квестов, не больше одного на ветку; один или два квеста — полноценное участие. У квеста есть: название, зачем, результат (измеримый критерий завершения за неделю), действие, дневной минимум, частота (дней в неделю), уровень L1 (лёгкий старт), L2 (устойчивое развитие) или L3 (серьёзный, но реалистичный вызов). Уровень выбирается относительно возможностей самого игрока.',
    'XP (правила 1.1): завершённый недельный квест — L1 ' + lv[0] + ', L2 ' + lv[1] + ', L3 ' + lv[2] + ' XP, один раз, когда игрок сам подтверждает результат; число дней на очки не влияет. Завершены квесты во всех трёх ветках — +' + R.all + '. Отчёт дня — +' + R.report + ', день отдыха тоже считается. Конкретная помощь другому игроку — +' + R.help + ', не больше ' + R.helpMax + ' раз в неделю. Общий квест: +' + R.party + ' за свой вклад и +' + R.team + ' каждому участнику, если команда достигла цели. XP считает сервер: сам очки не складывай и не обещай, называй только то, что видишь ниже.',
    '',
    'КАК ТЫ РАБОТАЕШЬ.',
    '- Пиши по-русски (если игрок не попросит иначе), ясно, дружелюбно, без давления и нравоучений. Сообщения короткие: это мессенджер. Без таблиц и разметки Markdown.',
    '- Задавай вопросы по одному или по два, не устраивай анкету. Не придумывай цели, факты о жизни игрока, его достижения, договорённости команды и правила.',
    '- Первое знакомство: коротко объясни суть и три ветки, спроси, что игрок хочет изменить или попробовать за ближайшую неделю, помоги разложить идеи по веткам, предложи от одного до трёх квестов с результатом, действием, минимумом, частотой и уровнем. Не навязывай три квеста и не повышай сложность ради очков.',
    '- Когда игрок согласился с квестами, покажи их списком и спроси прямо: «Сохраняю?» Только после явного «да» вызови save_quests. Спроси и о том, публиковать ли карточку в чат игры: это решает игрок.',
    '- Если игрок рассказывает, что сделал сегодня, или говорит, что отдыхал, предложи сохранить отчёт дня и после согласия вызови save_report. Квест отмечай завершённым (finish_quest) только когда игрок сам говорит, что результат достигнут.',
    '- Если игрок застрял, помоги найти минимальный следующий шаг или уменьшить сложность и частоту. Финальное решение всегда за игроком.',
    '- Ты не заменяешь врача, психолога или финансового консультанта; при заметных рисках советуй обратиться к специалисту. Не предлагай опасных нагрузок.',
    '- Ты видишь только то, что ниже, и этот разговор. Чат команды, чужие квесты и отчёты тебе не видны; о других игроках не рассуждай.',
    '',
    'СЕЙЧАС.', st.text].join('\n');
}

/* ---------- what the companion can do ---------- */
const str = (max) => ({ type: 'string', maxLength: max });
function tools() {
  const quest = { type: 'object', properties: { branch: { type: 'string', enum: BR }, title: str(200), why: str(300), result: str(300), action: str(300), min: str(300), freq: { type: 'integer', minimum: 1, maximum: 7 }, level: { type: 'integer', minimum: 1, maximum: 3 } }, required: ['branch', 'title', 'level'] };
  return [
    { name: 'save_quests', description: 'Сохранить квесты игрока на текущий спринт. Вызывать только после того, как игрок явно согласился с этим списком. Квест ветки заменяет прежний квест этой ветки; ветки, которых нет в списке, не меняются.', input_schema: { type: 'object', properties: { quests: { type: 'array', items: quest, minItems: 1, maxItems: 3 }, party: Object.assign({ description: 'Вклад игрока в общий квест команды, если он его назвал' }, str(200)), publish: { type: 'boolean', description: 'true, только если игрок прямо попросил опубликовать карточку в чат игры' } }, required: ['quests'] } },
    { name: 'save_report', description: 'Сохранить отчёт игрока за сегодня (или дополнить уже сохранённый). Вызывать после согласия игрока. Отметка ветки: true — дневной минимум сделан, false — запланирован и не сделан; не передавать, если не планировалось.', input_schema: { type: 'object', properties: { spirit: { type: 'boolean' }, soul: { type: 'boolean' }, body: { type: 'boolean' }, text: Object.assign({ description: 'Что сделал, словами игрока' }, str(1500)), insight: Object.assign({ description: 'Открытие дня' }, str(600)), signal: { type: 'string', enum: ['flow', 'stuck', 'help'] } } } },
    { name: 'finish_quest', description: 'Отметить квест текущего спринта завершённым (XP начисляется один раз) или вернуть его в работу. Только когда игрок сам сказал, что результат достигнут.', input_schema: { type: 'object', properties: { branch: { type: 'string', enum: BR.concat(['party']) }, done: { type: 'boolean' } }, required: ['branch', 'done'] } },
    { name: 'add_idea', description: 'Добавить идею квеста в общую библиотеку игры, когда игрок просит об этом.', input_schema: { type: 'object', properties: { branch: { type: 'string', enum: BR }, title: str(200), why: str(300), l1: str(300), l2: str(300), l3: str(300) }, required: ['branch', 'title'] } },
  ];
}
async function runTool(name, input, ctx) {
  const { p, uid, user } = ctx, pname = person(user), tz = await clock.appTz(), day = clock.parts(Date.now(), tz).d, week = game.weekOf(day);
  const quests = async () => (await db.listDocs('quests')).filter((d) => d.data.project === p.id && !d.data.lib && d.data.week === week && String(d.data.player) === uid);
  const i = input && typeof input === 'object' ? input : {};
  if (name === 'save_quests') {
    const list = (Array.isArray(i.quests) ? i.quests : []).filter((q) => q && BR.includes(q.branch) && one(q.title, 200)).slice(0, 3), mine = await quests(), saved = [];
    if (!list.length) throw new Error('нет ни одного квеста с веткой и названием');
    const put = async (b, data) => {
      const cur = mine.find((d) => d.data.branch === b), id = cur ? cur.id : game.questId(p.id, uid, week, b);
      const d = await db.mutateDoc('quests', id, (was) => Object.assign({ project: p.id, player: uid, week, branch: b, status: 'active' }, was, data, { name: pname, src: 'companion', u: nowIso() }));
      hub.publish('quests', d.id, d.data, d.version);
      if (!cur) journal.note('add', 'quests', d.id, d.data, null, pname);
      return d.data;
    };
    for (const q of list) saved.push(await put(q.branch, { title: one(q.title, 200), why: one(q.why, 300), result: one(q.result, 300), action: one(q.action, 300), min: one(q.min, 300), freq: Math.max(0, Math.min(7, Math.round(+q.freq || 0))), level: Math.max(1, Math.min(3, Math.round(+q.level || 1))), status: 'active' }));
    if (one(i.party, 200)) await put('party', { title: one(i.party, 200) });
    let published = false;
    if (i.publish === true) published = await game.postCard(p, uid, week).catch(() => false);
    return { saved: saved.map((q) => BRN[q.branch] + ': ' + q.title + ', L' + q.level), week, published };
  }
  if (name === 'save_report') {
    const id = game.checkId(p.id, uid, day);
    const d = await db.mutateDoc('checkins', id, (was) => {
      const next = Object.assign({ project: p.id, player: uid, date: day, week, spirit: null, soul: null, body: null, text: '', insight: '', signal: '', help: 0, src: 'companion' }, was, { name: pname, u: nowIso() });
      for (const b of BR) if (typeof i[b] === 'boolean') next[b] = i[b];
      if (one(i.text, 1500)) next.text = one(i.text, 1500);
      if (one(i.insight, 600)) next.insight = one(i.insight, 600);
      if (['flow', 'stuck', 'help'].includes(i.signal)) next.signal = i.signal;
      return next;
    });
    hub.publish('checkins', d.id, d.data, d.version);
    return { saved: true, date: day };
  }
  if (name === 'finish_quest') {
    const q = (await quests()).find((d) => d.data.branch === i.branch);
    if (!q) throw new Error('в этом спринте у игрока нет квеста в этой ветке');
    const d = await db.updateDoc('quests', q.id, { status: i.done === false ? 'active' : 'done', u: nowIso() });
    hub.publish('quests', d.id, d.data, d.version);
    return { status: d.data.status };
  }
  if (name === 'add_idea') {
    if (!BR.includes(i.branch) || !one(i.title, 200)) throw new Error('нужны ветка и название');
    const id = 'ql' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const d = await db.setDoc('quests', id, { project: p.id, lib: true, by: uid, name: pname, branch: i.branch, title: one(i.title, 200), why: one(i.why, 300), l1: one(i.l1, 300), l2: one(i.l2, 300), l3: one(i.l3, 300), u: nowIso() });
    hub.publish('quests', d.id, d.data, d.version);
    return { added: true };
  }
  throw new Error('unknown tool');
}

/* ---------- the talk ---------- */
const chains = new Map(); // one player's messages go in turn
function inTurn(uid, fn) {
  const prev = chains.get(uid) || Promise.resolve(), p = prev.then(fn, fn);
  chains.set(uid, p.catch(() => {}));
  if (chains.size > 2000) chains.clear();
  return p;
}
async function answer(s, ctx) {
  const st = await stateOf(ctx.p, ctx.uid, person(ctx.user)), system = systemText(ctx.p, st), list = tools();
  const messages = s.turns.map((x) => ({ role: x.r === 'a' ? 'assistant' : 'user', content: x.t }));
  const did = [];
  for (let n = 0; n < ROUNDS; n++) {
    const r = await ai.chat({ system, messages, tools: list, maxTokens: 1200 });
    if (r.error) return { error: r.error, did };
    const uses = r.content.filter((b) => b && b.type === 'tool_use');
    if (r.stop !== 'tool_use' || !uses.length) {
      const text = r.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim();
      return { text: text || (did.length ? 'Готово, сохранил.' : ''), did };
    }
    messages.push({ role: 'assistant', content: r.content });
    const results = [];
    for (const u of uses) {
      try { const out = await runTool(u.name, u.input, ctx); did.push(u.name); results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 4000) }); }
      catch (e) { results.push({ type: 'tool_result', tool_use_id: u.id, content: String((e && e.message) || 'failed').slice(0, 500), is_error: true }); }
    }
    messages.push({ role: 'user', content: results });
  }
  return { text: 'Остановился: слишком много шагов подряд. Скажи, что сделать дальше.', did };
}
const send = (chat, text, markup) => T.tg('sendMessage', { chat_id: chat, text: String(text).slice(0, 4000), link_preview_options: { is_disabled: true }, reply_markup: markup });
async function turn(m, s, text) {
  const uid = String(m.from.id), chat = m.chat.id;
  const p = await db.getDoc('projects', s.project);
  if (!p || !game.isOn(p.data)) { await db.kvSet(key(uid), Object.assign({}, s, { on: false })); return send(chat, 'Игра в этом проекте сейчас выключена, поэтому компаньон недоступен.'); }
  const tz = await clock.appTz(), day = clock.parts(Date.now(), tz).d;
  const count = s.day === day ? +s.n || 0 : 0;
  if (count >= DAILY) return send(chat, 'На сегодня лимит сообщений компаньону исчерпан (' + DAILY + '). Продолжим завтра; квесты и отчёты можно вести в приложении и в чате игры.');
  s.turns.push({ r: 'u', t: one(text, 4000) });
  while (s.turns.length > MAX_TURNS || s.turns.reduce((n, x) => n + x.t.length, 0) > MAX_CHARS) s.turns.shift();
  while (s.turns.length && s.turns[0].r !== 'u') s.turns.shift();
  T.tg('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {});
  const r = await answer(s, { p, uid, user: m.from });
  if (r.error) {
    s.turns.pop();
    await db.kvSet(key(uid), Object.assign(s, { on: true, lastAt: Date.now() }));
    return send(chat, ERR[r.error] || 'Не получилось получить ответ. Попробуй ещё раз чуть позже.');
  }
  const out = plain(r.text) || 'Готово.';
  s.turns.push({ r: 'a', t: out.slice(0, 6000) });
  await db.kvSet(key(uid), Object.assign(s, { on: true, lastAt: Date.now(), day, n: count + 1 }));
  for (let i = 0; i < out.length; i += 3900) await send(chat, out.slice(i, i + 3900), i + 3900 >= out.length ? kb() : undefined);
}
// A message of the player while the talk is open.
function say(m) {
  const uid = String(m.from.id), text = String(m.text || m.caption || '').trim();
  if (!text) return send(m.chat.id, 'Компаньон пока понимает только текст. Напиши словами.');
  return inTurn(uid, async () => { const s = await get(uid); if (!s) return; return turn(m, s, text); });
}
// The player opens the talk: by the link from the chat of the game (projectId) or by /companion.
async function start(m, projectId) {
  const uid = String(m.from.id), chat = m.chat.id, all = await games();
  let p = projectId ? all.find((x) => x.id === projectId) : null;
  if (!p && !projectId) {
    const s = await get(uid), mine = [];
    for (const g of all) if (await mayPlay(m.from, g.id)) mine.push(g);
    p = (s && mine.find((x) => x.id === s.project)) || (mine.length === 1 ? mine[0] : null);
    if (!p && mine.length > 1) return B.say(chat, 'В какой игре открыть компаньона?', B.kb(mine.slice(0, 8).map((g) => [{ text: one(g.data.name, 40), callback_data: 'cm:go:' + g.id }])));
  }
  if (!p) return send(chat, 'Компаньон работает в проектах-играх. Открой его кнопкой из чата своей игры: там напиши /companion.');
  if (!(await mayPlay(m.from, p.id))) return send(chat, 'Компаньон этой игры открыт её игрокам: участникам чата игры и тем, у кого есть проект в приложении.');
  if (!ai.enabled()) return send(chat, ERR.not_declared);
  const was = await get(uid), fresh = !was || was.project !== p.id || !was.turns.length;
  const s = fresh ? { project: p.id, turns: [], n: was ? +was.n || 0 : 0, day: was ? was.day : '' } : was;
  await db.kvSet(key(uid), Object.assign(s, { on: true, lastAt: Date.now() }));
  await send(chat, '🧭 AI-компаньон игры «' + one(p.data.name, 60) + '».\n\nЯ знаю действующие правила, вижу твои квесты и отчёты и помогу выбрать квесты, подобрать сложность и вести отчёт дня. Квесты и отчёты сохраняю сам, когда ты скажешь «да».\n\nЭтот разговор видишь только ты: его обрабатывает Claude, а хранится он у бота лишь затем, чтобы продолжить позже. В проект попадают только квесты и отчёты, которые ты попросишь сохранить. «Стереть разговор» удаляет его.\n\nПросто пиши сюда. Команды других разделов бота работают как обычно.');
  return inTurn(uid, async () => turn(m, await get(uid), fresh ? 'Привет! Я хочу начать: помоги мне создать персонажа и подготовиться к спринту.' : 'Я вернулся. Коротко напомни, на чём мы остановились, и спроси, что дальше.'));
}
async function end(uid, wipe) {
  const s = await get(uid);
  if (!s) return false;
  await db.kvSet(key(uid), wipe ? { project: s.project, turns: [], on: false, n: +s.n || 0, day: s.day || '' } : Object.assign({}, s, { on: false }));
  return true;
}
// cm:end, cm:wipe, cm:go:<project> — buttons in the private chat
async function onCallback(cq, ack) {
  const data = String(cq.data || ''), uid = String(cq.from.id), msg = cq.message, chat = msg && msg.chat && msg.chat.id;
  const go = /^cm:go:([A-Za-z0-9_-]{1,60})$/.exec(data);
  if (go) { await ack(); return start({ from: cq.from, chat: { id: chat } }, go[1]); }
  if (data !== 'cm:end' && data !== 'cm:wipe') return ack();
  const had = await end(uid, data === 'cm:wipe');
  await ack(!had ? 'Разговора уже нет' : data === 'cm:wipe' ? 'Стёр' : 'Завершил');
  if (msg && msg.message_id) await T.tg('editMessageReplyMarkup', { chat_id: chat, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  if (had) await send(chat, data === 'cm:wipe' ? 'Разговор стёрт. Сохранённые квесты и отчёты остались в игре. Вернуться: /companion.' : 'Разговор завершён, я помню его до следующего раза. Вернуться: /companion.');
}

module.exports = { init, start, say, end, active, onCallback, link, mayPlay, DAILY, IDLE_MS };
