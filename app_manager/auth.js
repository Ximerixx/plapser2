'use strict';

const fs = require('fs');
const crypto = require('crypto');

const HEADER_KEY_ID = 'x-app-key-id';
const HEADER_TIMESTAMP = 'x-app-timestamp';
const HEADER_SIGNATURE = 'x-app-signature';

const publicKeyCache = new Map();

function loadPublicKey(keyId, keyPath) {
    const cacheKey = `${keyId}:${keyPath}`;
    if (publicKeyCache.has(cacheKey)) return publicKeyCache.get(cacheKey);

    const pem = fs.readFileSync(keyPath, 'utf8');
    const keyObject = crypto.createPublicKey(pem);
    publicKeyCache.set(cacheKey, keyObject);
    return keyObject;
}

function getRequiredHeaders(req) {
    const keyId = req.headers[HEADER_KEY_ID];
    const timestamp = req.headers[HEADER_TIMESTAMP];
    const signature = req.headers[HEADER_SIGNATURE];

    if (!keyId) {
        return { error: 'missing X-App-Key-Id header' };
    }
    if (!timestamp) {
        return { error: 'missing X-App-Timestamp header' };
    }
    if (!signature) {
        return { error: 'missing X-App-Signature header' };
    }

    return { keyId: String(keyId).trim(), timestamp: String(timestamp).trim(), signature: String(signature).trim() };
}

function validateHeaders(req, config) {
    const headers = getRequiredHeaders(req);
    if (headers.error) {
        return { ok: false, status: 401, message: headers.error };
    }

    const { keyId, timestamp } = headers;
    const keyCfg = config.uploadKeys[keyId];
    if (!keyCfg || !keyCfg.publicKeyPath) {
        return { ok: false, status: 403, message: `unknown key id ${keyId}` };
    }

    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || ts <= 0) {
        return { ok: false, status: 400, message: 'invalid timestamp' };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const delta = Math.abs(nowSec - ts);
    if (delta > config.timestampToleranceSec) {
        return { ok: false, status: 403, message: 'timestamp expired' };
    }

    return {
        ok: true,
        keyId,
        timestamp,
        signature: headers.signature,
        publicKeyPath: keyCfg.publicKeyPath,
        statusText: `verified key ${keyId}`,
    };
}

function sha256HexFile(filePath) {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

function buildCanonical(keyId, timestamp, sha256hex) {
    return `${keyId}\n${timestamp}\n${sha256hex}`;
}

async function verifySignatureFromFile(filePath, keyId, timestamp, signatureBase64, publicKeyPath) {
    const sha256hex = await sha256HexFile(filePath);
    const canonical = buildCanonical(keyId, timestamp, sha256hex);
    const publicKey = loadPublicKey(keyId, publicKeyPath);

    let signature;
    try {
        signature = Buffer.from(signatureBase64, 'base64');
    } catch (e) {
        return { ok: false, message: 'invalid signature encoding' };
    }

    const valid = crypto.verify(null, Buffer.from(canonical, 'utf8'), publicKey, signature);
    if (!valid) {
        return { ok: false, message: 'invalid signature' };
    }

    return { ok: true };
}

module.exports = {
    HEADER_KEY_ID,
    HEADER_TIMESTAMP,
    HEADER_SIGNATURE,
    validateHeaders,
    verifySignatureFromFile,
    buildCanonical,
    sha256HexFile,
};
