'use strict';

/** Календарная неделя по умолчанию. KIS от anchor date отдаёт ~14 дней — см. extendedWeek. */
const WEEK_DAYS = 7;
const KIS_EXTENDED_WEEK_MAX_DAYS = 21;

const db = require('./fusionloom_db');
const { normalizeRoomType, formatAuditoryDisplayName } = require('./normalize/auditories');
const { formatTeacherDisplayName } = require('./normalize/teachers');
const { normalizeSubgroup } = require('./fuse');
const registry = require('./registry');

function getStudentSchedule(groupName, date, subgroup = null) {
    const groupId = db.getGroupIdForRead(groupName);
    if (!groupId) return null;

    const meta = db.getScheduleMeta('group', groupName, date);
    if (meta && meta.no_lessons === 1) {
        return {
            [date]: {
                date: db.formatDateDisplay(date),
                dayOfWeek: db.getDayOfWeek(date),
                lessons: [{ status: 'Нет пар' }]
            }
        };
    }

    const rows = db.getStudentLessonRows(groupId, date);
    if (rows.length === 0) return null;

    const lessons = rows.map(r => {
        if (subgroup !== undefined && subgroup !== null && r.subgroup
            && normalizeSubgroup(r.subgroup) !== normalizeSubgroup(subgroup)) return null;
        const auditory = formatAuditoryDisplayName(r.auditory_name);
        return {
            time: `${r.time_start}-${r.time_end}`,
            type: (r.lesson_type != null ? String(r.lesson_type) : ''),
            name: (r.subject_name != null ? String(r.subject_name) : ''),
            subgroup: (r.subgroup != null ? String(r.subgroup) : ''),
            groups: [r.group_name],
            auditory,
            room: auditory,
            teacher: formatTeacherDisplayName(r.teacher_name)
        };
    }).filter(Boolean);

    return {
        [date]: {
            date: db.formatDateDisplay(date),
            dayOfWeek: db.getDayOfWeek(date),
            lessons
        }
    };
}

function getTeacherSchedule(teacherName, date) {
    const teacherId = db.getTeacherIdForRead(teacherName);
    if (!teacherId) return null;

    const meta = db.getScheduleMeta('teacher', teacherName, date);
    if (meta && meta.no_lessons === 1) {
        return {
            [date]: {
                date: db.formatDateDisplay(date),
                dayOfWeek: db.getDayOfWeek(date),
                lessons: [{ status: 'Нет пар' }]
            }
        };
    }

    const rows = db.getTeacherLessonRows(teacherId, date);
    if (rows.length === 0) return null;

    const bySlot = {};
    rows.forEach(r => {
        const time = `${r.time_start}-${r.time_end}`;
        const slotKey = `${time}|${normalizeSubgroup(r.subgroup)}`;
        const auditory = formatAuditoryDisplayName(r.auditory_name);
        if (!bySlot[slotKey]) {
            bySlot[slotKey] = { time, subject: r.subject_name || '', groups: [], auditory, room: auditory, subgroup: r.subgroup || null };
        }
        if (r.group_name && !bySlot[slotKey].groups.includes(r.group_name)) bySlot[slotKey].groups.push(r.group_name);
    });
    const lessons = Object.values(bySlot).map(o => ({
        time: o.time,
        subject: o.subject,
        group: o.groups.join(', '),
        groups: o.groups.length ? o.groups : undefined,
        auditory: o.auditory,
        room: o.room,
        subgroup: o.subgroup || null
    }));

    return {
        [date]: {
            date: db.formatDateDisplay(date),
            dayOfWeek: db.getDayOfWeek(date),
            lessons
        }
    };
}

function getAuditorySchedule(auditoryName, date) {
    const canonical = registry.getCanonicalAuditoryName(auditoryName);
    const auditoryId = db.resolveAuditoryIdForRead(canonical);
    if (!auditoryId) return null;

    const meta = db.getScheduleMeta('auditory', canonical, date);
    if (meta && meta.no_lessons === 1) {
        return {
            [date]: {
                date: db.formatDateDisplay(date),
                dayOfWeek: db.getDayOfWeek(date),
                lessons: [{ status: 'Нет пар' }]
            }
        };
    }

    const rows = db.getAuditoryLessonRows(auditoryId, date);
    if (rows.length === 0) return null;

    const bySlot = {};
    rows.forEach(r => {
        const time = `${r.time_start}-${r.time_end}`;
        const slotKey = `${time}|${normalizeSubgroup(r.subgroup)}`;
        const auditory = formatAuditoryDisplayName(r.auditory_name);
        if (!bySlot[slotKey]) {
            bySlot[slotKey] = {
                time,
                subject: r.subject_name || '',
                groups: [],
                auditory,
                room: auditory,
                subgroup: r.subgroup || null,
                teacher: formatTeacherDisplayName(r.teacher_name)
            };
        }
        if (r.group_name && !bySlot[slotKey].groups.includes(r.group_name)) bySlot[slotKey].groups.push(r.group_name);
    });
    const lessons = Object.values(bySlot).map(o => ({
        time: o.time,
        subject: o.subject,
        group: o.groups.join(', '),
        groups: o.groups.length ? o.groups : undefined,
        auditory: o.auditory,
        room: o.room,
        subgroup: o.subgroup || null,
        teacher: o.teacher
    }));

    return {
        [date]: {
            date: db.formatDateDisplay(date),
            dayOfWeek: db.getDayOfWeek(date),
            lessons
        }
    };
}

function weekDateRange(baseDate, dayCount) {
    const dates = [];
    for (let i = 0; i < dayCount; i++) {
        const d = new Date(baseDate + 'T12:00:00');
        d.setDate(d.getDate() + i);
        dates.push(d.toISOString().split('T')[0]);
    }
    return dates;
}

function resolveWeekDates(entityType, entityKey, baseDate, opts = {}) {
    const maxDays = opts.maxDays ?? KIS_EXTENDED_WEEK_MAX_DAYS;
    if (opts.extended) {
        const known = db.getScheduleDatesFrom(entityType, entityKey, baseDate, maxDays);
        if (known.length) return known;
        return weekDateRange(baseDate, maxDays);
    }
    return weekDateRange(baseDate, WEEK_DAYS);
}

function collectWeekSchedule(getDayFn, dates) {
    const result = {};
    for (const dateStr of dates) {
        const dayData = getDayFn(dateStr);
        if (dayData && dayData[dateStr]) Object.assign(result, dayData);
    }
    return Object.keys(result).length ? result : null;
}

function getStudentScheduleWeek(groupName, baseDate, subgroup = null, opts = {}) {
    const dates = resolveWeekDates('group', groupName, baseDate, opts);
    return collectWeekSchedule((dateStr) => getStudentSchedule(groupName, dateStr, subgroup), dates);
}

function getTeacherScheduleWeek(teacherName, baseDate, opts = {}) {
    const dates = resolveWeekDates('teacher', teacherName, baseDate, opts);
    return collectWeekSchedule((dateStr) => getTeacherSchedule(teacherName, dateStr), dates);
}

function getAuditoryScheduleWeek(auditoryName, baseDate, opts = {}) {
    const dates = resolveWeekDates('auditory', auditoryName, baseDate, opts);
    return collectWeekSchedule((dateStr) => getAuditorySchedule(auditoryName, dateStr), dates);
}

function parseTimeRange(timeRange) {
    if (!timeRange || typeof timeRange !== 'string' || !timeRange.includes('-')) return null;
    const [start, end] = timeRange.split('-').map(s => s.trim());
    if (!start || !end) return null;
    return { start, end };
}

function getDynamicSlotsByDate(date, building = null) {
    return db.getDynamicSlotRows(date, building).map(r => `${r.time_start}-${r.time_end}`);
}

function getFreeAuditoriesBySlot(date, timeRange, building, roomType = null) {
    const parsed = parseTimeRange(timeRange);
    if (!parsed) return [];
    const buildingFilter = String(building ?? '').trim().toUpperCase();
    if (!buildingFilter) return [];
    const typeFilter = roomType ? normalizeRoomType(roomType) : null;
    const allRooms = db.getAuditoriesByBuilding(buildingFilter, typeFilter);
    if (!allRooms.length) return [];
    const occupiedIds = new Set(db.getOccupiedAuditoryIds(date, buildingFilter, parsed.end, parsed.start, typeFilter));
    return allRooms
        .filter(r => !occupiedIds.has(r.id))
        .map(r => ({
            id: r.id,
            rawName: formatAuditoryDisplayName(r.rawName),
            roomNumber: r.roomNumber,
            roomType: r.roomType,
            building: r.building
        }));
}

function getFreeSlotsByAuditory(date, auditoryQuery, building = null) {
    const room = db.findAuditoryByQuery(auditoryQuery, building);
    if (!room) return null;
    const slots = getDynamicSlotsByDate(date, room.building);
    const occupied = db.getAuditoryOccupiedSlots(room.id, date).map(r => `${r.time_start}-${r.time_end}`);
    const occupiedSet = new Set(occupied);
    return {
        auditory: {
            id: room.id,
            rawName: room.rawName,
            roomNumber: room.roomNumber,
            roomType: room.roomType,
            building: room.building
        },
        freeSlots: slots.filter(s => !occupiedSet.has(s)),
        occupiedSlots: slots.filter(s => occupiedSet.has(s))
    };
}

function getScheduleMaxCreatedAtMinForWeek(entityType, entityKey, baseDate, opts = {}) {
    const dates = resolveWeekDates(entityType, entityKey, baseDate, opts);
    let minTs = null;
    for (const dateStr of dates) {
        const ts = db.getScheduleMaxCreatedAt(entityType, entityKey, dateStr);
        if (ts == null) return null;
        if (minTs == null || ts < minTs) minTs = ts;
    }
    return minTs;
}

module.exports = {
    getStudentSchedule,
    getTeacherSchedule,
    getAuditorySchedule,
    getStudentScheduleWeek,
    getTeacherScheduleWeek,
    getAuditoryScheduleWeek,
    getDynamicSlotsByDate,
    getFreeAuditoriesBySlot,
    getFreeSlotsByAuditory,
    getNormalizedBuildings: () => db.getNormalizedBuildingsList(),
    getNormalizedAuditories: (building) => db.getNormalizedAuditoriesList(building),
    getNormalizedRoomTypes: (building) => db.getNormalizedRoomTypesList(building),
    getGroupTeachersAndSubjectsRows: (group) => db.getGroupTeachersAndSubjectsRows(group),
    getScheduleMaxCreatedAt: (entityType, entityKey, date) => db.getScheduleMaxCreatedAt(entityType, entityKey, date),
    getScheduleMaxCreatedAtMinForWeek,
    bumpScheduleCreatedAt: (entityType, entityKey, date) => db.bumpScheduleCreatedAt(entityType, entityKey, date)
};
