'use strict';
// Profile photos from Telegram for the avatars in the dashboard (authors of actions and records).
// The bot asks Telegram for the person's current photo, keeps the smallest size in `files` (a link to a file
// on Telegram's side carries the bot's token and cannot be given to a page) and puts it where the page looks:
//   - the list of people with access (GET /api/share → members[].photo), always as /f/<id>;
//   - the person's contact card (`contacts.photo`) and, for the owner, `settings/main.photo`.
// On a record a small photo is written as a data URI: the copy of the dashboard inside Claude can show only
// such pictures, and the record gets there by sync. A bigger one stays a /f/ link (visible on the server only).
// Telegram shows a bot the photo only of somebody who has written to it or shares a chat with it, and only
// when the person's privacy settings allow: without a photo the page draws initials.
const db = require('./db');
const hub = require('./realtime');
const auth = require('./auth');
const { tg, readFile } = require('./telegram');

const STALE_MS = 3 * 864e5, MAX_BYTES = 300 * 1024, INLINE_BYTES = 12 * 1024;
const busy = new Set();
const key = (id) => 'avatar:' + id;
const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;

async function fetchPhoto(id) {
  const r = await tg('getUserProfilePhotos', { user_id: Number(id), limit: 1 });
  const sizes = r && Array.isArray(r.photos) ? r.photos[0] : null;
  if (!Array.isArray(sizes) || !sizes.length) return null;
  const s = sizes.slice().sort((a, b) => (a.width || 0) - (b.width || 0))[0];
  if (!s || !s.file_id) return null;
  return { uid: String(s.file_unique_id || s.file_id), fileId: s.file_id };
}

// What goes on a record: a data URI when the picture is small enough, otherwise the /f/ link.
async function onRecord(st) {
  if (!st || !st.url) return '';
  const f = await db.getFile(st.url.slice(3));
  if (!f) return '';
  return f.bytes.length <= INLINE_BYTES ? 'data:' + f.mime + ';base64,' + Buffer.from(f.bytes).toString('base64') : st.url;
}
async function setPhoto(coll, id, value) {
  let prev = null, changed = false;
  const d = await db.mutateDoc(coll, id, (cur) => {
    prev = Object.assign({}, cur);
    if (String(cur.photo || '') === value) return cur;
    changed = true;
    const next = Object.assign({}, cur, { u: new Date().toISOString() });
    if (value) next.photo = value; else delete next.photo;
    return next;
  });
  if (changed) hub.publish(coll, d.id, d.data, d.version, '', prev);
}
// Puts the photo on the person's card and, for the owner, into the settings. Nothing is journaled: it is not an action.
async function apply(id, st) {
  st = st || (await db.kvGet(key(id)));
  if (!st) return;
  const value = await onRecord(st);
  const owner = (await auth.ownerId()) === String(id);
  const prof = await auth.profileOf(String(id), owner ? 'owner' : 'member');
  const uname = String(prof.username || '').toLowerCase();
  const all = await db.listDocs('contacts');
  const c = all.find((x) => x.id === 'jn-' + id) || (uname ? all.find((x) => String(x.data.tg || '').replace(/^@/, '').toLowerCase() === uname) : null);
  if (c && String(c.data.photo || '') !== value) await setPhoto('contacts', c.id, value);
  if (owner) {
    const s = await db.getDoc('settings', 'main');
    if (String((s && s.data.photo) || '') !== value && (s || value)) await setPhoto('settings', 'main', value);
  }
}

// Asks Telegram when the stored photo is older than a few days (or `force`), then puts it where the page looks.
async function refresh(id, opts) {
  id = String(id || '');
  if (!/^\d{1,20}$/.test(id) || busy.has(id)) return null;
  busy.add(id);
  try {
    let st = await db.kvGet(key(id));
    if (!st || (opts && opts.force) || Date.now() - Date.parse(st.at || 0) > STALE_MS || !isFinite(Date.parse(st.at || ''))) {
      const now = new Date().toISOString(), got = await fetchPhoto(id);
      if (!got) {
        if (st && st.url) await db.deleteFile(st.url.slice(3));
        st = { at: now, uid: '', url: '' };
      } else if (st && st.url && st.uid === got.uid && (await db.getFile(st.url.slice(3)))) {
        st = { at: now, uid: st.uid, url: st.url };
      } else {
        const buf = await readFile(got.fileId, MAX_BYTES);
        if (!isJpeg(buf)) throw Object.assign(new Error('avatar: not a JPEG'), { code: 'bad_data' });
        const fid = await db.putFile('image/jpeg', buf, id);
        if (st && st.url) await db.deleteFile(st.url.slice(3));
        st = { at: now, uid: got.uid, url: '/f/' + fid };
      }
      await db.kvSet(key(id), st);
    }
    await apply(id, st);
    return st;
  } finally { busy.delete(id); }
}
// The same without waiting and without ever failing the caller: signing in and forms do not depend on a picture.
function soon(id, opts) { refresh(id, opts).catch((e) => console.error('[avatar]', e.message)); }

async function urlOf(id) { const st = await db.kvGet(key(String(id))); return (st && st.url) || ''; }
async function forget(id) {
  const st = await db.kvGet(key(String(id)));
  if (st && st.url) await db.deleteFile(st.url.slice(3));
  if (st) await db.kvSet(key(String(id)), { at: '', uid: '', url: '' });
}

module.exports = { refresh, soon, apply, urlOf, forget };
