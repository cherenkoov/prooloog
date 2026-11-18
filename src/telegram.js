'use strict';
// A thin client for the Telegram Bot API: plain HTTPS calls, no library.
const cfg = require('./config');

async function tg(method, params) {
  const res = await fetch(`${cfg.tgApiRoot}/bot${cfg.botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params || {}),
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json().catch(() => null);
  if (!j || !j.ok) {
    throw Object.assign(new Error(`telegram ${method}: ${(j && j.description) || 'HTTP ' + res.status}`), { code: 'tg_error', status: res.status });
  }
  return j.result;
}

// Sends a file from memory (used for data backups).
async function sendDocument(chatId, filename, buf, caption) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  if (caption) fd.append('caption', caption);
  fd.append('document', new Blob([buf], { type: 'application/json' }), filename);
  const res = await fetch(`${cfg.tgApiRoot}/bot${cfg.botToken}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
  const j = await res.json().catch(() => null);
  if (!j || !j.ok) throw Object.assign(new Error(`telegram sendDocument: ${(j && j.description) || 'HTTP ' + res.status}`), { code: 'tg_error' });
  return j.result;
}

// Opens a download stream for a file the bot has received.
async function openFile(fileId) {
  const f = await tg('getFile', { file_id: fileId });
  if (!f || !f.file_path) throw Object.assign(new Error('telegram: no file path'), { code: 'tg_error' });
  const res = await fetch(`${cfg.tgApiRoot}/file/bot${cfg.botToken}/${f.file_path}`, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw Object.assign(new Error('telegram file: HTTP ' + res.status), { code: 'tg_error' });
  return { res, path: f.file_path, size: +f.file_size || 0 };
}
async function readFile(fileId, maxBytes) {
  const f = await openFile(fileId);
  if (f.size > maxBytes) throw Object.assign(new Error('file too large'), { code: 'too_large' });
  const buf = Buffer.from(await f.res.arrayBuffer());
  if (buf.length > maxBytes) throw Object.assign(new Error('file too large'), { code: 'too_large' });
  return buf;
}

module.exports = { tg, sendDocument, openFile, readFile };
