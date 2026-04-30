'use strict';

/**
 * Проверки доступности api.telegram.org и фабрика агента для прокси (HTTP/S HTTPS/SOCKS).
 */
const axios = require('axios');

const TELEGRAM_PROBE_URL =
    process.env.TELEGRAM_PROBE_URL || 'https://api.telegram.org/';
const PROXY_HEALTH_INTERVAL_MS = Number(
    process.env.TG_PROXY_HEALTH_INTERVAL_MS || 60 * 1000
);
const TELEGRAM_HOURLY_INTERVAL_MS = Number(
    process.env.TG_TELEGRAM_CHECK_INTERVAL_MS || 60 * 60 * 1000
);

function createProxyAgent(proxyUrl) {
    if (!proxyUrl || typeof proxyUrl !== 'string') return null;
    const s = proxyUrl.trim();
    if (!s) return null;
    try {
        const u = new URL(s);
        const protocol = (u.protocol || '').replace(/:$/, '').toLowerCase();
        if (protocol === 'http' || protocol === 'https') {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            return new HttpsProxyAgent(s);
        }
        if (
            protocol === 'socks' ||
            protocol === 'socks4' ||
            protocol === 'socks5'
        ) {
            const { SocksProxyAgent } = require('socks-proxy-agent');
            return new SocksProxyAgent(s);
        }
        console.warn(
            '[tgbot] unsupported proxy protocol:',
            protocol,
            '- use http, https, socks4, or socks5'
        );
        return null;
    } catch (e) {
        console.warn('[tgbot] proxy URL parse failed:', e.message);
        return null;
    }
}

/**
 * Достижимость Telegram Bot API (любой HTTP-ответ от корня — достаточно).
 */
async function probeTelegramReachable(agent, timeoutMs = 12000) {
    try {
        const cfg = {
            timeout: timeoutMs,
            validateStatus: () => true,
            maxRedirects: 3,
        };
        if (agent) {
            cfg.httpsAgent = agent;
            cfg.proxy = false;
        }
        await axios.get(TELEGRAM_PROBE_URL, cfg);
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = {
    createProxyAgent,
    probeTelegramReachable,
    TELEGRAM_PROBE_URL,
    PROXY_HEALTH_INTERVAL_MS,
    TELEGRAM_HOURLY_INTERVAL_MS,
};
