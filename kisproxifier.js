'use strict';

/**
 * KIS proxy: agent factory, probe, health-check.
 * Отдельно от tgbot/TELEGRAM_PROXY.
 */
const axios = require('axios');

const KIS_PROBE_URL =
    process.env.KIS_PROBE_URL || 'https://kis.vgltu.ru/list?type=Group';
const KIS_PROXY_HEALTH_INTERVAL_MS = Number(
    process.env.KIS_PROXY_HEALTH_INTERVAL_MS || 60 * 1000
);

let proxyUrlConfigured = null;
let proxyAgent = null;
let healthCheckStarted = false;

function createKisProxyAgent(proxyUrl) {
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
            '[kis] unsupported proxy protocol:',
            protocol,
            '- use http, https, socks4, or socks5'
        );
        return null;
    } catch (e) {
        console.warn('[kis] proxy URL parse failed:', e.message);
        return null;
    }
}

function initKisProxy(config) {
    proxyUrlConfigured = config?.proxyUrl || null;
    proxyAgent = proxyUrlConfigured
        ? createKisProxyAgent(proxyUrlConfigured)
        : null;
    if (proxyUrlConfigured && !proxyAgent) {
        console.warn('[kis] KIS_PROXY задан, но URL не распознан');
    }
}

function isKisProxyEnabled() {
    return !!proxyUrlConfigured && !!proxyAgent;
}

function getKisProxyAgent() {
    return proxyAgent;
}

function recreateKisProxyAgent() {
    if (!proxyUrlConfigured) {
        proxyAgent = null;
        return null;
    }
    proxyAgent = createKisProxyAgent(proxyUrlConfigured);
    return proxyAgent;
}

function applyKisProxyToAxiosConfig(cfg) {
    const agent = getKisProxyAgent();
    if (agent) {
        cfg.httpsAgent = agent;
        cfg.httpAgent = agent;
        cfg.proxy = false;
    }
    return cfg;
}

async function probeKisReachable(agent, timeoutMs = 12000) {
    try {
        const cfg = {
            timeout: timeoutMs,
            validateStatus: () => true,
            maxRedirects: 3,
        };
        if (agent) {
            cfg.httpsAgent = agent;
            cfg.httpAgent = agent;
            cfg.proxy = false;
        }
        await axios.get(KIS_PROBE_URL, cfg);
        return true;
    } catch (_) {
        return false;
    }
}

async function startKisProxyHealthCheck(config) {
    if (healthCheckStarted) return;
    healthCheckStarted = true;

    initKisProxy(config || {});

    if (!proxyUrlConfigured) return;

    if (!getKisProxyAgent()) {
        console.error(
            '[kis] KIS_PROXY задан, но URL не распознан. Используйте socks5://, socks4://, http:// или https://.'
        );
        return;
    }

    const viaProxyOk = await probeKisReachable(getKisProxyAgent(), 12000);
    if (!viaProxyOk) {
        console.error(
            '[kis] Через указанный KIS_PROXY не удаётся достучаться до kis.vgltu.ru. Проверьте, что прокси запущен и адрес верный.'
        );
    } else {
        console.log('[kis] using proxy for KIS requests');
    }

    setInterval(async () => {
        const ok = await probeKisReachable(getKisProxyAgent(), 8000);
        if (!ok) {
            console.warn(
                '[kis] прокси не ответил на проверку (интервал ' +
                    Math.round(KIS_PROXY_HEALTH_INTERVAL_MS / 1000) +
                    ' с), пересоздаём агент (SOCKS/HTTP)'
            );
            recreateKisProxyAgent();
        }
    }, KIS_PROXY_HEALTH_INTERVAL_MS);
}

module.exports = {
    initKisProxy,
    isKisProxyEnabled,
    getKisProxyAgent,
    recreateKisProxyAgent,
    applyKisProxyToAxiosConfig,
    probeKisReachable,
    startKisProxyHealthCheck,
    KIS_PROBE_URL,
    KIS_PROXY_HEALTH_INTERVAL_MS,
};
