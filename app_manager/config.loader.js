'use strict';

const path = require('path');
const fs = require('fs');

const APP_MANAGER_ROOT = __dirname;
const CONFIG_PATH = path.join(APP_MANAGER_ROOT, 'config.json');

const DEFAULT_ROUTES = {
    current: '/api/app/current',
    uploadAndroid: '/api/app/upload/android',
    uploadStatus: '/api/app/upload/status',
    staticAndroid: '/api/app/android',
};

function parseNum(value, defaultValue) {
    if (value === undefined || value === null || value === '') return defaultValue;
    const n = Number(value);
    return Number.isFinite(n) ? n : defaultValue;
}

function loadJsonFile(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn('[app_manager] config load:', e.message);
        return {};
    }
}

function resolveKeyPath(keyPath) {
    if (!keyPath) return null;
    if (path.isAbsolute(keyPath)) return keyPath;
    return path.join(APP_MANAGER_ROOT, keyPath);
}

function loadUploadKeys(file) {
    const keys = {};
    const fromFile = file.UPLOAD_KEYS && typeof file.UPLOAD_KEYS === 'object' ? file.UPLOAD_KEYS : {};

    for (const [keyId, keyCfg] of Object.entries(fromFile)) {
        const envPath = process.env[`APP_MANAGER_UPLOAD_KEY_${keyId}_PATH`];
        const publicKeyPath = resolveKeyPath(envPath ?? keyCfg?.publicKeyPath);
        if (publicKeyPath) {
            keys[String(keyId)] = { publicKeyPath };
        }
    }

    return keys;
}

function loadAppManagerConfig() {
    const file = loadJsonFile(CONFIG_PATH);

    return {
        root: APP_MANAGER_ROOT,
        dataDir: path.join(APP_MANAGER_ROOT, 'data'),
        tempDir: path.join(APP_MANAGER_ROOT, 'data', 'temp'),
        androidDir: path.join(APP_MANAGER_ROOT, 'data', 'app', 'android'),
        uploadKeys: loadUploadKeys(file),
        timestampToleranceSec: parseNum(
            process.env.APP_MANAGER_TIMESTAMP_TOLERANCE_SEC ?? file.TIMESTAMP_TOLERANCE_SEC,
            300
        ),
        uploadMaxMb: parseNum(process.env.APP_MANAGER_UPLOAD_MAX_MB ?? file.UPLOAD_MAX_MB, 150),
        statusDoneTtlMs: parseNum(process.env.APP_MANAGER_STATUS_DONE_TTL_MS ?? file.STATUS_DONE_TTL_MS, 300000),
        routes: {
            current: process.env.APP_MANAGER_ROUTE_CURRENT ?? file.ROUTES?.current ?? DEFAULT_ROUTES.current,
            uploadAndroid:
                process.env.APP_MANAGER_ROUTE_UPLOAD_ANDROID
                ?? file.ROUTES?.uploadAndroid
                ?? DEFAULT_ROUTES.uploadAndroid,
            uploadStatus:
                process.env.APP_MANAGER_ROUTE_UPLOAD_STATUS
                ?? file.ROUTES?.uploadStatus
                ?? DEFAULT_ROUTES.uploadStatus,
            staticAndroid:
                process.env.APP_MANAGER_ROUTE_STATIC_ANDROID
                ?? file.ROUTES?.staticAndroid
                ?? DEFAULT_ROUTES.staticAndroid,
        },
    };
}

module.exports = {
    loadAppManagerConfig,
    CONFIG_PATH,
    APP_MANAGER_ROOT,
};
