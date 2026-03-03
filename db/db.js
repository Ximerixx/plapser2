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

function columnExists(d, table, column) {
    const info = d.prepare(`PRAGMA table_info(${table})`).all();
    return info.some(c => c.name === column);
}

function runMigrations(d) {
    if (!columnExists(d, 'request_stats', 'source')) {
        d.exec("ALTER TABLE request_stats ADD COLUMN source TEXT NOT NULL DEFAULT 'cache'");
    }
    if (!columnExists(d, 'schedule_slots', 'request_stats_id')) {
        d.exec('ALTER TABLE schedule_slots ADD COLUMN request_stats_id INTEGER REFERENCES request_stats(id)');
    }
    if (!columnExists(d, 'schedule_meta', 'request_stats_id')) {
        d.exec('ALTER TABLE schedule_meta ADD COLUMN request_stats_id INTEGER REFERENCES request_stats(id)');
    }
    try {
        d.exec('CREATE INDEX IF NOT EXISTS idx_schedule_slots_request_stats_id ON schedule_slots(request_stats_id)');
        d.exec('CREATE INDEX IF NOT EXISTS idx_schedule_meta_request_stats_id ON schedule_meta(request_stats_id)');
    } catch (_) {}
    if (!columnExists(d, 'schedule_slots', 'auditory_id')) {
        d.exec('ALTER TABLE schedule_slots ADD COLUMN auditory_id INTEGER REFERENCES auditories(id)');
    }
    try {
        d.exec('CREATE INDEX IF NOT EXISTS idx_schedule_slots_auditory_date ON schedule_slots(auditory_id, date)');
    } catch (_) {}
    migrateEntityTypeToIncludeAuditory(d);
    migrateSourceAsked(d);
    migrateClassroomsToAuditories(d);
}

function migrateClassroomsToAuditories(d) {
    if (!columnExists(d, 'schedule_slots', 'classroom_id')) return;
    const hasClassrooms = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='classrooms'").get();
    if (hasClassrooms) {
        d.exec('INSERT OR IGNORE INTO auditories (name) SELECT name FROM classrooms');
        d.exec(`
            UPDATE schedule_slots SET auditory_id = (
                SELECT a.id FROM classrooms c
                JOIN auditories a ON a.name = c.name
                WHERE c.id = schedule_slots.classroom_id
            ) WHERE classroom_id IS NOT NULL
        `);
    }
    d.pragma('foreign_keys = OFF');
    try {
        d.exec('ALTER TABLE schedule_slots DROP COLUMN classroom_id');
    } catch (e) {
        console.warn('migrateClassroomsToAuditories: DROP COLUMN failed (old SQLite?), skipping:', e.message);
    }
    try {
        d.exec('DROP TABLE IF EXISTS classrooms');
    } catch (_) {}
    d.pragma('foreign_keys = ON');
}

function migrateSourceAsked(d) {
    const r = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='request_stats'").get();
    if (r && r.sql && r.sql.includes("'source_asked'")) return;
    d.pragma('foreign_keys = OFF');
    d.exec(`
        CREATE TABLE request_stats_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ip TEXT,
            user_agent TEXT,
            entity_type TEXT NOT NULL CHECK (entity_type IN ('group', 'teacher', 'auditory')),
            entity_key TEXT NOT NULL,
            requested_at INTEGER NOT NULL,
            processing_time_ms INTEGER NOT NULL,
            response_type TEXT,
            source TEXT NOT NULL DEFAULT 'cache' CHECK (source IN ('cache', 'db', 'source', 'source_asked'))
        );
        INSERT INTO request_stats_new SELECT id, ip, user_agent, entity_type, entity_key, requested_at, processing_time_ms, response_type, source FROM request_stats;
        DROP TABLE request_stats;
        ALTER TABLE request_stats_new RENAME TO request_stats;
    `);
    try { d.exec('CREATE INDEX IF NOT EXISTS idx_request_stats_requested_at ON request_stats(requested_at)'); } catch (_) {}
    try { d.exec('CREATE INDEX IF NOT EXISTS idx_request_stats_entity ON request_stats(entity_type, entity_key)'); } catch (_) {}
    d.pragma('foreign_keys = ON');
}

function migrateEntityTypeToIncludeAuditory(d) {
    const r = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='request_stats'").get();
    if (r && r.sql && r.sql.includes("'auditory'")) return;
    d.pragma('foreign_keys = OFF');
    d.exec(`
        CREATE TABLE request_stats_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ip TEXT,
            user_agent TEXT,
            entity_type TEXT NOT NULL CHECK (entity_type IN ('group', 'teacher', 'auditory')),
            entity_key TEXT NOT NULL,
            requested_at INTEGER NOT NULL,
            processing_time_ms INTEGER NOT NULL,
            response_type TEXT,
            source TEXT NOT NULL DEFAULT 'cache'
        );
        INSERT INTO request_stats_new SELECT id, ip, user_agent, entity_type, entity_key, requested_at, processing_time_ms, response_type, source FROM request_stats;
        DROP TABLE request_stats;
        ALTER TABLE request_stats_new RENAME TO request_stats;
    `);
    try { d.exec('CREATE INDEX IF NOT EXISTS idx_request_stats_requested_at ON request_stats(requested_at)'); } catch (_) {}
    try { d.exec('CREATE INDEX IF NOT EXISTS idx_request_stats_entity ON request_stats(entity_type, entity_key)'); } catch (_) {}

    const m = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='schedule_meta'").get();
    if (m && m.sql && m.sql.includes("'auditory'")) {
        d.pragma('foreign_keys = ON');
        return;
    }
    d.exec(`
        CREATE TABLE schedule_meta_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL CHECK (entity_type IN ('group', 'teacher', 'auditory')),
            entity_key TEXT NOT NULL,
            date TEXT NOT NULL,
            no_lessons INTEGER NOT NULL DEFAULT 0,
            request_stats_id INTEGER REFERENCES request_stats(id),
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            UNIQUE(entity_type, entity_key, date)
        );
        INSERT INTO schedule_meta_new SELECT id, entity_type, entity_key, date, no_lessons, request_stats_id, created_at FROM schedule_meta;
        DROP TABLE schedule_meta;
        ALTER TABLE schedule_meta_new RENAME TO schedule_meta;
    `);
    try { d.exec('CREATE INDEX IF NOT EXISTS idx_schedule_meta_lookup ON schedule_meta(entity_type, entity_key, date)'); } catch (_) {}
    try { d.exec('CREATE INDEX IF NOT EXISTS idx_schedule_meta_request_stats_id ON schedule_meta(request_stats_id)'); } catch (_) {}
    d.pragma('foreign_keys = ON');
}

function getDb() {
    if (db) return db;
    db = new Database(DB_PATH);
    db.pragma('foreign_keys = ON');
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    db.exec(schema);
    runMigrations(db);
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

function ensureAuditory(name) {
    if (!name || name.trim() === '') return null;
    const d = getDb();
    let row = d.prepare('SELECT id FROM auditories WHERE name = ?').get(name);
    if (row) return row.id;
    const result = d.prepare('INSERT INTO auditories (name) VALUES (?)').run(name);
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
        INSERT INTO schedule_slots (date, time_start, time_end, group_id, teacher_id, subject_id, auditory_id, lesson_type, subgroup, request_stats_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        row.date,
        row.time_start,
        row.time_end,
        row.group_id,
        row.teacher_id ?? null,
        row.subject_id ?? null,
        row.auditory_id ?? null,
        row.lesson_type ?? null,
        row.subgroup ?? null,
        row.request_stats_id ?? null
    );
}

function insertScheduleMeta(entityType, entityKey, date, noLessons, requestStatsId = null) {
    const d = getDb();
    d.prepare(`
        INSERT OR REPLACE INTO schedule_meta (entity_type, entity_key, date, no_lessons, request_stats_id, created_at)
        VALUES (?, ?, ?, ?, ?, unixepoch())
    `).run(entityType, entityKey, date, noLessons ? 1 : 0, requestStatsId ?? null);
}

function insertRequestStats({ ip, userAgent, entityType, entityKey, requestedAt, processingTimeMs, type: responseType, source }) {
    const d = getDb();
    const requestedAtSec = requestedAt != null ? Math.floor(Number(requestedAt) / 1000) : Math.floor(Date.now() / 1000);
    const src = (source === 'cache' || source === 'db' || source === 'source' || source === 'source_asked') ? source : 'cache';
    const stmt = d.prepare(`
        INSERT INTO request_stats (ip, user_agent, entity_type, entity_key, requested_at, processing_time_ms, response_type, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(ip ?? null, userAgent ?? null, entityType, entityKey, requestedAtSec, processingTimeMs, responseType ?? null, src);
    return result.lastInsertRowid;
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
               g.name AS group_name, t.name AS teacher_name, sub.name AS subject_name, a.name AS auditory_name
        FROM schedule_slots s
        JOIN groups g ON s.group_id = g.id
        LEFT JOIN teachers t ON s.teacher_id = t.id
        LEFT JOIN subjects sub ON s.subject_id = sub.id
        LEFT JOIN auditories a ON s.auditory_id = a.id
        WHERE s.group_id = ? AND s.date = ?
        ORDER BY s.time_start
    `).all(groupRow.id, date);

    if (rows.length === 0) return null;

    const dayOfWeek = getDayOfWeek(date);
    const dateDisplay = formatDateDisplay(date);
    const lessons = rows.map(r => {
        if (subgroup !== undefined && subgroup !== null && r.subgroup && String(r.subgroup) !== String(subgroup)) return null;
        const auditory = r.auditory_name || '';
        return {
            time: `${r.time_start}-${r.time_end}`,
            type: r.lesson_type || '',
            name: r.subject_name || '',
            subgroup: r.subgroup || '',
            groups: [r.group_name],
            auditory,
            room: auditory,
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
               g.name AS group_name, sub.name AS subject_name, a.name AS auditory_name
        FROM schedule_slots s
        JOIN groups g ON s.group_id = g.id
        LEFT JOIN subjects sub ON s.subject_id = sub.id
        LEFT JOIN auditories a ON s.auditory_id = a.id
        WHERE s.teacher_id = ? AND s.date = ?
        ORDER BY s.time_start, g.name
    `).all(teacherRow.id, date);

    if (rows.length === 0) return null;

    const dayOfWeek = getDayOfWeek(date);
    const dateDisplay = formatDateDisplay(date);
    const byTime = {};
    rows.forEach(r => {
        const time = `${r.time_start}-${r.time_end}`;
        const auditory = r.auditory_name || '';
        if (!byTime[time]) {
            byTime[time] = { time, subject: r.subject_name || '', groups: [], auditory, room: auditory, subgroup: r.subgroup || null };
        }
        if (r.group_name && !byTime[time].groups.includes(r.group_name)) byTime[time].groups.push(r.group_name);
    });
    const lessons = Object.values(byTime).map(o => ({
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

function getAuditorySchedule(auditoryName, date) {
    const d = getDb();
    const auditoryRow = d.prepare('SELECT id FROM auditories WHERE name = ?').get(auditoryName);
    if (!auditoryRow) return null;

    const meta = d.prepare(
        'SELECT no_lessons FROM schedule_meta WHERE entity_type = ? AND entity_key = ? AND date = ?'
    ).get('auditory', auditoryName, date);
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
               g.name AS group_name, t.name AS teacher_name, sub.name AS subject_name, a.name AS auditory_name
        FROM schedule_slots s
        JOIN groups g ON s.group_id = g.id
        LEFT JOIN teachers t ON s.teacher_id = t.id
        LEFT JOIN subjects sub ON s.subject_id = sub.id
        LEFT JOIN auditories a ON s.auditory_id = a.id
        WHERE s.auditory_id = ? AND s.date = ?
        ORDER BY s.time_start, g.name
    `).all(auditoryRow.id, date);

    if (rows.length === 0) return null;

    const dayOfWeek = getDayOfWeek(date);
    const dateDisplay = formatDateDisplay(date);
    const byTime = {};
    rows.forEach(r => {
        const time = `${r.time_start}-${r.time_end}`;
        const auditory = r.auditory_name || '';
        if (!byTime[time]) {
            byTime[time] = { time, subject: r.subject_name || '', groups: [], auditory, room: auditory, subgroup: r.subgroup || null, teacher: r.teacher_name || '' };
        }
        if (r.group_name && !byTime[time].groups.includes(r.group_name)) byTime[time].groups.push(r.group_name);
    });
    const lessons = Object.values(byTime).map(o => ({
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
            date: dateDisplay,
            dayOfWeek,
            lessons
        }
    };
}

function getAuditoryScheduleWeek(auditoryName, baseDate) {
    const result = {};
    for (let i = 0; i < 7; i++) {
        const d = new Date(baseDate + 'T12:00:00');
        d.setDate(d.getDate() + i);
        const dateStr = d.toISOString().split('T')[0];
        const dayData = getAuditorySchedule(auditoryName, dateStr);
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

function saveStudentScheduleToDb(groupName, date, parsedResult, requestStatsId = null) {
    if (!parsedResult || typeof parsedResult !== 'object') return;
    const d = getDb();
    const groupId = ensureGroup(groupName);

    const insert = d.transaction((dates) => {
        for (const dateKey of Object.keys(dates)) {
            const day = dates[dateKey];
            const lessons = day.lessons || [];
            const hasNoLessons = lessons.length === 1 && lessons[0].status === 'Нет пар';
            if (hasNoLessons) {
                insertScheduleMeta('group', groupName, dateKey, true, requestStatsId);
                continue;
            }
            insertScheduleMeta('group', groupName, dateKey, false, requestStatsId);
            for (const lesson of lessons) {
                if (lesson.status === 'Нет пар') continue;
                if (!lesson.time || !lesson.time.includes('-')) continue;
                const [timeStart, timeEnd] = lesson.time.split('-').map(s => s.trim());
                const teacherId = lesson.teacher ? ensureTeacher(lesson.teacher) : null;
                const subjectId = (lesson.name && lesson.name.trim()) ? ensureSubject(lesson.name.trim()) : null;
                const roomName = lesson.auditory || lesson.room || lesson.classroom;
                const auditoryId = (roomName && String(roomName).trim()) ? ensureAuditory(String(roomName).trim()) : null;
                insertScheduleSlot({
                    date: dateKey,
                    time_start: timeStart,
                    time_end: timeEnd,
                    group_id: groupId,
                    teacher_id: teacherId,
                    subject_id: subjectId,
                    auditory_id: auditoryId,
                    lesson_type: lesson.type || null,
                    subgroup: lesson.subgroup || null,
                    request_stats_id: requestStatsId
                });
            }
        }
    });
    insert(parsedResult);
}

function saveTeacherScheduleToDb(teacherName, date, parsedResult, requestStatsId = null) {
    if (!parsedResult || typeof parsedResult !== 'object') return;
    const d = getDb();
    const teacherId = ensureTeacher(teacherName);

    const insert = d.transaction((dates) => {
        for (const dateKey of Object.keys(dates)) {
            const day = dates[dateKey];
            const lessons = day.lessons || [];
            const hasNoLessons = lessons.length === 1 && lessons[0].status === 'Нет пар';
            if (hasNoLessons) {
                insertScheduleMeta('teacher', teacherName, dateKey, true, requestStatsId);
                continue;
            }
            insertScheduleMeta('teacher', teacherName, dateKey, false, requestStatsId);
            for (const lesson of lessons) {
                if (lesson.status === 'Нет пар') continue;
                if (!lesson.time || !lesson.time.includes('-')) continue;
                const [timeStart, timeEnd] = lesson.time.split('-').map(s => s.trim());
                const subjectId = (lesson.subject && lesson.subject.trim()) ? ensureSubject(lesson.subject.trim()) : null;
                const roomName = lesson.auditory || lesson.room;
                const auditoryId = (roomName && String(roomName).trim()) ? ensureAuditory(String(roomName).trim()) : null;
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
                        auditory_id: auditoryId,
                        lesson_type: null,
                        subgroup: lesson.subgroup || null,
                        request_stats_id: requestStatsId
                    });
                }
            }
        }
    });
    insert(parsedResult);
}

function saveAuditoryScheduleToDb(auditoryName, date, parsedResult, requestStatsId = null) {
    if (!parsedResult || typeof parsedResult !== 'object') return;
    const d = getDb();
    const auditoryId = ensureAuditory(auditoryName);

    const insert = d.transaction((dates) => {
        for (const dateKey of Object.keys(dates)) {
            const day = dates[dateKey];
            const lessons = day.lessons || [];
            const hasNoLessons = lessons.length === 1 && lessons[0].status === 'Нет пар';
            if (hasNoLessons) {
                insertScheduleMeta('auditory', auditoryName, dateKey, true, requestStatsId);
                continue;
            }
            insertScheduleMeta('auditory', auditoryName, dateKey, false, requestStatsId);
            for (const lesson of lessons) {
                if (lesson.status === 'Нет пар') continue;
                if (!lesson.time || !lesson.time.includes('-')) continue;
                const [timeStart, timeEnd] = lesson.time.split('-').map(s => s.trim());
                const teacherId = (lesson.teacher && lesson.teacher.trim()) ? ensureTeacher(lesson.teacher.trim()) : null;
                const subjectId = (lesson.name && lesson.name.trim()) ? ensureSubject(lesson.name.trim()) : (lesson.subject && lesson.subject.trim() ? ensureSubject(lesson.subject.trim()) : null);
                const roomName = lesson.auditory || lesson.room || lesson.classroom;
                const lessonAuditoryId = (roomName && String(roomName).trim()) ? ensureAuditory(String(roomName).trim()) : auditoryId;
                let groups = lesson.groups && Array.isArray(lesson.groups) ? lesson.groups : (lesson.group ? [lesson.group] : []);
                groups = groups.filter(g => g && g.trim());
                if (groups.length === 0) groups = ['—'];
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
                        auditory_id: lessonAuditoryId,
                        lesson_type: lesson.type || null,
                        subgroup: lesson.subgroup || null,
                        request_stats_id: requestStatsId
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
    ensureAuditory,
    ensureSubject,
    insertScheduleSlot,
    insertScheduleMeta,
    insertRequestStats,
    getStudentSchedule,
    getTeacherSchedule,
    getAuditorySchedule,
    getStudentScheduleWeek,
    getTeacherScheduleWeek,
    getAuditoryScheduleWeek,
    saveStudentScheduleToDb,
    saveTeacherScheduleToDb,
    saveAuditoryScheduleToDb
};
