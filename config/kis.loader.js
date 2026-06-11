'use strict';

/**
 * Load KIS HTTP client config: config/kis.json if present, then override with process.env.
 * config/kis.json is gitignored; use config/kis.example.json as a template.
 */
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, 'kis.json');

function parseBool(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    const s = String(value).trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no') return false;
    return defaultValue;
}

function loadKisConfig() {
    let file = {};
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        file = JSON.parse(raw);
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn('[kis] config load:', e.message);
    }
    const proxyUrl = process.env.KIS_PROXY ?? file.KIS_PROXY ?? null;
    return {
        proxyUrl: proxyUrl && String(proxyUrl).trim() ? String(proxyUrl).trim() : null,
        relayClientUserAgent: parseBool(
            process.env.KIS_RELAY_CLIENT_USER_AGENT ?? file.KIS_RELAY_CLIENT_USER_AGENT,
            false
        ),
        randomUserAgent: parseBool(
            process.env.KIS_RANDOM_USER_AGENT ?? file.KIS_RANDOM_USER_AGENT,
            false
        ),
    };
}

module.exports = { loadKisConfig, CONFIG_PATH };
