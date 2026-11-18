'use strict';
// Optional: answers from Claude inside the dashboard (comment chats, client reply analysis, post variants).
// Works only when ANTHROPIC_API_KEY is set. Request shape and stream format follow
// https://platform.claude.com/docs/en/api/messages/create and .../build-with-claude/streaming
const cfg = require('./config');
const usage = require('./usage');

const MAX_CHARS = 400000;

function toMessages(input) {
  if (typeof input === 'string') return input.trim() ? [{ role: 'user', content: input }] : null;
  if (!Array.isArray(input) || !input.length) return null;
  const out = [];
  for (const t of input) {
    if (!t || typeof t.content !== 'string' || !t.content.trim()) continue;
    const role = t.role === 'assistant' ? 'assistant' : 'user';
    // The API wants alternating turns: glue neighbours of the same role together.
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += '\n\n' + t.content;
    else out.push({ role, content: t.content });
  }
  return out.length && out[0].role === 'user' && out[out.length - 1].role === 'user' ? out : null;
}

function codeFor(status, type, message) {
  if (status === 401 || status === 403 || type === 'authentication_error' || type === 'permission_error') return 'not_granted';
  if (status === 429 || type === 'rate_limit_error') return 'rate_limited';
  if (status === 413 || type === 'request_too_large' || /too long|too large/i.test(message || '')) return 'prompt_too_large';
  return 'upstream';
}

async function handle(req, res) {
  if (!cfg.anthropicKey) return res.status(404).json({ error: 'not_declared' });
  const messages = toMessages(req.body && req.body.input);
  if (!messages) return res.status(400).json({ error: 'bad_request' });
  if (messages.reduce((n, m) => n + m.content.length, 0) > MAX_CHARS) return res.status(400).json({ error: 'prompt_too_large' });

  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });

  let up;
  try {
    up = await fetch(cfg.aiApiRoot + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': cfg.aiApiVersion, authorization: 'Bearer ' + cfg.anthropicKey },
      body: JSON.stringify({ model: cfg.aiModel, max_tokens: 4096, stream: true, messages }),
      signal: ac.signal,
    });
  } catch (e) {
    if (ac.signal.aborted) return;
    return res.status(502).json({ error: 'upstream' });
  }
  if (!up.ok || !up.body) {
    const j = await up.json().catch(() => null);
    const err = (j && j.error) || {};
    console.error('[ai] upstream refused:', up.status, err.type || '', String(err.message || '').slice(0, 200));
    return res.status(502).json({ error: codeFor(up.status, err.type, err.message) });
  }

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
  const line = (o) => res.write(JSON.stringify(o) + '\n');
  const dec = new TextDecoder();
  let buf = '', stop = '', failed = '';
  const used = {};
  const eat = (block) => {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data) return;
    let ev; try { ev = JSON.parse(data); } catch (e) { return; }
    // message_start carries the input side of the usage, message_delta the running output count
    if (ev.type === 'message_start' && ev.message && ev.message.usage) Object.assign(used, ev.message.usage);
    if (ev.type === 'message_delta' && ev.usage) Object.assign(used, ev.usage);
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && ev.delta.text) line({ d: ev.delta.text });
    else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason;
    else if (ev.type === 'error') failed = codeFor(0, ev.error && ev.error.type, ev.error && ev.error.message);
    // every other event type (ping, thinking, tool blocks, future additions) is skipped on purpose
  };
  try {
    for await (const chunk of up.body) {
      buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { eat(buf.slice(0, i)); buf = buf.slice(i + 2); }
    }
    if (buf.trim()) eat(buf);
    if (failed) line({ error: failed });
    else if (stop === 'refusal') line({ error: 'refused' });
    else line({ done: true, truncated: stop === 'max_tokens' });
  } catch (e) {
    if (!ac.signal.aborted) line({ error: 'upstream' });
  }
  res.end();
  if (used.input_tokens || used.output_tokens) usage.record(cfg.aiModel, used, 'page').catch((e) => console.error('[ai] usage not saved:', e.message));
}

// One complete answer, for the bot. Returns { text } or { error }.
async function ask(system, messages, maxTokens) {
  if (!cfg.anthropicKey) return { error: 'not_declared' };
  let up;
  try {
    up = await fetch(cfg.aiApiRoot + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': cfg.aiApiVersion, authorization: 'Bearer ' + cfg.anthropicKey },
      body: JSON.stringify({ model: cfg.aiModel, max_tokens: maxTokens || 1500, system, messages }),
      signal: AbortSignal.timeout(90000),
    });
  } catch (e) { return { error: 'upstream' }; }
  const j = await up.json().catch(() => null);
  if (!up.ok || !j) {
    const err = (j && j.error) || {};
    console.error('[ai] upstream refused:', up.status, err.type || '', String(err.message || '').slice(0, 200));
    return { error: codeFor(up.status, err.type, err.message) };
  }
  if (j.usage) usage.record(cfg.aiModel, j.usage, 'bot').catch((e) => console.error('[ai] usage not saved:', e.message));
  if (j.stop_reason === 'refusal') return { error: 'refused' };
  const text = (Array.isArray(j.content) ? j.content : []).filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim();
  return text ? { text, truncated: j.stop_reason === 'max_tokens' } : { error: 'upstream' };
}

module.exports = { handle, ask, enabled: () => !!cfg.anthropicKey, toMessages };
