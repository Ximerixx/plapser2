'use strict';

/**
 * Telegram bot worker entry. Runs in a separate thread (worker_threads).
 * workerData: { token, apiBaseUrl, botUsername }
 */
const { parentPort, workerData } = require('worker_threads');

/** tgbot version: X.Y — bump major (X) on DB/schema changes, minor (Y) on fixes. Sent in request_stats.user_agent. */
const TELEGRAM_API_VERSION = '1.0';

function buildUserAgent(mode, userId, chatId, entityType, entityKey, scope) {
    const parts = [`PlapserTelegramAPI/${TELEGRAM_API_VERSION}`, `mode=${mode}`];
    if (userId) parts.push(`user=${userId}`);
    if (chatId) parts.push(`chat=${chatId}`);
    if (entityType) parts.push(`entity_type=${entityType}`);
    if (entityKey) parts.push(`entity_key=${entityKey}`);
    if (scope) parts.push(`scope=${scope}`);
    return parts.join(' ');
}

async function main() {
    const { token, apiBaseUrl, botUsername } = workerData || {};
    if (!token || !apiBaseUrl) {
        console.error('[tgbot] workerData must have token and apiBaseUrl');
        return;
    }

    const db = require('../db/db');
    const jsapi = require('../jsapi');
    const { getListByEntityType } = require('./lists');
    const { T } = require('./strings');
    const { formatScheduleBlock } = require('./jobs/daily');
    const { registerGroupHandlers } = require('./handlers/group');
    const { registerInlineHandler } = require('./handlers/inline');
    const { registerPrivateHandlers } = require('./handlers/private');
    const { startDailyCron } = require('./jobs/daily');

    const { Telegraf, session } = require('telegraf');

    const bot = new Telegraf(token);

    bot.use(session());

    const getLists = (type) => getListByEntityType(apiBaseUrl, type);

    let username = botUsername;
    if (!username) {
        try {
            const me = await bot.telegram.getMe();
            username = me.username;
        } catch (_) {}
    }

    registerGroupHandlers(bot, {
        db,
        apiBaseUrl,
        getLists,
        T,
        buildUserAgent
    });

    registerInlineHandler(bot, {
        getLists,
        botUsername: username || 'PlapserScheduleBot',
        db
    });

    registerPrivateHandlers(bot, {
        db,
        jsapi,
        buildUserAgent,
        T,
        formatScheduleBlock
    });

    bot.catch((err, ctx) => {
        console.error('[tgbot]', err);
        try {
            ctx.reply(T.ru.error(err.message)).catch(() => {});
        } catch (_) {}
    });

    startDailyCron(bot.telegram, { db, jsapi, buildUserAgent, T });

    await bot.launch();
    if (parentPort) parentPort.postMessage({ type: 'started' });
    console.log('[tgbot] worker started');
}

main().catch(e => {
    console.error('[tgbot] worker failed', e);
    if (parentPort) parentPort.postMessage({ type: 'error', message: e.message });
    process.exitCode = 1;
});
