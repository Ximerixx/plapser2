'use strict';

const { groupCanonicalKey } = require('./groups');
const { teacherCanonicalKey, formatTeacherDisplayName } = require('./teachers');
const { kisAuditoryQueryName } = require('./auditories');

/** Найти точное имя из списка KIS по canonical key. */
function resolveKisListName(name, list, keyFn) {
    const raw = String(name ?? '').trim();
    if (!raw) return '';
    if (!Array.isArray(list) || list.length === 0) return raw;
    if (list.includes(raw)) return raw;
    const key = keyFn(raw);
    if (!key) return raw;
    const found = list.find((item) => keyFn(item) === key);
    return found || raw;
}

/** KIS принимает только точный регистр из списка; fallback — upper case. */
function kisGroupQueryName(name, groupsList = null) {
    const raw = String(name ?? '').trim();
    if (!raw) return '';
    if (groupsList?.length) {
        const resolved = resolveKisListName(raw, groupsList, groupCanonicalKey);
        if (resolved !== raw || groupsList.includes(raw)) return resolved;
    }
    return raw.toUpperCase();
}

/** KIS принимает только точный регистр из списка преподавателей. */
function kisTeacherQueryName(name, teachersList = null) {
    const raw = String(name ?? '').trim();
    if (!raw) return '';
    if (teachersList?.length) {
        const resolved = resolveKisListName(raw, teachersList, teacherCanonicalKey);
        if (resolved) return resolved;
    }
    return formatTeacherDisplayName(raw);
}

module.exports = {
    resolveKisListName,
    kisGroupQueryName,
    kisTeacherQueryName,
    kisAuditoryQueryName
};
