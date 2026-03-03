'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'plapser.db');
let db = null;

const DAYS_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

function getDayOfWeek(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    return DAYS_RU[d.getDay()];
}

function getDb() {
    if (db) return db;
    db = new Database(DB_PATH);
    db.pragma('foreign_keys = ON');
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    db.exec(schema);
    return db;
}

function ensureGroup(name) {
    const d = getDb();
    let row = d.prepare('SELECT id FROM groups WHERE name = ?').get(name);
    if (row) return row.id;
    const result = d.prepare('INSERT INTO groups (name) VALUES (?)').run(name);
    return result.lastInsertRowid;
}

function ensureTeacher(name) {
    const d = getDb();
    let row = d.prepare('SELECT id FROM teachers WHERE name = ?').get(name);
    if (row) return row.id;
    const result = d.prepare('INSERT INTO teachers (name) VALUES (?)').run(name);
    return result.lastInsertRowid;
}

function ensureClassroom(name) {
    if (!name || name.trim() === '') return null;
    const d = getDb();
    let row = d.prepare('SELECT id FROM classrooms WHERE name = ?').get(name);
    if (row) return row.id;
    const result = d.prepare('INSERT INTO classrooms (name) VALUES (?)').run(name);
    return result.lastInsertRowid;
}

function ensureSubject(name) {
    if (!name || name.trim() === '') return null;
    const d = getDb();
    let row = d.prepare('SELECT id FROM subjects WHERE name = ?').get(name);
    if (row) return row.id;
    const result = d.prepare('INSERT INTO subjects (name) VALUES (?)').run(name);
    return result.lastInsertRowid;
}

function insertScheduleSlot(row) {
    const d = getDb();
    d.prepare(`
        INSERT INTO schedule_slots (date, time_start, time_end, group_id, teacher_id, subject_id, classroom_id, lesson_type, subgroup)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        row.date,
        row.time_start,
        row.time_end,
        row.group_id,
        row.teacher_id ?? null,
        row.subject_id ?? null,
        row.classroom_id ?? null,
        row.lesson_type ?? null,
        row.subgroup ?? null
    );
}

function insertScheduleMeta(entityType, entityKey, date, noLessons) {
    const d = getDb();
    d.prepare(`
        INSERT OR REPLACE INTO schedule_meta (entity_type, entity_key, date, no_lessons, created_at)
        VALUES (?, ?, ?, ?, unixepoch())
    `).run(entityType, entityKey, date, noLessons ? 1 : 0);
}

function insertRequestStats({ ip, userAgent, entityType, entityKey, processingTimeMs, type: responseType }) {
    const d = getDb();
    d.prepare(`
        INSERT INTO request_stats (ip, user_agent, entity_type, entity_key, requested_at, processing_time_ms, response_type)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(ip ?? null, userAgent ?? null, entityType, entityKey, Math.floor(Date.now() / 1000), processingTimeMs, responseType ?? null);
}

function getStudentSchedule(groupName, date, subgroup = null) {
    const d = getDb();
    const groupRow = d.prepare('SELECT id FROM groups WHERE name = ?').get(groupName);
    if (!groupRow) return null;

    const meta = d.prepare(
        'SELECT no_lessons FROM schedule_meta WHERE entity_type = ? AND entity_key = ? AND date = ?'
    ).get('group', groupName, date);
    if (meta && meta.no_lessons === 1) {
        const dayOfWeek = getDayOfWeek(date);
        const dateDisplay = formatDateDisplay(date);
        return {
            [date]: {
                date: dateDisplay,
                dayOfWeek,
                lessons: [{ status: 'Нет пар' }]
            }
        };
    }

    const rows = d.prepare(`
        SELECT s.date, s.time_start, s.time_end, s.lesson_type, s.subgroup,
               g.name AS group_name, t.name AS teacher_name, sub.name AS subject_name, c.name AS classroom_name
        FROM schedule_slots s
        JOIN groups g ON s.group_id = g.id
        LEFT JOIN teachers t ON s.teacher_id = t.id
        LEFT JOIN subjects sub ON s.subject_id = sub.id
        LEFT JOIN classrooms c ON s.classroom_id = c.id
        WHERE s.group_id = ? AND s.date = ?
        ORDER BY s.time_start
    `).all(groupRow.id, date);

    if (rows.length === 0) return null;

    const dayOfWeek = getDayOfWeek(date);
    const dateDisplay = formatDateDisplay(date);
    const lessons = rows.map(r => {
        if (subgroup !== undefined && subgroup !== null && r.subgroup && String(r.subgroup) !== String(subgroup)) return null;
        return {
            time: `${r.time_start}-${r.time_end}`,
            type: r.lesson_type || '',
            name: r.subject_name || '',
            subgroup: r.subgroup || '',
            groups: [r.group_name],
            classroom: r.classroom_name || '',
            teacher: r.teacher_name || ''
        };
    }).filter(Boolean);

    return {
        [date]: {
            date: dateDisplay,
            dayOfWeek,
            lessons
        }
    };
}

function getTeacherSchedule(teacherName, date) {
    const d = getDb();
    const teacherRow = d.prepare('SELECT id FROM teachers WHERE name = ?').get(teacherName);
    if (!teacherRow) return null;

    const meta = d.prepare(
        'SELECT no_lessons FROM schedule_meta WHERE entity_type = ? AND entity_key = ? AND date = ?'
    ).get('teacher', teacherName, date);
    if (meta && meta.no_lessons === 1) {
        const dayOfWeek = getDayOfWeek(date);
        const dateDisplay = formatDateDisplay(date);
        return {
            [date]: {
                date: dateDisplay,
                dayOfWeek,
                lessons: [{ status: 'Нет пар' }]
            }
        };
    }

    const rows = d.prepare(`
        SELECT s.date, s.time_start, s.time_end, s.subgroup,
               g.name AS group_name, sub.name AS subject_name, c.name AS classroom_name
        FROM schedule_slots s
        JOIN groups g ON s.group_id = g.id
        LEFT JOIN subjects sub ON s.subject_id = sub.id
        LEFT JOIN classrooms c ON s.classroom_id = c.id
        WHERE s.teacher_id = ? AND s.date = ?
        ORDER BY s.time_start, g.name
    `).all(teacherRow.id, date);

    if (rows.length === 0) return null;

    const dayOfWeek = getDayOfWeek(date);
    const dateDisplay = formatDateDisplay(date);
    const byTime = {};
    rows.forEach(r => {
        const time = `${r.time_start}-${r.time_end}`;
        if (!byTime[time]) {
            byTime[time] = { time, subject: r.subject_name || '', groups: [], room: r.classroom_name || '', subgroup: r.subgroup || null };
        }
        if (r.group_name && !byTime[time].groups.includes(r.group_name)) byTime[time].groups.push(r.group_name);
    });
    const lessons = Object.values(byTime).map(o => ({
        time: o.time,
        subject: o.subject,
        group: o.groups.join(', '),
        groups: o.groups.length ? o.groups : undefined,
        room: o.room,
        subgroup: o.subgroup || null
    }));

    return {
        [date]: {
            date: dateDisplay,
            dayOfWeek,
            lessons
        }
    };
}

function getStudentScheduleWeek(groupName, baseDate, subgroup = null) {
    const result = {};
    for (let i = 0; i < 7; i++) {
        const d = new Date(baseDate + 'T12:00:00');
        d.setDate(d.getDate() + i);
        const dateStr = d.toISOString().split('T')[0];
        const dayData = getStudentSchedule(groupName, dateStr, subgroup);
        if (dayData && dayData[dateStr]) Object.assign(result, dayData);
    }
    return Object.keys(result).length ? result : null;
}

function getTeacherScheduleWeek(teacherName, baseDate) {
    const result = {};
    for (let i = 0; i < 7; i++) {
        const d = new Date(baseDate + 'T12:00:00');
        d.setDate(d.getDate() + i);
        const dateStr = d.toISOString().split('T')[0];
        const dayData = getTeacherSchedule(teacherName, dateStr);
        if (dayData && dayData[dateStr]) Object.assign(result, dayData);
    }
    return Object.keys(result).length ? result : null;
}

function formatDateDisplay(isoDate) {
    const [y, m, d] = isoDate.split('-');
    const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${y}`;
}

function saveStudentScheduleToDb(groupName, date, parsedResult) {
    if (!parsedResult || typeof parsedResult !== 'object') return;
    const d = getDb();
    const groupId = ensureGroup(groupName);

    const insert = d.transaction((dates) => {
        for (const dateKey of Object.keys(dates)) {
            const day = dates[dateKey];
            const lessons = day.lessons || [];
            const hasNoLessons = lessons.length === 1 && lessons[0].status === 'Нет пар';
            if (hasNoLessons) {
                insertScheduleMeta('group', groupName, dateKey, true);
                continue;
            }
            insertScheduleMeta('group', groupName, dateKey, false);
            for (const lesson of lessons) {
                if (lesson.status === 'Нет пар') continue;
                if (!lesson.time || !lesson.time.includes('-')) continue;
                const [timeStart, timeEnd] = lesson.time.split('-').map(s => s.trim());
                const teacherId = lesson.teacher ? ensureTeacher(lesson.teacher) : null;
                const subjectId = (lesson.name && lesson.name.trim()) ? ensureSubject(lesson.name.trim()) : null;
                const classroomId = (lesson.classroom && lesson.classroom.trim()) ? ensureClassroom(lesson.classroom.trim()) : null;
                insertScheduleSlot({
                    date: dateKey,
                    time_start: timeStart,
                    time_end: timeEnd,
                    group_id: groupId,
                    teacher_id: teacherId,
                    subject_id: subjectId,
                    classroom_id: classroomId,
                    lesson_type: lesson.type || null,
                    subgroup: lesson.subgroup || null
                });
            }
        }
    });
    insert(parsedResult);
}

function saveTeacherScheduleToDb(teacherName, date, parsedResult) {
    if (!parsedResult || typeof parsedResult !== 'object') return;
    const d = getDb();
    const teacherId = ensureTeacher(teacherName);

    const insert = d.transaction((dates) => {
        for (const dateKey of Object.keys(dates)) {
            const day = dates[dateKey];
            const lessons = day.lessons || [];
            const hasNoLessons = lessons.length === 1 && lessons[0].status === 'Нет пар';
            if (hasNoLessons) {
                insertScheduleMeta('teacher', teacherName, dateKey, true);
                continue;
            }
            insertScheduleMeta('teacher', teacherName, dateKey, false);
            for (const lesson of lessons) {
                if (lesson.status === 'Нет пар') continue;
                if (!lesson.time || !lesson.time.includes('-')) continue;
                const [timeStart, timeEnd] = lesson.time.split('-').map(s => s.trim());
                const subjectId = (lesson.subject && lesson.subject.trim()) ? ensureSubject(lesson.subject.trim()) : null;
                const classroomId = (lesson.room && lesson.room.trim()) ? ensureClassroom(lesson.room.trim()) : null;
                const groups = lesson.groups && Array.isArray(lesson.groups) ? lesson.groups : (lesson.group ? [lesson.group] : []);
                for (const groupName of groups) {
                    if (!groupName || !groupName.trim()) continue;
                    const groupId = ensureGroup(groupName.trim());
                    insertScheduleSlot({
                        date: dateKey,
                        time_start: timeStart,
                        time_end: timeEnd,
                        group_id: groupId,
                        teacher_id: teacherId,
                        subject_id: subjectId,
                        classroom_id: classroomId,
                        lesson_type: null,
                        subgroup: lesson.subgroup || null
                    });
                }
            }
        }
    });
    insert(parsedResult);
}

module.exports = {
    getDb,
    ensureGroup,
    ensureTeacher,
    ensureClassroom,
    ensureSubject,
    insertScheduleSlot,
    insertScheduleMeta,
    insertRequestStats,
    getStudentSchedule,
    getTeacherSchedule,
    getStudentScheduleWeek,
    getTeacherScheduleWeek,
    saveStudentScheduleToDb,
    saveTeacherScheduleToDb
};
