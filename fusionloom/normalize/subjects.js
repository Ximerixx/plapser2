'use strict';

function normalizeSubjectPrefix(str) {
    if (str == null || typeof str !== 'string') return str;
    const s = str.trim();
    const m = s.match(/^(лаб|лек|пр)\.?\s*/i);
    if (!m) return str;
    const norm = m[1].toLowerCase() + '.';
    const rest = s.slice(m[0].length).trim();
    return rest ? norm + ' ' + rest : norm;
}

function subjectCanonicalKey(rawName) {
    const n = normalizeSubjectPrefix(String(rawName ?? '').trim());
    return n.toLowerCase();
}

function subjectDisplayName(rawName) {
    return normalizeSubjectPrefix(String(rawName ?? '').trim());
}

module.exports = {
    normalizeSubjectPrefix,
    subjectCanonicalKey,
    subjectDisplayName
};
