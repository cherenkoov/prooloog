'use strict';
// Google Meet rooms. The owner signs in to Google once (the bot's /google gives the link); the server keeps
// the refresh token and from then on makes a room of its own for every Meet call that has no link.
// Needs an OAuth client of a Google Cloud project: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, with
// <BASE_URL>/api/google/callback among its redirect URIs and the Google Meet REST API switched on.
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');

const SCOPE = 'https://www.googleapis.com/auth/meetings.space.created';
const KEY = 'google.oauth';
const env = () => ({
  id: process.env.GOOGLE_CLIENT_ID || '', secret: process.env.GOOGLE_CLIENT_SECRET || '',
  auth: process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
  token: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  meet: (process.env.GOOGLE_MEET_ROOT || 'https://meet.googleapis.com/v2').replace(/\/$/, ''),
});
const redirect = () => cfg.baseUrl + '/api/google/callback';
const configured = () => { const g = env(); return !!(g.id && g.secret); };
const okLink = (s) => typeof s === 'string' && /^https?:\/\/\S+$/i.test(s);
let access = { v: '', until: 0 };

// {refresh, at, broken?}: broken is set when Google refuses the stored token, until the owner signs in again
const saved = () => db.kvGet(KEY);
async function status() {
  const s = await saved();
  return { configured: configured(), connected: !!(s && s.refresh && !s.broken), broken: !!(s && s.broken), at: (s && s.at) || '', redirect: redirect() };
}
const on = async () => configured() && (await status()).connected;

// The sign-in link. The state is a one-time code, so only the one who got the link from the bot can finish.
async function startUrl() {
  const g = env(), state = crypto.randomBytes(18).toString('base64url');
  await db.kvSet('google.state', { v: state, until: Date.now() + 15 * 60000 });
  return g.auth + '?' + new URLSearchParams({ client_id: g.id, redirect_uri: redirect(), response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', state }).toString();
}
async function post(params) {
  const g = env();
  const r = await fetch(g.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.assign({ client_id: g.id, client_secret: g.secret }, params)).toString(), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null);
  return { ok: r.ok && !!j, status: r.status, j: j || {} };
}
// Google comes back here after the owner agreed. Returns '' on success, otherwise what went wrong, in words.
async function finish(code, state) {
  const st = await db.kvGet('google.state');
  if (!st || !state || st.v !== state || Date.now() > st.until) return 'Ссылка для входа устарела. Напишите боту /google и откройте новую.';
  await db.kvSet('google.state', { v: '', until: 0 });
  const r = await post({ code: String(code || ''), grant_type: 'authorization_code', redirect_uri: redirect() });
  if (!r.ok || !r.j.access_token) return 'Google не выдал доступ: ' + String(r.j.error_description || r.j.error || r.status).slice(0, 200);
  if (!r.j.refresh_token) return 'Google не выдал долгий ключ. Отзовите доступ приложения на myaccount.google.com/permissions и войдите ещё раз.';
  if (r.j.scope && !String(r.j.scope).split(' ').includes(SCOPE)) return 'На экране Google не было отмечено разрешение создавать встречи Meet. Войдите ещё раз и оставьте галочку.';
  await db.kvSet(KEY, { refresh: r.j.refresh_token, at: new Date().toISOString() });
  access = { v: r.j.access_token, until: Date.now() + Math.max(60, (+r.j.expires_in || 3600) - 120) * 1000 };
  return '';
}
async function disconnect() { await db.kvSet(KEY, {}); access = { v: '', until: 0 }; }

async function token() {
  if (access.v && Date.now() < access.until) return access.v;
  const s = await saved();
  if (!s || !s.refresh || s.broken) throw new Error('not connected');
  const r = await post({ refresh_token: s.refresh, grant_type: 'refresh_token' });
  if (!r.ok || !r.j.access_token) {
    // invalid_grant: the token was revoked or has expired (a Google app in «Testing» keeps it 7 days)
    if (r.j.error === 'invalid_grant') { await db.kvSet(KEY, Object.assign({}, s, { broken: true })); const e = new Error('google sign-in expired'); e.expired = true; throw e; }
    throw new Error('token refused: ' + r.status + ' ' + String(r.j.error || '').slice(0, 80));
  }
  access = { v: r.j.access_token, until: Date.now() + Math.max(60, (+r.j.expires_in || 3600) - 120) * 1000 };
  return access.v;
}
// A new meeting space. The link lives as long as it is used; who may join without knocking follows the owner's own Meet settings.
async function room() {
  const g = env(), t = await token();
  const r = await fetch(g.meet + '/spaces', { method: 'POST', headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => null);
  if (r.status === 401) access = { v: '', until: 0 };
  if (!r.ok || !j || !okLink(j.meetingUri)) throw new Error('space refused: ' + r.status + ' ' + String((j && j.error && j.error.message) || '').slice(0, 200));
  return { link: j.meetingUri, id: String(j.name || '') };
}

module.exports = { configured, status, on, startUrl, finish, disconnect, room, redirect, SCOPE, forgetAccess: () => { access = { v: '', until: 0 }; } };
