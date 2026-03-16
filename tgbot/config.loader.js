'use strict';

/**
 * Load tgbot config: from tgbot/config.json if present, then override with process.env.
 * config.json is gitignored; use config.example.json as a template.
 */
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULTS = {
    API_BASE_URL: 'http://127.0.0.1:3000'
};

function loadTgbotConfig() {
    let file = {};
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        file = JSON.parse(raw);
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn('[tgbot] config load:', e.message);
    }
    return {
        token: process.env.TELEGRAM_BOT_TOKEN ?? file.TELEGRAM_BOT_TOKEN ?? null,
        apiBaseUrl: process.env.API_BASE_URL ?? file.API_BASE_URL ?? DEFAULTS.API_BASE_URL,
        botUsername: process.env.TELEGRAM_BOT_USERNAME ?? file.TELEGRAM_BOT_USERNAME ?? null,
        proxyUrl: process.env.TELEGRAM_PROXY ?? file.TELEGRAM_PROXY ?? null
    };
}

module.exports = { loadTgbotConfig, CONFIG_PATH };
