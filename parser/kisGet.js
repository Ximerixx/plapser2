'use strict';

/**
 * HTTP-клиент для kis.vgltu.ru: User-Agent, axios-запросы, retry при ошибках прокси.
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const {
    applyKisProxyToAxiosConfig,
    recreateKisProxyAgent,
    isKisProxyEnabled,
    initKisProxy,
} = require('../kisproxifier');

const USER_AGENTS_PATH = path.join(__dirname, '..', 'config', 'user-agents.json');
const MAX_RELAY_UA_LENGTH = 512;

const PROXY_ERROR_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

let kisConfig = null;
let userAgentsCache = null;

function ensureInit() {
    if (kisConfig !== null) return;
    try {
        const { loadKisConfig } = require('../config/kis.loader');
        const cfg = loadKisConfig();
        initKisFetch(cfg);
    } catch (_) {
        initKisFetch({});
    }
}

function initKisFetch(config) {
    kisConfig = config || {
        proxyUrl: null,
        relayClientUserAgent: false,
        randomUserAgent: false,
    };
    initKisProxy(kisConfig);
}

function loadUserAgents() {
    if (userAgentsCache) return userAgentsCache;
    try {
        const raw = fs.readFileSync(USER_AGENTS_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed?.userAgents)
            ? parsed.userAgents.filter((ua) => typeof ua === 'string' && ua.trim() !== '')
            : [];
        if (list.length === 0) {
            console.warn('[kis] user-agents.json пуст или некорректен');
            userAgentsCache = [];
        } else {
            userAgentsCache = list;
        }
    } catch (e) {
        console.warn('[kis] failed to load user-agents.json:', e.message);
        userAgentsCache = [];
    }
    return userAgentsCache;
}

function pickRandomUserAgent() {
    const list = loadUserAgents();
    if (list.length === 0) return null;
    return list[Math.floor(Math.random() * list.length)];
}

function sanitizeRelayUserAgent(ua) {
    if (!ua || typeof ua !== 'string') return null;
    const trimmed = ua.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
    if (!trimmed) return null;
    return trimmed.length > MAX_RELAY_UA_LENGTH
        ? trimmed.slice(0, MAX_RELAY_UA_LENGTH)
        : trimmed;
}

function isBlockedRelayUserAgent(ua) {
    if (!ua || typeof ua !== 'string') return true;
    const s = ua.trim();
    if (!s) return true;
    if (/axios\//i.test(s)) return true;
    if (s.startsWith('PlapserWarmup/')) return true;
    return false;
}

function resolveKisUserAgent(opts) {
    ensureInit();
    const randomEnabled = kisConfig?.randomUserAgent === true;
    const relayEnabled = kisConfig?.relayClientUserAgent === true;

    if (randomEnabled) {
        const picked = pickRandomUserAgent();
        if (picked) return picked;
    }

    if (relayEnabled) {
        if (opts?.ip === 'telegram') {
            const picked = pickRandomUserAgent();
            if (picked) return picked;
        } else if (opts?.userAgent && !isBlockedRelayUserAgent(opts.userAgent)) {
            const sanitized = sanitizeRelayUserAgent(opts.userAgent);
            if (sanitized) return sanitized;
        }
        const picked = pickRandomUserAgent();
        if (picked) return picked;
    }

    return undefined;
}

function isProxyTransportError(err) {
    if (!err) return false;
    if (PROXY_ERROR_CODES.has(err.code)) return true;
    const msg = String(err.message || '').toLowerCase();
    return msg.includes('proxy') || msg.includes('socks') || msg.includes('tunnel');
}

function buildAxiosConfig(userAgent) {
    const cfg = {
        timeout: 10000,
        validateStatus: (status) => status >= 200 && status < 300,
        maxRedirects: 5,
    };
    if (userAgent) {
        cfg.headers = { 'User-Agent': userAgent };
    }
    applyKisProxyToAxiosConfig(cfg);
    return cfg;
}

async function kisGet(url, opts = null) {
    ensureInit();
    const userAgent = resolveKisUserAgent(opts);
    const cfg = buildAxiosConfig(userAgent);
    try {
        return await axios.get(url, cfg);
    } catch (err) {
        if (isKisProxyEnabled() && isProxyTransportError(err)) {
            recreateKisProxyAgent();
            return await axios.get(url, buildAxiosConfig(userAgent));
        }
        throw err;
    }
}

module.exports = {
    initKisFetch,
    kisGet,
    resolveKisUserAgent,
    pickRandomUserAgent,
    loadUserAgents,
};
