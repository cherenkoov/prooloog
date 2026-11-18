'use strict';
// Call links for meetings. An event saved as a Zoom call without a link gets one by itself:
// a room of its own through the Zoom API when its keys are set (ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID,
// ZOOM_CLIENT_SECRET of a Server-to-Server OAuth app), otherwise the owner's permanent Zoom link from the settings.
// A Google Meet call gets a room of its own once the owner has signed in to Google (src/google.js),
// otherwise the owner's permanent Meet link from the settings.
const db = require('./db');
const hub = require('./realtime');
const clock = require('./clock');
const journal = require('./journal');
const google = require('./google');
const auth = require('./auth');
const T = require('./telegram');

const okLink = (s) => typeof s === 'string' && /^https?:\/\/\S+$/i.test(s);
const env = () => ({
  account: process.env.ZOOM_ACCOUNT_ID || '', id: process.env.ZOOM_CLIENT_ID || '', secret: process.env.ZOOM_CLIENT_SECRET || '',
  user: process.env.ZOOM_USER || 'me', // the host: «me», or the e-mail of the Zoom account when «me» is refused
  auth: (process.env.ZOOM_AUTH_ROOT || 'https://zoom.us').replace(/\/$/, ''), api: (process.env.ZOOM_API_ROOT || 'https://api.zoom.us/v2').replace(/\/$/, ''),
});
const zoomOn = () => { const z = env(); return !!(z.account && z.id && z.secret); };
let tok = { v: '', until: 0, key: '' };

async function token() {
  const z = env(), key = z.account + '|' + z.id;
  if (tok.v && tok.key === key && Date.now() < tok.until) return tok.v;
  const r = await fetch(z.auth + '/oauth/token', {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from(z.id + ':' + z.secret).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=account_credentials&account_id=' + encodeURIComponent(z.account),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.access_token) throw new Error('token refused: ' + r.status + ' ' + String((j && (j.reason || j.error)) || '').slice(0, 120));
  tok = { v: j.access_token, until: Date.now() + Math.max(60, (+j.expires_in || 3600) - 120) * 1000, key };
  return tok.v;
}
// A meeting at a known time is a scheduled one; without a time, or repeating, it is a room that stays open.
async function zoomRoom(e, tz) {
  const z = env(), t = await token();
  const timed = /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') && /^\d{2}:\d{2}$/.test(e.time || '') && !e.repeat;
  const body = Object.assign({ topic: String(e.title || 'Meeting').slice(0, 200) }, timed ? { type: 2, start_time: e.date + 'T' + e.time + ':00', timezone: tz, duration: 60 } : { type: 3 });
  const r = await fetch(z.api + '/users/' + encodeURIComponent(z.user) + '/meetings', {
    method: 'POST', headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => null);
  if (r.status === 401) tok = { v: '', until: 0, key: '' };
  if (!r.ok || !j || !okLink(j.join_url)) throw new Error('meeting refused: ' + r.status + ' ' + String((j && j.message) || '').slice(0, 160));
  return { link: j.join_url, id: String(j.id || '') };
}

// Gives a link to an event that is a call and has none. Returns the changed record, or null when there was nothing to do.
async function ensure(id) {
  const doc = await db.getDoc('events', String(id));
  if (!doc) return null;
  const e = doc.data;
  if ((e.call !== 'zoom' && e.call !== 'meet') || okLink(e.link)) return null;
  let patch = null;
  if (e.call === 'zoom' && zoomOn()) {
    try { const r = await zoomRoom(e, await clock.appTz()); patch = { link: r.link, zoomId: r.id }; } catch (err) { console.error('[calls] zoom:', err.message); }
  }
  if (e.call === 'meet' && await google.on()) {
    try { const r = await google.room(); patch = { link: r.link, meetId: r.id }; } catch (err) {
      console.error('[calls] meet:', err.message);
      // the stored sign-in stopped working: say it once, the flag in google.js keeps it from repeating
      if (err.expired) { const owner = await auth.ownerId(); if (owner) T.tg('sendMessage', { chat_id: owner, text: 'Google больше не принимает сохранённый вход, комнаты Meet не создаются. Напиши /google и войди заново.' }).catch(() => {}); }
    }
  }
  if (!patch) {
    const st = await db.getDoc('settings', 'main'), meet = (st && st.data && st.data.meet) || {};
    if (okLink(meet[e.call])) patch = { link: meet[e.call] };
  }
  if (!patch) return null;
  const d = await db.updateDoc('events', doc.id, Object.assign(patch, { u: new Date().toISOString() }));
  if (!d) return null;
  hub.publish('events', d.id, d.data, d.version, '', e);
  journal.note('upd', 'events', d.id, d.data, e, patch.zoomId ? 'Zoom' : patch.meetId ? 'Google Meet' : 'сервер');
  return d;
}

// Every coming call that still has no link gets one. Used right after a platform is connected.
async function fill() {
  const today = clock.parts(Date.now(), await clock.appTz()).d, out = [];
  for (const d of await db.listDocs('events')) {
    const e = d.data;
    if ((e.call !== 'zoom' && e.call !== 'meet') || okLink(e.link)) continue;
    if (!e.repeat && String(e.date || '') < today) continue;
    const r = await ensure(d.id).catch(() => null);
    if (r) out.push(r);
  }
  return out;
}

module.exports = { ensure, fill, zoomOn, okLink };
