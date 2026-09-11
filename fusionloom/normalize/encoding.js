'use strict';

const REPLACEMENT = '\uFFFD';

function hasReplacementChar(value) {
    return String(value ?? '').includes(REPLACEMENT);
}

function stripReplacementChars(value) {
    return String(value ?? '').replace(/\uFFFD/g, '');
}

function pickBestName(candidates) {
    const list = (candidates || []).map((v) => String(v ?? '').trim()).filter(Boolean);
    if (!list.length) return null;
    const clean = list.filter((n) => !hasReplacementChar(n));
    if (clean.length === 1) return clean[0];
    if (clean.length > 1) {
        const byKey = new Map();
        for (const name of clean) {
            const key = name.toLowerCase();
            if (!byKey.has(key)) byKey.set(key, name);
        }
        if (byKey.size === 1) return [...byKey.values()][0];
    }
    return clean[0] || list[0];
}

function decodeHtmlCharset(buffer, contentType = '') {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const head = buf.slice(0, 2048).toString('latin1');
    const ctMatch = String(contentType).match(/charset=([^;\s]+)/i);
    const metaMatch = head.match(/charset\s*=\s*["']?([^"'\s>]+)/i);
    let charset = (ctMatch?.[1] || metaMatch?.[1] || 'utf-8').toLowerCase();
    if (charset === 'utf8') charset = 'utf-8';
    if (charset === 'win-1251' || charset === 'windows-1251') charset = 'win1251';

    const tryDecode = (enc) => {
        try {
            if (enc === 'utf-8') return buf.toString('utf8');
            return buf.toString('utf8');
        } catch (_) {
            return null;
        }
    };

    let text = tryDecode(charset) || buf.toString('utf8');
    if (hasReplacementChar(text) && charset !== 'utf-8') {
        const utf8 = buf.toString('utf8');
        if (!hasReplacementChar(utf8)) text = utf8;
    }
    return text;
}

module.exports = {
    REPLACEMENT,
    hasReplacementChar,
    stripReplacementChars,
    pickBestName,
    decodeHtmlCharset
};
