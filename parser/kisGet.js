'use strict';

/**
 * HTTP-клиент для kis.vgltu.ru: User-Agent, axios-запросы, retry при ошибках прокси,
 * health-check ответов самого KIS-сервера.
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
let serverHealthCheckStarted = false;

function ensureInit() {
    if (kisConfig !== null) return;
    try {
        const { loadKisConfig } = require('../config/loader');
        initKisFetch(loadKisConfig());
    } catch (_) {
        initKisFetch({});
    }
}

function initKisFetch(config) {
    kisConfig = config || {
        proxyUrl: null,
        relayClientUserAgent: false,
        randomUserAgent: false,
        probeUrl: 'https://kis.vgltu.ru/list?type=Group',
        serverHealthIntervalMs: 60 * 60 * 1000,
        proxyHealthIntervalMs: 60 * 1000,
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

function userAgentForProbe() {
    return resolveKisUserAgent(null) || pickRandomUserAgent() || undefined;
}

function isProxyTransportError(err) {
    if (!err) return false;
    if (PROXY_ERROR_CODES.has(err.code)) return true;
    const msg = String(err.message || '').toLowerCase();
    return msg.includes('proxy') || msg.includes('socks') || msg.includes('tunnel');
}

function isKisResponseOk(status) {
    return status >= 200 && status < 400;
}

function logBadKisResponse(url, status) {
    if (status === 404) {
        console.warn(
            '[kis] KIS вернул 404 для',
            url,
            '— возможна блокировка User-Agent; включите KIS_RANDOM_USER_AGENT или KIS_RELAY_CLIENT_USER_AGENT'
        );
    } else {
        console.warn('[kis] KIS вернул некорректный статус', status, 'для', url);
    }
}

function buildAxiosConfig(userAgent, validateStatus) {
    const cfg = {
        timeout: 10000,
        validateStatus: validateStatus || ((status) => status >= 200 && status < 300),
        maxRedirects: 5,
    };
    if (userAgent) {
        cfg.headers = { 'User-Agent': userAgent };
    }
    applyKisProxyToAxiosConfig(cfg);
    return cfg;
}

async function probeKisServerResponse(timeoutMs = 12000) {
    ensureInit();
    const url = kisConfig.probeUrl;
    const cfg = buildAxiosConfig(userAgentForProbe(), () => true);
    cfg.timeout = timeoutMs;
    try {
        const res = await axios.get(url, cfg);
        return { ok: isKisResponseOk(res.status), status: res.status, url };
    } catch (err) {
        const status = err.response?.status;
        return {
            ok: false,
            status,
            url,
            error: err.message,
        };
    }
}

async function startKisServerHealthCheck(config) {
    if (serverHealthCheckStarted) return;
    serverHealthCheckStarted = true;

    if (config) initKisFetch(config);

    const intervalMs = kisConfig?.serverHealthIntervalMs ?? 60 * 60 * 1000;

    const runProbe = async (label) => {
        const result = await probeKisServerResponse(label === 'startup' ? 12000 : 15000);
        if (!result.ok) {
            const detail = result.status != null
                ? `status=${result.status}`
                : (result.error || 'unknown error');
            console.warn(
                `[kis] проверка ответа KIS (${label}): сервер недоступен или ответ некорректен (${detail})`
            );
        }
        return result;
    };

    await runProbe('startup');

    setInterval(() => {
        runProbe('periodic').catch(() => { });
    }, intervalMs);
}

async function kisGet(url, opts = null) {
    ensureInit();
    const userAgent = resolveKisUserAgent(opts);
    const cfg = buildAxiosConfig(userAgent);
    try {
        const response = await axios.get(url, cfg);
        return response;
    } catch (err) {
        if (err.response && !isKisResponseOk(err.response.status)) {
            logBadKisResponse(url, err.response.status);
        }
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
    probeKisServerResponse,
    startKisServerHealthCheck,
};
