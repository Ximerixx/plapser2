'use strict';

const db = require('./fusionloom_db');
const registry = require('./registry');
const { parseGroupName } = require('./normalize/groups');

/** «1 п.г.» и «1» → «1» для fusion_key и фильтрации. */
function normalizeSubgroup(subgroup) {
    if (subgroup == null || subgroup === '') return '';
    const s = String(subgroup).trim();
    const m = s.match(/^(\d+)/);
    if (m) return m[1];
    return s.replace(/\s*п\.?\s*г\.?/gi, '').trim();
}

function buildFusionKey(date, timeStart, timeEnd, subjectId, auditoryId, subgroup) {
    const sg = normalizeSubgroup(subgroup);
    return `${date}|${timeStart}|${timeEnd}|${subjectId || ''}|${auditoryId || ''}|${sg}`;
}

function parseLessonTime(lesson) {
    if (!lesson?.time || !lesson.time.includes('-')) return null;
    const [timeStart, timeEnd] = lesson.time.split('-').map(s => s.trim());
    if (!timeStart || !timeEnd) return null;
    return { timeStart, timeEnd };
}

function extractLessonFields(lesson, viewType, viewKey) {
    const subjectRaw = lesson.name || lesson.subject || '';
    let teacherRaw = lesson.teacher || '';
    let auditoryRaw = lesson.auditory || lesson.room || lesson.classroom || '';
    if (!teacherRaw && viewType === 'teacher' && viewKey) teacherRaw = viewKey;
    if (!auditoryRaw && viewType === 'auditory' && viewKey) auditoryRaw = viewKey;
    let groups = [];
    if (lesson.groups && Array.isArray(lesson.groups)) groups = lesson.groups;
    else if (lesson.group) groups = [lesson.group];

    const subgroup = lesson.subgroup != null ? normalizeSubgroup(lesson.subgroup) : '';

    return {
        subjectRaw: String(subjectRaw).trim(),
        teacherRaw: String(teacherRaw).trim(),
        auditoryRaw: String(auditoryRaw).trim(),
        groups: groups.map(g => String(g).trim()).filter(Boolean),
        lessonType: lesson.type || null,
        subgroup: subgroup || null
    };
}

function mergeLessonObservation(batchId, date, lesson, viewType, viewKey) {
    if (lesson.status === 'Нет пар') return null;
    const times = parseLessonTime(lesson);
    if (!times) return null;

    const fields = extractLessonFields(lesson, viewType, viewKey);
    const subjectId = fields.subjectRaw ? registry.resolveSubject(fields.subjectRaw) : null;
    const auditoryId = fields.auditoryRaw ? registry.resolveAuditory(fields.auditoryRaw) : null;
    const teacherId = fields.teacherRaw ? registry.resolveTeacher(fields.teacherRaw) : null;

    const fusionKey = buildFusionKey(
        date, times.timeStart, times.timeEnd, subjectId, auditoryId, fields.subgroup
    );
    let lessonId;
    let existing = db.findLessonByFusionKey(date, times.timeStart, times.timeEnd, fusionKey);
    if (!existing && !fields.subgroup) {
        existing = db.findLessonBySlotCanon(
            date, times.timeStart, times.timeEnd, subjectId, auditoryId
        );
    }

    if (existing) {
        lessonId = existing.id;
        if (subjectId && existing.subject_id && existing.subject_id !== subjectId) {
            db.decrementLessonConfidence(lessonId);
            db.updateBatchStatus(batchId, 'conflict');
        }
        db.touchLesson(lessonId);
        db.updateLessonFields(lessonId, {
            lessonType: fields.lessonType,
            subgroup: fields.subgroup,
            subjectId
        });
    } else {
        lessonId = db.createLesson({
            date,
            timeStart: times.timeStart,
            timeEnd: times.timeEnd,
            subjectId,
            lessonType: fields.lessonType,
            subgroup: fields.subgroup,
            fusionKey
        });
    }

    if (viewType === 'group' && viewKey) {
        const gid = registry.resolveGroup(viewKey);
        if (gid) db.linkLessonGroup(lessonId, gid);
    }
    for (const g of fields.groups) {
        if (!parseGroupName(g)) continue;
        const gid = registry.resolveGroup(g);
        if (gid) db.linkLessonGroup(lessonId, gid);
    }
    if (teacherId) db.linkLessonTeacher(lessonId, teacherId);
    if (auditoryId) db.linkLessonAuditory(lessonId, auditoryId);

    db.linkLessonIngest(lessonId, batchId);
    db.incrementBatchLessonsSeen(batchId);
    return lessonId;
}

module.exports = {
    normalizeSubgroup,
    buildFusionKey,
    mergeLessonObservation
};
