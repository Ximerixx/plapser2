'use strict';

/**
 * Telegram bot worker entry. Runs in a separate thread (worker_threads).
 * workerData: { token, apiBaseUrl, botUsername, proxyUrl }
 */
const { parentPort, workerData } = require('worker_threads');

/** tgbot version: X.Y — bump major (X) on DB/schema changes, minor (Y) on fixes. Sent in request_stats.user_agent. */
const PLAPSER_TG_BOT_INTEGRATION_VERSION = '1.3';

function buildUserAgent(mode, userId, chatId, entityType, entityKey, scope) {
    const parts = [`PlapserTelegramAPI/${PLAPSER_TG_BOT_INTEGRATION_VERSION}`, `mode=${mode}`];
    if (userId) parts.push(`user=${userId}`);
    if (chatId) parts.push(`chat=${chatId}`);
    if (entityType) parts.push(`entity_type=${entityType}`);
    if (entityKey) parts.push(`entity_key=${entityKey}`);
    if (scope) parts.push(`scope=${scope}`);
    return parts.join(' ');
}

const {
    createProxyAgent,
    probeTelegramReachable,
    PROXY_HEALTH_INTERVAL_MS,
    TELEGRAM_HOURLY_INTERVAL_MS,
} = require('./connectivity');

async function main() {
    const { token, apiBaseUrl, botUsername, proxyUrl } = workerData || {};
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
    const { registerPrivateHandlers, getScheduleText } = require('./handlers/private');
    const { startDailyCron } = require('./jobs/daily');

    const { Telegraf, session } = require('telegraf');

    const proxyTrim =
        proxyUrl && typeof proxyUrl === 'string' ? proxyUrl.trim() : '';

    const directOk = await probeTelegramReachable(undefined, 12000);
    if (!proxyTrim) {
        if (!directOk) {
            console.error(
                '[tgbot] Telegram API недоступен без прокси. Укажите TELEGRAM_PROXY в tgbot/config.json (или переменную окружения TELEGRAM_PROXY) и перезапустите сервер.'
            );
        }
    }

    const telegramOpts = {};
    const agent = createProxyAgent(proxyUrl);
    const proxyInUse = !!agent;
    if (agent) {
        telegramOpts.telegram = { agent };
        console.log('[tgbot] using proxy for Telegram API');
        const viaProxyOk = await probeTelegramReachable(agent, 12000);
        if (!viaProxyOk) {
            console.error(
                '[tgbot] Через указанный TELEGRAM_PROXY не удаётся достучаться до api.telegram.org. Проверьте, что прокси запущен и адрес верный.'
            );
        }
    } else if (proxyTrim) {
        console.error(
            '[tgbot] TELEGRAM_PROXY задан, но URL не распознан. Используйте socks5://, socks4://, http:// или https://.'
        );
    }

    const bot = new Telegraf(token, telegramOpts);

    bot.use(session());

    const getLists = (type) => getListByEntityType(apiBaseUrl, type);

    let username = botUsername;
    if (!username) {
        try {
            const me = await bot.telegram.getMe();
            username = me.username;
        } catch (_) { }
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
        db,
        getScheduleText,
        deps: { jsapi, formatScheduleBlock, T },
        buildUserAgent
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
            ctx.reply(T.ru.error(err.message)).catch(() => { });
        } catch (_) { }
    });

    startDailyCron(bot.telegram, { db, jsapi, buildUserAgent, T });

    await bot.launch();

    if (proxyInUse) {
        setInterval(async () => {
            const ok = await probeTelegramReachable(
                bot.telegram.options.agent,
                8000
            );
            if (!ok) {
                console.warn(
                    '[tgbot] прокси не ответил на проверку (интервал ' +
                        Math.round(PROXY_HEALTH_INTERVAL_MS / 1000) +
                        ' с), пересоздаём агент (SOCKS/HTTP)'
                );
                const fresh = createProxyAgent(proxyUrl);
                if (fresh) bot.telegram.options.agent = fresh;
            }
        }, PROXY_HEALTH_INTERVAL_MS);
    }

    setInterval(async () => {
        const useAgent = proxyInUse ? bot.telegram.options.agent : undefined;
        const ok = await probeTelegramReachable(useAgent, 15000);
        if (!ok) {
            console.warn(
                '[tgbot] периодическая проверка Telegram: api.telegram.org недоступен' +
                    (proxyInUse ? ' через прокси' : ' напрямую') +
                    '. Если вы в регионе с блокировкой, включите TELEGRAM_PROXY в конфиге.'
            );
        }
    }, TELEGRAM_HOURLY_INTERVAL_MS);

    if (parentPort) parentPort.postMessage({ type: 'started' });
    console.log('[tgbot] worker started');
}

main().catch(e => {
    console.error('[tgbot] worker failed', e);
    if (parentPort) parentPort.postMessage({ type: 'error', message: e.message });
    process.exitCode = 1;
});
