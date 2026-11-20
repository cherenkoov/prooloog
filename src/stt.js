'use strict';
// Optional: the text of a voice message. Works only when STT_API_KEY is set.
// Claude does not take audio, so the words come from a speech-to-text service with the OpenAI-compatible
// call POST /audio/transcriptions (OpenAI, Groq and others): a file and a model in, { text } out.
// The text lands in the message record itself, next to the player: it is a transcript, and it can be wrong.
const cfg = require('./config');
const db = require('./db');
const T = require('./telegram');
const hub = require('./realtime');

const MAX_BYTES = 20 * 1024 * 1024; // what a bot may download from Telegram
const MAX_TEXT = 7600;              // the dashboard's message form holds 8000
const enabled = () => !!cfg.sttKey;

// Telegram keeps a voice message as OGG/Opus under the name .oga: the services know the same file as .ogg
function fileName(file, path) {
  const ext = (/\.([a-z0-9]{2,5})$/i.exec(String(path || '')) || /\.([a-z0-9]{2,5})$/i.exec(String((file && file.name) || '')) || [])[1];
  const e = String(ext || 'ogg').toLowerCase();
  return 'audio.' + (e === 'oga' || e === 'opus' ? 'ogg' : e);
}

// Returns { text } or { error }.
async function transcribe(buf, name) {
  if (!enabled()) return { error: 'not_declared' };
  const fd = new FormData();
  fd.append('file', new Blob([buf]), name || 'audio.ogg');
  fd.append('model', cfg.sttModel);
  if (cfg.sttLang) fd.append('language', cfg.sttLang);
  let up;
  try {
    up = await fetch(cfg.sttApiRoot + '/audio/transcriptions', { method: 'POST', headers: { authorization: 'Bearer ' + cfg.sttKey }, body: fd, signal: AbortSignal.timeout(120000) });
  } catch (e) { return { error: 'upstream' }; }
  const j = await up.json().catch(() => null);
  if (!up.ok || !j) {
    const err = (j && j.error) || {};
    console.error('[stt] upstream refused:', up.status, String(err.message || '').slice(0, 200));
    return { error: up.status === 401 || up.status === 403 ? 'not_granted' : up.status === 429 ? 'rate_limited' : up.status === 413 ? 'too_large' : 'upstream' };
  }
  const text = String(j.text || '').replace(/\s+/g, ' ').trim();
  return text ? { text } : { error: 'empty' };
}

// Fills the text of one saved message that has audio and no words yet. A text somebody has written is never replaced.
async function fill(id) {
  const doc = await db.getDoc('messages', String(id));
  const f = doc && doc.data.file;
  if (!doc || !f || f.kind !== 'audio' || !f.tg) return { error: 'no_audio' };
  if (String(doc.data.text || '').trim()) return { text: doc.data.text, kept: true };
  if (!enabled()) return { error: 'not_declared' };
  let r;
  try {
    const got = await T.openFile(f.tg);
    if (got.size > MAX_BYTES) r = { error: 'too_large' };
    else {
      const buf = Buffer.from(await got.res.arrayBuffer());
      r = buf.length > MAX_BYTES ? { error: 'too_large' } : await transcribe(buf, fileName(f, got.path));
    }
  } catch (e) { r = { error: e.code === 'too_large' ? 'too_large' : 'no_file' }; }
  // the record may have been filled in by hand or deleted while the service was listening
  const now = await db.getDoc('messages', doc.id), at = new Date().toISOString();
  if (!now || !now.data.file) return r;
  const patch = r.text && !String(now.data.text || '').trim() ? { text: r.text.slice(0, MAX_TEXT), stt: { at, model: cfg.sttModel }, u: at } : r.error ? { stt: { at, error: r.error } } : null;
  const d = patch ? await db.updateDoc('messages', doc.id, patch) : null;
  if (d) hub.publish('messages', d.id, d.data, d.version);
  return r;
}

// One at a time, after the update has been answered: a chat that sends ten voices in a row does not start ten uploads.
let chain = Promise.resolve();
function later(id) {
  if (!enabled()) return;
  chain = chain.then(() => fill(id)).catch((e) => console.error('[stt] not transcribed:', e.message));
}
const idle = () => chain;

module.exports = { enabled, transcribe, fill, later, idle, fileName };
