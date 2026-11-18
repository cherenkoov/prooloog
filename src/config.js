'use strict';
// Everything the server reads from the environment, in one place.
const crypto = require('crypto');
const env = process.env;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const trimUrl = (u) => String(u || '').replace(/\/+$/, '');

// Without SESSION_SECRET sessions would not survive a restart: fine locally, never on a server.
const sessionSecret = env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
// Telegram accepts only A-Z a-z 0-9 _ - in a webhook secret, so derive a safe one.
const hookSeed = env.WEBHOOK_SECRET || env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const cfg = {
  port: +env.PORT || 10000,
  databaseUrl: env.DATABASE_URL || '',
  botToken: env.BOT_TOKEN || '',
  tgApiRoot: trimUrl(env.TG_API_ROOT || 'https://api.telegram.org'),
  baseUrl: trimUrl(env.APP_URL || env.RENDER_EXTERNAL_URL || ''),
  ownerId: /^\d{1,20}$/.test(env.OWNER_ID || '') ? env.OWNER_ID : '',
  ownerUsername: String(env.OWNER_USERNAME || '').replace(/^@/, '').toLowerCase(),
  sessionSecret,
  sessionSecretFixed: !!env.SESSION_SECRET,
  webhookSecret: sha('hook:' + hookSeed).slice(0, 48),
  webhookPath: sha('path:' + hookSeed).slice(0, 32),
  appName: env.APP_NAME || 'Prooloog',
  seedFile: env.SEED_FILE || '',
  tz: env.APP_TZ || 'Asia/Tbilisi',
  backupDays: env.BACKUP_DAYS === undefined ? 7 : Math.max(0, +env.BACKUP_DAYS || 0),
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  aiModel: env.AI_MODEL || 'claude-sonnet-5-5',
  aiApiRoot: trimUrl(env.AI_API_ROOT || 'https://api.anthropic.com'),
  aiApiVersion: env.AI_API_VERSION || '2026-10-21',
};

// Prices in US dollars per million tokens, for the cost estimate in the dashboard. List prices as of November 2026;
// AI_PRICE_IN / AI_PRICE_OUT override them for the configured model.
cfg.aiPrices = {
  'claude-sonnet-5-5': { in: 2, out: 10, cr: 0.1, cw: 2.5 },
  'claude-opus-5-5': { in: 4, out: 20, cr: 0.2, cw: 5 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cr: 0.01, cw: 0.125 },
};
if (+env.AI_PRICE_IN > 0 && +env.AI_PRICE_OUT > 0) cfg.aiPrices[cfg.aiModel] = { in: +env.AI_PRICE_IN, out: +env.AI_PRICE_OUT, cr: +env.AI_PRICE_IN / 10, cw: +env.AI_PRICE_IN * 1.25 };

// Collections the dashboard page uses. Anything else is refused.
cfg.collections = ['projects', 'tasks', 'milestones', 'events', 'inbox', 'log', 'posts', 'channels', 'services', 'money', 'contacts', 'messages', 'subs', 'activity', 'clients', 'usage', 'evsubs', 'chats', 'audit', 'gone', 'settings'];
// what a copy, a merge or a sync carries: everything but the journal, which is the history of this copy alone
cfg.dataCollections = cfg.collections.filter((c) => c !== 'audit');
// Money, people and client messages are for the owner only.
cfg.ownerOnly = new Set(['money', 'contacts', 'messages', 'subs', 'activity', 'clients', 'usage', 'evsubs', 'chats', 'audit', 'gone']);
// Kept by the server alone (onboarding answers): the page never reads them, but backups carry them.
cfg.serverOnly = ['joins'];
// what a backup restores: the data and the server's own records, without the journal
cfg.allCollections = cfg.dataCollections.concat(cfg.serverOnly);

module.exports = cfg;
