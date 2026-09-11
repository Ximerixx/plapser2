'use strict';

const db = require('./fusionloom_db');
const { parseGroupName, groupCanonicalKey, groupDisplayName } = require('./normalize/groups');
const { normalizeTeacherName, teacherCanonicalKey, formatTeacherDisplayName } = require('./normalize/teachers');
const { subjectCanonicalKey, subjectDisplayName } = require('./normalize/subjects');
const {
    parseAuditoryParts,
    formatAuditoryCanonical,
    cleanAuditoryLayout,
    kisAuditoryQueryName
} = require('./normalize/auditories');
const { kisGroupQueryName, kisTeacherQueryName } = require('./normalize/kis_query');

const PLACEHOLDER_GROUP = '—';

function resolveGroup(rawName, sourceCode = 'kis') {
    const raw = String(rawName ?? '').trim();
    if (!raw || raw === PLACEHOLDER_GROUP) return null;
    const existing = db.findGroupIdByAlias(raw);
    if (existing) return existing;
    const parsed = parseGroupName(raw);
    if (!parsed) return null;
    const canonicalKey = groupCanonicalKey(raw);
    const displayName = groupDisplayName(raw);
    const groupId = db.upsertGroupCanon({
        displayName,
        canonicalKey,
        specialty: parsed.specialty,
        admissionYear: parsed.admissionYear,
        groupIndex: parsed.groupIndex,
        form: parsed.form
    });
    db.upsertGroupAlias(groupId, raw, sourceCode);
    return groupId;
}

function resolveTeacher(rawName, sourceCode = 'kis') {
    const raw = String(rawName ?? '').trim();
    if (!raw) return null;
    const displayName = normalizeTeacherName(raw);
    const existing = db.findTeacherIdByAlias(raw);
    if (existing) return existing;
    const canonicalKey = teacherCanonicalKey(raw);
    const teacherId = db.upsertTeacherCanon({ displayName, canonicalKey });
    db.upsertTeacherAlias(teacherId, raw, sourceCode);
    return teacherId;
}

function resolveSubject(rawName, sourceCode = 'kis') {
    const raw = String(rawName ?? '').trim();
    if (!raw) return null;
    const displayName = subjectDisplayName(raw);
    const canonicalKey = subjectCanonicalKey(raw);
    const d = db.getDb();
    const aliasRow = d.prepare('SELECT subject_id FROM subject_aliases WHERE raw_name = ?').get(raw);
    if (aliasRow) return aliasRow.subject_id;
    const subjectId = db.upsertSubjectCanon({ displayName, canonicalKey });
    db.upsertSubjectAlias(subjectId, raw, sourceCode);
    return subjectId;
}

function resolveAuditory(rawName, sourceCode = 'kis') {
    const kisRaw = cleanAuditoryLayout(rawName);
    if (!kisRaw) return null;
    const parts = parseAuditoryParts(kisRaw);
    const existing = db.findAuditoryIdByAlias(kisRaw)
        || (parts.normalizedKey ? db.findAuditoryIdByCanonicalKey(parts.normalizedKey) : null);
    if (existing) {
        db.upsertAuditoryAlias(existing, kisRaw, sourceCode);
        const canonical = formatAuditoryCanonical(kisRaw);
        if (canonical !== kisRaw) db.upsertAuditoryAlias(existing, canonical, 'canonical');
        return existing;
    }
    if (!parts.normalizedKey && !parts.rawName) return null;
    const existingCanon = db.findAuditoryByCanonicalKey(parts.normalizedKey);
    let auditoryId;
    if (existingCanon) {
        auditoryId = existingCanon.id;
    } else {
        auditoryId = db.upsertAuditoryCanon({
            displayName: parts.rawName || formatAuditoryCanonical(kisRaw),
            canonicalKey: parts.normalizedKey || formatAuditoryCanonical(kisRaw).toUpperCase(),
            roomNumber: parts.roomNumber,
            roomType: parts.roomType,
            building: parts.building
        });
    }
    db.upsertAuditoryAlias(auditoryId, kisRaw, sourceCode);
    const canonical = formatAuditoryCanonical(kisRaw);
    if (canonical !== kisRaw) db.upsertAuditoryAlias(auditoryId, canonical, 'canonical');
    return auditoryId;
}

/** Канонический ключ для кэша/чтения — не «Спортзал», корпус в верхнем регистре. */
function getCanonicalAuditoryName(name) {
    return formatAuditoryCanonical(name);
}

function getKisGroupName(name) {
    const layout = groupDisplayName(name);
    if (!layout) return '';
    let id = db.findGroupIdByAlias(layout) || db.findGroupIdByCanonicalKey(layout);
    if (id) {
        const kisAlias = db.findGroupAliasBySource(id, 'kis');
        if (kisAlias) return kisAlias;
    }
    return kisGroupQueryName(layout);
}

function getKisTeacherName(name) {
    const layout = String(name ?? '').trim();
    if (!layout) return '';
    let id = db.findTeacherIdByAlias(layout) || db.findTeacherIdByCanonicalKey(layout);
    if (id) {
        const kisAlias = db.findTeacherAliasBySource(id, 'kis');
        if (kisAlias) return kisAlias;
    }
    return kisTeacherQueryName(layout);
}

function getCanonicalTeacherName(name) {
    return formatTeacherDisplayName(getKisTeacherName(name) || name);
}

/** Точное имя для запроса к KIS (регистр как в их списке). */
function getKisAuditoryName(name) {
    const layout = cleanAuditoryLayout(name);
    if (!layout) return '';
    let id = db.findAuditoryIdByAlias(layout);
    if (!id) {
        const parts = parseAuditoryParts(layout);
        if (parts.normalizedKey) id = db.findAuditoryIdByCanonicalKey(parts.normalizedKey);
    }
    if (id) {
        const kisAlias = db.findAuditoryAliasBySource(id, 'kis');
        if (kisAlias) return kisAuditoryQueryName(kisAlias);
    }
    return kisAuditoryQueryName(layout);
}

module.exports = {
    PLACEHOLDER_GROUP,
    resolveGroup,
    resolveTeacher,
    resolveSubject,
    resolveAuditory,
    getCanonicalAuditoryName,
    getKisAuditoryName,
    getKisGroupName,
    getKisTeacherName,
    getCanonicalTeacherName
};
