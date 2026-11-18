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

// Collections the dashboard page uses. Anything else is refused.
cfg.collections = ['projects', 'tasks', 'milestones', 'events', 'inbox', 'log', 'posts', 'channels', 'services', 'money', 'contacts', 'messages', 'subs', 'settings'];
// Money, people and client messages are for the owner only.
cfg.ownerOnly = new Set(['money', 'contacts', 'messages', 'subs']);

module.exports = cfg;
