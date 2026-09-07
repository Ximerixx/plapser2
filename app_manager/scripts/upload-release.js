#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

function usage() {
    console.error(`Usage: upload-release.js [options]

Environment:
  ORIGIN              Base URL (default: http://127.0.0.1:3000)
  KEY_ID              Key id (default: 1)
  PRIVATE_KEY_PATH    Path to Ed25519 private PEM (required)
  ZIP_PATH            Path to release.zip (default: release.zip)
`);
    process.exit(1);
}

function sha256HexFile(filePath) {
    const hash = crypto.createHash('sha256');
    const data = fs.readFileSync(filePath);
    hash.update(data);
    return hash.digest('hex');
}

function buildCanonical(keyId, timestamp, sha256hex) {
    return `${keyId}\n${timestamp}\n${sha256hex}`;
}

function requestText(url) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        lib.get(url, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: body.trim() }));
        }).on('error', reject);
    });
}

function uploadZip({ origin, keyId, privateKeyPath, zipPath }) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sha256hex = sha256HexFile(zipPath);
    const canonical = buildCanonical(keyId, timestamp, sha256hex);
    const privateKey = crypto.createPrivateKey(fs.readFileSync(privateKeyPath, 'utf8'));
    const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');
    const zipData = fs.readFileSync(zipPath);

    const url = new URL('/api/app/upload/android', origin);
    const lib = url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
        const req = lib.request(
            url,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/zip',
                    'Content-Length': zipData.length,
                    'X-App-Key-Id': keyId,
                    'X-App-Timestamp': timestamp,
                    'X-App-Signature': signature,
                },
            },
            (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    resolve({ status: res.statusCode, body });
                });
            }
        );
        req.on('error', reject);
        req.write(zipData);
        req.end();
    });
}

async function pollStatus(origin, intervalMs = 2000, timeoutMs = 600000) {
    const url = new URL('/api/app/upload/status', origin).toString();
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
        const { body } = await requestText(url);
        console.log(`status: ${body}`);
        if (body === 'done') return true;
        if (body.startsWith('error:')) return false;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    console.error('status poll timeout');
    return false;
}

async function main() {
    const origin = process.env.ORIGIN || 'http://127.0.0.1:3000';
    const keyId = process.env.KEY_ID || '1';
    const privateKeyPath = process.env.PRIVATE_KEY_PATH;
    const zipPath = process.env.ZIP_PATH || 'release.zip';

    if (!privateKeyPath) {
        console.error('PRIVATE_KEY_PATH is required');
        usage();
    }
    if (!fs.existsSync(zipPath)) {
        console.error(`ZIP not found: ${zipPath}`);
        process.exit(1);
    }
    if (!fs.existsSync(privateKeyPath)) {
        console.error(`Private key not found: ${privateKeyPath}`);
        process.exit(1);
    }

    console.log(`Uploading ${zipPath} to ${origin} (key ${keyId})`);
    const result = await uploadZip({ origin, keyId, privateKeyPath, zipPath });
    console.log(`HTTP ${result.status}: ${result.body}`);

    if (result.status < 200 || result.status >= 300) {
        process.exit(1);
    }

    const ok = await pollStatus(origin);
    process.exit(ok ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
