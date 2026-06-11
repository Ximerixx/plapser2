'use strict';

/**
 * Project config: config/plapser.json if present, then override with process.env.
 * config/plapser.json is gitignored; use config/plapser.example.json as a template.
 */
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, 'plapser.json');
const KIS_LEGACY_PATH = path.join(__dirname, 'kis.json');

function parseBool(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    const s = String(value).trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no') return false;
    return defaultValue;
}

function parseNum(value, defaultValue) {
    if (value === undefined || value === null || value === '') return defaultValue;
    const n = Number(value);
    return Number.isFinite(n) ? n : defaultValue;
}

function loadJsonFile(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn('[config] load', filePath, e.message);
        return {};
    }
}

function loadFileConfig() {
    const plapser = loadJsonFile(CONFIG_PATH);
    const kisLegacy = loadJsonFile(KIS_LEGACY_PATH);
    return { ...kisLegacy, ...plapser };
}

function loadPlapserConfig() {
    const file = loadFileConfig();

    const proxyUrl = process.env.KIS_PROXY ?? file.KIS_PROXY ?? null;

    return {
        server: {
            port: parseNum(process.env.PORT ?? file.PORT, 3000),
            timezone: process.env.TIMEZONE ?? file.TIMEZONE ?? 'Europe/Moscow',
            staticCacheMaxAgeSeconds: parseNum(
                process.env.STATIC_CACHE_MAX_AGE_SECONDS ?? file.STATIC_CACHE_MAX_AGE_SECONDS,
                3600
            ),
        },
        preload: {
            topDays: parseNum(process.env.PRELOAD_TOP_DAYS ?? file.PRELOAD_TOP_DAYS, 7),
            topLimit: parseNum(process.env.PRELOAD_TOP_LIMIT ?? file.PRELOAD_TOP_LIMIT, 5),
            topRecalcIntervalMs: parseNum(
                process.env.TOP_RECALC_INTERVAL_MS ?? file.TOP_RECALC_INTERVAL_MS,
                30 * 60 * 1000
            ),
            intervalMs: parseNum(
                process.env.PRELOAD_INTERVAL_MS ?? file.PRELOAD_INTERVAL_MS,
                60 * 60 * 1000
            ),
        },
        warmup: {
            enabled: parseBool(
                process.env.NIGHTLY_WARMUP_ENABLED ?? file.NIGHTLY_WARMUP_ENABLED,
                true
            ),
            timezone: process.env.NIGHTLY_WARMUP_TIMEZONE
                ?? file.NIGHTLY_WARMUP_TIMEZONE
                ?? process.env.TIMEZONE
                ?? file.TIMEZONE
                ?? 'Europe/Moscow',
            delayMs: parseNum(
                process.env.NIGHTLY_WARMUP_DELAY_MS ?? file.NIGHTLY_WARMUP_DELAY_MS,
                1
            ),
            runOnStart: parseBool(
                process.env.NIGHTLY_WARMUP_RUN_ON_START ?? file.NIGHTLY_WARMUP_RUN_ON_START,
                false
            ),
        },
        kis: {
            proxyUrl: proxyUrl && String(proxyUrl).trim() ? String(proxyUrl).trim() : null,
            relayClientUserAgent: parseBool(
                process.env.KIS_RELAY_CLIENT_USER_AGENT ?? file.KIS_RELAY_CLIENT_USER_AGENT,
                false
            ),
            randomUserAgent: parseBool(
                process.env.KIS_RANDOM_USER_AGENT ?? file.KIS_RANDOM_USER_AGENT,
                false
            ),
            probeUrl: process.env.KIS_PROBE_URL
                ?? file.KIS_PROBE_URL
                ?? 'https://kis.vgltu.ru/list?type=Group',
            serverHealthIntervalMs: parseNum(
                process.env.KIS_SERVER_HEALTH_INTERVAL_MS ?? file.KIS_SERVER_HEALTH_INTERVAL_MS,
                60 * 60 * 1000
            ),
            proxyHealthIntervalMs: parseNum(
                process.env.KIS_PROXY_HEALTH_INTERVAL_MS ?? file.KIS_PROXY_HEALTH_INTERVAL_MS,
                60 * 1000
            ),
        },
    };
}

function loadKisConfig() {
    return loadPlapserConfig().kis;
}

module.exports = {
    loadPlapserConfig,
    loadKisConfig,
    CONFIG_PATH,
};
