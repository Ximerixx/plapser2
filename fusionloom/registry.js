'use strict';

const db = require('./fusionloom_db');
const { parseGroupName, groupCanonicalKey, groupDisplayName } = require('./normalize/groups');
const { normalizeTeacherName, teacherCanonicalKey } = require('./normalize/teachers');
const { subjectCanonicalKey, subjectDisplayName } = require('./normalize/subjects');
const { parseAuditoryParts, formatAuditoryName } = require('./normalize/auditories');

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
    const raw = formatAuditoryName(rawName);
    if (!raw) return null;
    const existing = db.findAuditoryIdByAlias(raw);
    if (existing) return existing;
    const parts = parseAuditoryParts(raw);
    if (!parts.normalizedKey && !parts.rawName) return null;
    const existingCanon = db.findAuditoryByCanonicalKey(parts.normalizedKey);
    let auditoryId;
    if (existingCanon) {
        auditoryId = existingCanon.id;
    } else {
        auditoryId = db.upsertAuditoryCanon({
            displayName: parts.rawName || raw,
            canonicalKey: parts.normalizedKey || raw.toUpperCase(),
            roomNumber: parts.roomNumber,
            roomType: parts.roomType,
            building: parts.building
        });
    }
    db.upsertAuditoryAlias(auditoryId, raw, sourceCode);
    return auditoryId;
}

/** KIS/query key — сырой формат, не «Спортзал». */
function getCanonicalAuditoryName(name) {
    return formatAuditoryName(name);
}

module.exports = {
    PLACEHOLDER_GROUP,
    resolveGroup,
    resolveTeacher,
    resolveSubject,
    resolveAuditory,
    getCanonicalAuditoryName
};
