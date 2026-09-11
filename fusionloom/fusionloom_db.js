'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'fusionloom.db');
const DB_PATH = process.env.FUSIONLOOM_DB_PATH || DEFAULT_DB_PATH;

let db = null;

const DAYS_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

function getDayOfWeek(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    return DAYS_RU[d.getDay()];
}

function formatDateDisplay(isoDate) {
    const [y, m, d] = isoDate.split('-');
    const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${y}`;
}

function getDb() {
    if (db) return db;
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('foreign_keys = ON');
    const schemaPath = path.join(__dirname, 'schema.sql');
    db.exec(fs.readFileSync(schemaPath, 'utf8'));
    return db;
}

function runInTransaction(fn) {
    const d = getDb();
    return d.transaction(fn)();
}

// --- Registry upserts ---

function upsertGroupCanon({ displayName, canonicalKey, specialty, admissionYear, groupIndex, form }) {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    let row = d.prepare('SELECT id FROM groups WHERE canonical_key = ?').get(canonicalKey);
    if (row) {
        d.prepare('UPDATE groups SET specialty = ?, admission_year = ?, group_index = ?, form = ?, updated_at = ? WHERE id = ?')
            .run(specialty ?? null, admissionYear ?? null, groupIndex ?? null, form ?? null, now, row.id);
        return row.id;
    }
    const r = d.prepare(`
        INSERT INTO groups (display_name, canonical_key, specialty, admission_year, group_index, form, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(displayName, canonicalKey, specialty ?? null, admissionYear ?? null, groupIndex ?? null, form ?? null, now, now);
    return r.lastInsertRowid;
}

function upsertGroupAlias(groupId, rawName, sourceCode = 'kis') {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    const existing = d.prepare('SELECT id FROM group_aliases WHERE raw_name = ?').get(rawName);
    if (existing) {
        d.prepare('UPDATE group_aliases SET group_id = ?, last_seen_at = ? WHERE id = ?').run(groupId, now, existing.id);
        return existing.id;
    }
    const r = d.prepare(`
        INSERT INTO group_aliases (group_id, raw_name, source_code, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(groupId, rawName, sourceCode, now, now);
    return r.lastInsertRowid;
}

function findGroupIdByAlias(rawName) {
    const d = getDb();
    const row = d.prepare(`
        SELECT g.id FROM group_aliases a JOIN groups g ON g.id = a.group_id WHERE a.raw_name = ?
    `).get(rawName);
    return row ? row.id : null;
}

function findGroupIdByDisplayName(name) {
    const d = getDb();
    const row = d.prepare('SELECT id FROM groups WHERE display_name = ?').get(name);
    return row ? row.id : null;
}

function upsertTeacherCanon({ displayName, canonicalKey }) {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    let row = d.prepare('SELECT id FROM teachers WHERE canonical_key = ?').get(canonicalKey);
    if (row) {
        d.prepare('UPDATE teachers SET display_name = ?, updated_at = ? WHERE id = ?').run(displayName, now, row.id);
        return row.id;
    }
    const r = d.prepare('INSERT INTO teachers (display_name, canonical_key, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(displayName, canonicalKey, now, now);
    return r.lastInsertRowid;
}

function upsertTeacherAlias(teacherId, rawName, sourceCode = 'kis') {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    const existing = d.prepare('SELECT id FROM teacher_aliases WHERE raw_name = ?').get(rawName);
    if (existing) {
        d.prepare('UPDATE teacher_aliases SET teacher_id = ?, last_seen_at = ? WHERE id = ?').run(teacherId, now, existing.id);
        return existing.id;
    }
    const r = d.prepare(`
        INSERT INTO teacher_aliases (teacher_id, raw_name, source_code, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(teacherId, rawName, sourceCode, now, now);
    return r.lastInsertRowid;
}

function findTeacherIdByAlias(rawName) {
    const d = getDb();
    const row = d.prepare(`
        SELECT t.id FROM teacher_aliases a JOIN teachers t ON t.id = a.teacher_id WHERE a.raw_name = ?
    `).get(rawName);
    return row ? row.id : null;
}

function upsertSubjectCanon({ displayName, canonicalKey }) {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    let row = d.prepare('SELECT id FROM subjects WHERE canonical_key = ?').get(canonicalKey);
    if (row) {
        d.prepare('UPDATE subjects SET display_name = ?, updated_at = ? WHERE id = ?').run(displayName, now, row.id);
        return row.id;
    }
    const r = d.prepare('INSERT INTO subjects (display_name, canonical_key, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(displayName, canonicalKey, now, now);
    return r.lastInsertRowid;
}

function upsertSubjectAlias(subjectId, rawName, sourceCode = 'kis') {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    const existing = d.prepare('SELECT id FROM subject_aliases WHERE raw_name = ?').get(rawName);
    if (existing) {
        d.prepare('UPDATE subject_aliases SET subject_id = ?, last_seen_at = ? WHERE id = ?').run(subjectId, now, existing.id);
        return existing.id;
    }
    const r = d.prepare(`
        INSERT INTO subject_aliases (subject_id, raw_name, source_code, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(subjectId, rawName, sourceCode, now, now);
    return r.lastInsertRowid;
}

function upsertAuditoryCanon({ displayName, canonicalKey, roomNumber, roomType, building }) {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    let row = d.prepare('SELECT id FROM auditories WHERE canonical_key = ?').get(canonicalKey);
    if (row) {
        d.prepare(`
            UPDATE auditories SET display_name = ?, room_number = ?, room_type = ?, building = ?, updated_at = ?
            WHERE id = ?
        `).run(displayName, roomNumber ?? null, roomType ?? null, building ?? null, now, row.id);
        return row.id;
    }
    const r = d.prepare(`
        INSERT INTO auditories (display_name, canonical_key, room_number, room_type, building, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(displayName, canonicalKey, roomNumber ?? null, roomType ?? null, building ?? null, now, now);
    return r.lastInsertRowid;
}

function upsertAuditoryAlias(auditoryId, rawName, sourceCode = 'kis') {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    const existing = d.prepare('SELECT id FROM auditory_aliases WHERE raw_name = ?').get(rawName);
    if (existing) {
        d.prepare('UPDATE auditory_aliases SET auditory_id = ?, last_seen_at = ? WHERE id = ?').run(auditoryId, now, existing.id);
        return existing.id;
    }
    const r = d.prepare(`
        INSERT INTO auditory_aliases (auditory_id, raw_name, source_code, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(auditoryId, rawName, sourceCode, now, now);
    return r.lastInsertRowid;
}

function findAuditoryIdByAlias(rawName) {
    const d = getDb();
    const row = d.prepare(`
        SELECT a.id FROM auditory_aliases al JOIN auditories a ON a.id = al.auditory_id WHERE al.raw_name = ?
    `).get(rawName);
    return row ? row.id : null;
}

function findAuditoryIdByCanonicalKey(canonicalKey) {
    const d = getDb();
    const row = d.prepare('SELECT id FROM auditories WHERE canonical_key = ?').get(canonicalKey);
    return row ? row.id : null;
}

function findAuditoryAliasBySource(auditoryId, sourceCode = 'kis') {
    const d = getDb();
    const row = d.prepare(`
        SELECT raw_name FROM auditory_aliases
        WHERE auditory_id = ? AND source_code = ?
        ORDER BY last_seen_at DESC, id ASC
        LIMIT 1
    `).get(auditoryId, sourceCode);
    return row ? row.raw_name : null;
}

function findAuditoryByCanonicalKey(canonicalKey) {
    const d = getDb();
    return d.prepare('SELECT * FROM auditories WHERE canonical_key = ?').get(canonicalKey) || null;
}

function getAuditoryDisplayById(id) {
    const d = getDb();
    const row = d.prepare('SELECT display_name FROM auditories WHERE id = ?').get(id);
    return row ? row.display_name : '';
}

// --- Lessons ---

function findLessonByFusionKey(date, timeStart, timeEnd, fusionKey) {
    const d = getDb();
    return d.prepare(`
        SELECT * FROM lessons WHERE date = ? AND time_start = ? AND time_end = ? AND fusion_key = ?
    `).get(date, timeStart, timeEnd, fusionKey) || null;
}

/** Когда view не передаёт subgroup (auditory), ищем единственный урок в слоте. */
function findLessonBySlotCanon(date, timeStart, timeEnd, subjectId, auditoryId) {
    const d = getDb();
    const prefix = `${date}|${timeStart}|${timeEnd}|${subjectId || ''}|${auditoryId || ''}|`;
    const rows = d.prepare(`
        SELECT * FROM lessons WHERE date = ? AND time_start = ? AND time_end = ? AND fusion_key LIKE ?
    `).all(date, timeStart, timeEnd, `${prefix}%`);
    if (rows.length === 1) return rows[0];
    return null;
}

function createLesson({ date, timeStart, timeEnd, subjectId, lessonType, subgroup, fusionKey, confidence = 1.0 }) {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    const r = d.prepare(`
        INSERT INTO lessons (date, time_start, time_end, subject_id, lesson_type, subgroup, fusion_key, confidence, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(date, timeStart, timeEnd, subjectId ?? null, lessonType ?? null, subgroup ?? null, fusionKey, confidence, now, now);
    return r.lastInsertRowid;
}

function touchLesson(lessonId) {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    d.prepare('UPDATE lessons SET last_seen_at = ? WHERE id = ?').run(now, lessonId);
}

function updateLessonFields(lessonId, { lessonType, subgroup, subjectId }) {
    const d = getDb();
    const row = d.prepare('SELECT lesson_type, subgroup, subject_id FROM lessons WHERE id = ?').get(lessonId);
    if (!row) return;
    const lt = row.lesson_type || lessonType || null;
    const sg = row.subgroup || subgroup || null;
    const sub = row.subject_id || subjectId || null;
    if (lessonType && !row.lesson_type) d.prepare('UPDATE lessons SET lesson_type = ? WHERE id = ?').run(lessonType, lessonId);
    if (subgroup && !row.subgroup) d.prepare('UPDATE lessons SET subgroup = ? WHERE id = ?').run(subgroup, lessonId);
    if (subjectId && !row.subject_id) d.prepare('UPDATE lessons SET subject_id = ? WHERE id = ?').run(subjectId, lessonId);
}

function decrementLessonConfidence(lessonId, delta = 0.1) {
    const d = getDb();
    d.prepare('UPDATE lessons SET confidence = MAX(0, confidence - ?) WHERE id = ?').run(delta, lessonId);
}

function linkLessonGroup(lessonId, groupId) {
    const d = getDb();
    d.prepare('INSERT OR IGNORE INTO lesson_groups (lesson_id, group_id) VALUES (?, ?)').run(lessonId, groupId);
}

function linkLessonTeacher(lessonId, teacherId) {
    const d = getDb();
    d.prepare('INSERT OR IGNORE INTO lesson_teachers (lesson_id, teacher_id) VALUES (?, ?)').run(lessonId, teacherId);
}

function linkLessonAuditory(lessonId, auditoryId) {
    const d = getDb();
    d.prepare('INSERT OR IGNORE INTO lesson_auditories (lesson_id, auditory_id) VALUES (?, ?)').run(lessonId, auditoryId);
}

// --- Ingest / meta ---

function getSourceId(code = 'kis') {
    const d = getDb();
    const row = d.prepare('SELECT id FROM sources WHERE code = ?').get(code);
    return row ? row.id : 1;
}

function insertIngestBatch({ viewType, viewKey, anchorDate, requestStatsId, status = 'ok' }) {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    const r = d.prepare(`
        INSERT INTO ingest_batches (source_id, view_type, view_key, anchor_date, fetched_at, request_stats_id, status, lessons_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).run(getSourceId('kis'), viewType, viewKey, anchorDate, now, requestStatsId ?? null, status);
    return r.lastInsertRowid;
}

function incrementBatchLessonsSeen(batchId) {
    const d = getDb();
    d.prepare('UPDATE ingest_batches SET lessons_seen = lessons_seen + 1 WHERE id = ?').run(batchId);
}

function updateBatchStatus(batchId, status) {
    const d = getDb();
    d.prepare('UPDATE ingest_batches SET status = ? WHERE id = ?').run(status, batchId);
}

function linkLessonIngest(lessonId, batchId) {
    const d = getDb();
    d.prepare('INSERT OR IGNORE INTO lesson_ingest (lesson_id, batch_id) VALUES (?, ?)').run(lessonId, batchId);
}

function upsertScheduleMeta(entityType, entityKey, date, noLessons, batchId = null) {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    d.prepare(`
        INSERT INTO schedule_meta (entity_type, entity_key, date, no_lessons, last_batch_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, entity_key, date) DO UPDATE SET
            no_lessons = excluded.no_lessons,
            last_batch_id = excluded.last_batch_id,
            updated_at = excluded.updated_at
    `).run(entityType, entityKey, date, noLessons ? 1 : 0, batchId, now, now);
}

function getScheduleMeta(entityType, entityKey, date) {
    const d = getDb();
    return d.prepare('SELECT * FROM schedule_meta WHERE entity_type = ? AND entity_key = ? AND date = ?')
        .get(entityType, entityKey, date) || null;
}

function getScheduleDatesFrom(entityType, entityKey, fromDate, maxDays = 21) {
    const d = getDb();
    const rows = d.prepare(`
        SELECT date FROM schedule_meta
        WHERE entity_type = ? AND entity_key = ? AND date >= ?
        ORDER BY date ASC
        LIMIT ?
    `).all(entityType, entityKey, fromDate, maxDays);
    return rows.map((row) => row.date);
}

// --- Read row queries ---

function findGroupIdByCanonicalKey(groupName) {
    const { groupCanonicalKey } = require('./normalize/groups');
    const key = groupCanonicalKey(groupName);
    if (!key) return null;
    const d = getDb();
    const row = d.prepare('SELECT id FROM groups WHERE canonical_key = ?').get(key);
    return row ? row.id : null;
}

function findTeacherIdByCanonicalKey(teacherName) {
    const { teacherCanonicalKey } = require('./normalize/teachers');
    const key = teacherCanonicalKey(teacherName);
    if (!key) return null;
    const d = getDb();
    const row = d.prepare('SELECT id FROM teachers WHERE canonical_key = ?').get(key);
    return row ? row.id : null;
}

function findGroupAliasBySource(groupId, sourceCode = 'kis') {
    const d = getDb();
    const row = d.prepare(`
        SELECT raw_name FROM group_aliases
        WHERE group_id = ? AND source_code = ?
        ORDER BY last_seen_at DESC, id ASC
        LIMIT 1
    `).get(groupId, sourceCode);
    return row ? row.raw_name : null;
}

function findTeacherAliasBySource(teacherId, sourceCode = 'kis') {
    const d = getDb();
    const row = d.prepare(`
        SELECT raw_name FROM teacher_aliases
        WHERE teacher_id = ? AND source_code = ?
        ORDER BY last_seen_at DESC, id ASC
        LIMIT 1
    `).get(teacherId, sourceCode);
    return row ? row.raw_name : null;
}

function getGroupIdForRead(groupName) {
    return findGroupIdByAlias(groupName)
        || findGroupIdByDisplayName(groupName)
        || findGroupIdByCanonicalKey(groupName);
}

function getTeacherIdForRead(teacherName) {
    return findTeacherIdByAlias(teacherName)
        || findTeacherIdByCanonicalKey(teacherName)
        || (() => {
            const d = getDb();
            const row = d.prepare('SELECT id FROM teachers WHERE display_name = ?').get(teacherName);
            return row ? row.id : null;
        })();
}

function resolveAuditoryIdForRead(auditoryName) {
    const id = findAuditoryIdByAlias(auditoryName);
    if (id) return id;
    const { parseAuditoryParts, formatAuditoryCanonical } = require('./normalize/auditories');
    const parts = parseAuditoryParts(auditoryName);
    if (parts.normalizedKey) {
        const byKey = findAuditoryIdByCanonicalKey(parts.normalizedKey);
        if (byKey) return byKey;
    }
    const canonical = formatAuditoryCanonical(auditoryName);
    if (canonical && canonical !== auditoryName) {
        const byCanonAlias = findAuditoryIdByAlias(canonical);
        if (byCanonAlias) return byCanonAlias;
    }
    const d = getDb();
    const row = d.prepare('SELECT id FROM auditories WHERE display_name = ?').get(auditoryName);
    return row ? row.id : null;
}

function getStudentLessonRows(groupId, date) {
    const d = getDb();
    return d.prepare(`
        SELECT l.date, l.time_start, l.time_end, l.lesson_type, l.subgroup,
               g.display_name AS group_name,
               (SELECT t.display_name FROM lesson_teachers lt JOIN teachers t ON t.id = lt.teacher_id
                WHERE lt.lesson_id = l.id LIMIT 1) AS teacher_name,
               sub.display_name AS subject_name,
               (SELECT a.display_name FROM lesson_auditories la JOIN auditories a ON a.id = la.auditory_id
                WHERE la.lesson_id = l.id LIMIT 1) AS auditory_name
        FROM lessons l
        JOIN lesson_groups lg ON lg.lesson_id = l.id
        JOIN groups g ON g.id = lg.group_id
        LEFT JOIN subjects sub ON sub.id = l.subject_id
        WHERE lg.group_id = ? AND l.date = ?
        ORDER BY l.time_start
    `).all(groupId, date);
}

function getTeacherLessonRows(teacherId, date) {
    const d = getDb();
    return d.prepare(`
        SELECT l.date, l.time_start, l.time_end, l.subgroup,
               g.display_name AS group_name,
               sub.display_name AS subject_name,
               (SELECT a.display_name FROM lesson_auditories la JOIN auditories a ON a.id = la.auditory_id
                WHERE la.lesson_id = l.id LIMIT 1) AS auditory_name,
               l.id AS lesson_id
        FROM lessons l
        JOIN lesson_teachers lt ON lt.lesson_id = l.id
        JOIN lesson_groups lg ON lg.lesson_id = l.id
        JOIN groups g ON g.id = lg.group_id
        LEFT JOIN subjects sub ON sub.id = l.subject_id
        WHERE lt.teacher_id = ? AND l.date = ?
        ORDER BY l.time_start, g.display_name
    `).all(teacherId, date);
}

function getAuditoryLessonRows(auditoryId, date) {
    const d = getDb();
    return d.prepare(`
        SELECT l.date, l.time_start, l.time_end, l.subgroup,
               g.display_name AS group_name,
               (SELECT t.display_name FROM lesson_teachers lt JOIN teachers t ON t.id = lt.teacher_id
                WHERE lt.lesson_id = l.id LIMIT 1) AS teacher_name,
               sub.display_name AS subject_name,
               a.display_name AS auditory_name,
               l.id AS lesson_id
        FROM lessons l
        JOIN lesson_auditories la ON la.lesson_id = l.id
        JOIN auditories a ON a.id = la.auditory_id
        JOIN lesson_groups lg ON lg.lesson_id = l.id
        JOIN groups g ON g.id = lg.group_id
        LEFT JOIN subjects sub ON sub.id = l.subject_id
        WHERE la.auditory_id = ? AND l.date = ?
        ORDER BY l.time_start, g.display_name
    `).all(auditoryId, date);
}

function getDynamicSlotRows(date, building = null) {
    const d = getDb();
    const buildingFilter = building ? String(building).trim().toUpperCase() : null;
    if (buildingFilter) {
        return d.prepare(`
            SELECT DISTINCT l.time_start, l.time_end
            FROM lessons l
            JOIN lesson_auditories la ON la.lesson_id = l.id
            JOIN auditories a ON a.id = la.auditory_id
            WHERE l.date = ? AND a.building = ?
            ORDER BY l.time_start, l.time_end
        `).all(date, buildingFilter);
    }
    return d.prepare(`
        SELECT DISTINCT time_start, time_end FROM lessons WHERE date = ? ORDER BY time_start, time_end
    `).all(date);
}

function getAuditoriesByBuilding(building, roomType = null) {
    const d = getDb();
    const b = String(building ?? '').trim().toUpperCase();
    if (!b) return [];
    if (roomType) {
        return d.prepare(`
            SELECT id, display_name AS rawName, room_number AS roomNumber, room_type AS roomType, building
            FROM auditories WHERE building = ? AND room_type = ?
            ORDER BY room_number, display_name
        `).all(b, roomType);
    }
    return d.prepare(`
        SELECT id, display_name AS rawName, room_number AS roomNumber, room_type AS roomType, building
        FROM auditories WHERE building = ?
        ORDER BY room_number, display_name
    `).all(b);
}

function getOccupiedAuditoryIds(date, building, timeEnd, timeStart, roomType = null) {
    const d = getDb();
    const b = String(building).trim().toUpperCase();
    let sql = `
        SELECT DISTINCT la.auditory_id AS id
        FROM lessons l
        JOIN lesson_auditories la ON la.lesson_id = l.id
        JOIN auditories a ON a.id = la.auditory_id
        WHERE l.date = ? AND a.building = ?
          AND l.time_start < ? AND l.time_end > ?
    `;
    const params = [date, b, timeEnd, timeStart];
    if (roomType) {
        sql += ' AND a.room_type = ?';
        params.push(roomType);
    }
    return d.prepare(sql).all(...params).map(r => r.id);
}

function getAuditoryOccupiedSlots(auditoryId, date) {
    const d = getDb();
    return d.prepare(`
        SELECT l.time_start, l.time_end
        FROM lessons l
        JOIN lesson_auditories la ON la.lesson_id = l.id
        WHERE l.date = ? AND la.auditory_id = ?
    `).all(date, auditoryId);
}

function getNormalizedBuildingsList() {
    const d = getDb();
    return d.prepare(`
        SELECT DISTINCT building FROM auditories
        WHERE building IS NOT NULL AND TRIM(building) <> ''
        ORDER BY building
    `).all().map(r => r.building);
}

function getNormalizedAuditoriesList(building = null) {
    const d = getDb();
    if (building) {
        const b = String(building).trim().toUpperCase();
        return d.prepare(`
            SELECT id, display_name AS rawName, room_number AS roomNumber, room_type AS roomType, building
            FROM auditories WHERE building = ?
            ORDER BY room_number, display_name
        `).all(b);
    }
    return d.prepare(`
        SELECT id, display_name AS rawName, room_number AS roomNumber, room_type AS roomType, building
        FROM auditories
        ORDER BY building, room_number, display_name
    `).all();
}

function getNormalizedRoomTypesList(building = null) {
    const d = getDb();
    if (building) {
        const b = String(building).trim().toUpperCase();
        return d.prepare(`
            SELECT DISTINCT room_type AS roomType FROM auditories
            WHERE building = ? AND room_type IS NOT NULL AND TRIM(room_type) <> ''
            ORDER BY room_type
        `).all(b).map(r => r.roomType);
    }
    return d.prepare(`
        SELECT DISTINCT room_type AS roomType FROM auditories
        WHERE room_type IS NOT NULL AND TRIM(room_type) <> ''
        ORDER BY room_type
    `).all().map(r => r.roomType);
}

function findAuditoryByQuery(auditoryQuery, building = null) {
    const d = getDb();
    const q = String(auditoryQuery ?? '').trim();
    if (!q) return null;
    const aliasId = findAuditoryIdByAlias(q);
    if (aliasId) {
        const row = d.prepare('SELECT id, display_name AS rawName, room_number AS roomNumber, room_type AS roomType, building FROM auditories WHERE id = ?').get(aliasId);
        if (row && (!building || row.building === String(building).trim().toUpperCase())) return row;
    }
    const row = d.prepare(`
        SELECT id, display_name AS rawName, room_number AS roomNumber, room_type AS roomType, building
        FROM auditories WHERE display_name = ?
    `).get(q);
    if (!row) return null;
    if (building && row.building !== String(building).trim().toUpperCase()) return null;
    return row;
}

function getGroupTeachersAndSubjectsRows(groupName) {
    const d = getDb();
    const groupId = getGroupIdForRead(groupName);
    if (!groupId) return null;
    return d.prepare(`
        SELECT l.date,
               (SELECT t.display_name FROM lesson_teachers lt JOIN teachers t ON t.id = lt.teacher_id
                WHERE lt.lesson_id = l.id LIMIT 1) AS teacher_name,
               sub.display_name AS subject_name
        FROM lessons l
        JOIN lesson_groups lg ON lg.lesson_id = l.id
        JOIN groups g ON g.id = lg.group_id
        JOIN subjects sub ON sub.id = l.subject_id
        WHERE g.id = ?
          AND EXISTS (SELECT 1 FROM lesson_teachers lt WHERE lt.lesson_id = l.id)
          AND l.subject_id IS NOT NULL
        ORDER BY l.date, teacher_name, subject_name
    `).all(groupId);
}

function getScheduleMaxCreatedAt(entityType, entityKey, date) {
    const d = getDb();
    let lessonTs = null;
    if (entityType === 'group') {
        const gid = getGroupIdForRead(entityKey);
        if (!gid) return null;
        const row = d.prepare(`
            SELECT MAX(l.last_seen_at) AS mx FROM lessons l
            JOIN lesson_groups lg ON lg.lesson_id = l.id
            WHERE lg.group_id = ? AND l.date = ?
        `).get(gid, date);
        lessonTs = row?.mx ?? null;
    } else if (entityType === 'teacher') {
        const tid = getTeacherIdForRead(entityKey);
        if (!tid) return null;
        const row = d.prepare(`
            SELECT MAX(l.last_seen_at) AS mx FROM lessons l
            JOIN lesson_teachers lt ON lt.lesson_id = l.id
            WHERE lt.teacher_id = ? AND l.date = ?
        `).get(tid, date);
        lessonTs = row?.mx ?? null;
    } else if (entityType === 'auditory') {
        const aid = resolveAuditoryIdForRead(entityKey);
        if (!aid) return null;
        const row = d.prepare(`
            SELECT MAX(l.last_seen_at) AS mx FROM lessons l
            JOIN lesson_auditories la ON la.lesson_id = l.id
            WHERE la.auditory_id = ? AND l.date = ?
        `).get(aid, date);
        lessonTs = row?.mx ?? null;
    }
    if (lessonTs != null) return lessonTs;
    const meta = getScheduleMeta(entityType, entityKey, date);
    return meta ? meta.updated_at : null;
}

function bumpScheduleCreatedAt(entityType, entityKey, date) {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    if (entityType === 'group') {
        const gid = getGroupIdForRead(entityKey);
        if (gid) {
            d.prepare(`
                UPDATE lessons SET last_seen_at = ?
                WHERE id IN (SELECT lesson_id FROM lesson_groups WHERE group_id = ?) AND date = ?
            `).run(now, gid, date);
        }
    } else if (entityType === 'teacher') {
        const tid = getTeacherIdForRead(entityKey);
        if (tid) {
            d.prepare(`
                UPDATE lessons SET last_seen_at = ?
                WHERE id IN (SELECT lesson_id FROM lesson_teachers WHERE teacher_id = ?) AND date = ?
            `).run(now, tid, date);
        }
    } else if (entityType === 'auditory') {
        const aid = resolveAuditoryIdForRead(entityKey);
        if (aid) {
            d.prepare(`
                UPDATE lessons SET last_seen_at = ?
                WHERE id IN (SELECT lesson_id FROM lesson_auditories WHERE auditory_id = ?) AND date = ?
            `).run(now, aid, date);
        }
    }
    d.prepare(`
        UPDATE schedule_meta SET updated_at = ? WHERE entity_type = ? AND entity_key = ? AND date = ?
    `).run(now, entityType, entityKey, date);
}

// --- Ops ---

function insertRequestStats({ ip, userAgent, entityType, entityKey, requestedAt, processingTimeMs, type: responseType, source }) {
    const d = getDb();
    const requestedAtSec = requestedAt != null ? Math.floor(Number(requestedAt) / 1000) : Math.floor(Date.now() / 1000);
    const src = (source === 'cache' || source === 'db' || source === 'source' || source === 'source_asked') ? source : 'cache';
    const r = d.prepare(`
        INSERT INTO request_stats (ip, user_agent, entity_type, entity_key, requested_at, processing_time_ms, response_type, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ip ?? null, userAgent ?? null, entityType, entityKey, requestedAtSec, processingTimeMs, responseType ?? null, src);
    return r.lastInsertRowid;
}

function getTopRequestedEntities(sinceDays = 7, limitPerType = 5) {
    const d = getDb();
    const since = Math.floor(Date.now() / 1000) - sinceDays * 86400;
    const rows = d.prepare(`
        SELECT entity_type, entity_key, COUNT(*) AS cnt
        FROM request_stats WHERE requested_at >= ?
        GROUP BY entity_type, entity_key
        ORDER BY entity_type, cnt DESC
    `).all(since);
    const byType = { group: [], teacher: [], auditory: [] };
    for (const r of rows) {
        if (byType[r.entity_type].length < limitPerType) {
            byType[r.entity_type].push({ entity_type: r.entity_type, entity_key: r.entity_key, request_count: r.cnt });
        }
    }
    return [...byType.group, ...byType.teacher, ...byType.auditory];
}

function upsertPreloadState(entities) {
    const d = getDb();
    runInTransaction(() => {
        d.prepare('DELETE FROM preload_state').run();
        const stmt = d.prepare('INSERT INTO preload_state (entity_type, entity_key, request_count) VALUES (?, ?, ?)');
        for (const e of entities) stmt.run(e.entity_type, e.entity_key, e.request_count || 0);
    });
}

function getPreloadStateEntities() {
    return getDb().prepare('SELECT entity_type, entity_key FROM preload_state').all();
}

function updateLastPreloaded(entityType, entityKey) {
    getDb().prepare('UPDATE preload_state SET last_preloaded_at = unixepoch() WHERE entity_type = ? AND entity_key = ?')
        .run(entityType, entityKey);
}

// --- tgbot (copied from legacy db.js) ---

function getTgSubsByChatId(chatId) {
    return getDb().prepare('SELECT * FROM tgbot_subscriptions WHERE chat_id = ? AND type = ? ORDER BY id').all(String(chatId), 'group');
}

function addTgGroupSub(chatId, entityType, entityKey, toSendTime = '07:00', silent = 0) {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    const silentVal = silent ? 1 : 0;
    const existing = d.prepare('SELECT id FROM tgbot_subscriptions WHERE chat_id = ? AND type = ? AND entity_type = ? AND entity_key = ?')
        .get(String(chatId), 'group', entityType, entityKey);
    if (existing) {
        d.prepare('UPDATE tgbot_subscriptions SET to_send_time = ?, silent = ?, updated_at = ? WHERE id = ?')
            .run(toSendTime, silentVal, now, existing.id);
        return existing.id;
    }
    const r = d.prepare(`
        INSERT INTO tgbot_subscriptions (type, chat_id, user_id, entity_type, entity_key, to_send_time, silent, requested_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
    `).run('group', String(chatId), entityType, entityKey, toSendTime, silentVal, now, now);
    return r.lastInsertRowid;
}

function removeTgGroupSub(chatId, entityType, entityKey) {
    return getDb().prepare('DELETE FROM tgbot_subscriptions WHERE chat_id = ? AND type = ? AND entity_type = ? AND entity_key = ?')
        .run(String(chatId), 'group', entityType, entityKey);
}

function removeTgGroupSubAll(chatId) {
    return getDb().prepare('DELETE FROM tgbot_subscriptions WHERE chat_id = ? AND type = ?').run(String(chatId), 'group');
}

function getTgUserSubscriptions(userId) {
    return getDb().prepare('SELECT * FROM tgbot_subscriptions WHERE user_id = ? AND type = ? ORDER BY id').all(String(userId), 'private');
}

function addTgSubscription(userId, entityType, entityKey, toSendTime = '07:00', silent = 0) {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    const silentVal = silent ? 1 : 0;
    const r = d.prepare(`
        INSERT INTO tgbot_subscriptions (type, chat_id, user_id, entity_type, entity_key, to_send_time, silent, requested_at, updated_at)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `).run('private', String(userId), entityType, entityKey, toSendTime, silentVal, now, now);
    return r.lastInsertRowid;
}

function removeTgSubscription(userId, subscriptionId) {
    return getDb().prepare('DELETE FROM tgbot_subscriptions WHERE user_id = ? AND type = ? AND id = ?')
        .run(String(userId), 'private', subscriptionId);
}

function removeTgSubscriptionAll(userId) {
    return getDb().prepare('DELETE FROM tgbot_subscriptions WHERE user_id = ? AND type = ?').run(String(userId), 'private');
}

function getTgSubscriptionsDueForTime(hhmm) {
    return getDb().prepare('SELECT * FROM tgbot_subscriptions WHERE to_send_time = ?').all(hhmm);
}

function getTgUserLang(userId) {
    const row = getDb().prepare('SELECT lang FROM tgbot_prefs WHERE user_id = ?').get(String(userId));
    return row ? row.lang : null;
}

function setTgUserLang(userId, lang) {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    const existing = d.prepare('SELECT id FROM tgbot_prefs WHERE user_id = ?').get(String(userId));
    if (existing) {
        d.prepare('UPDATE tgbot_prefs SET lang = ?, updated_at = ? WHERE user_id = ?').run(lang, now, String(userId));
    } else {
        d.prepare('INSERT INTO tgbot_prefs (user_id, chat_id, lang, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)')
            .run(String(userId), lang, now, now);
    }
}

function getTgChatLang(chatId) {
    const row = getDb().prepare('SELECT lang FROM tgbot_prefs WHERE chat_id = ?').get(String(chatId));
    return row ? row.lang : null;
}

function setTgChatLang(chatId, lang) {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    const existing = d.prepare('SELECT id FROM tgbot_prefs WHERE chat_id = ?').get(String(chatId));
    if (existing) {
        d.prepare('UPDATE tgbot_prefs SET lang = ?, updated_at = ? WHERE chat_id = ?').run(lang, now, String(chatId));
    } else {
        d.prepare('INSERT INTO tgbot_prefs (user_id, chat_id, lang, created_at, updated_at) VALUES (NULL, ?, ?, ?, ?)')
            .run(String(chatId), lang, now, now);
    }
}

function updateTgUserSendTime(userId, toSendTime) {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    return d.prepare('UPDATE tgbot_subscriptions SET to_send_time = ?, updated_at = ? WHERE user_id = ? AND type = ?')
        .run(toSendTime, now, String(userId), 'private');
}

function updateTgChatSendTime(chatId, toSendTime) {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    return d.prepare('UPDATE tgbot_subscriptions SET to_send_time = ?, updated_at = ? WHERE chat_id = ? AND type = ?')
        .run(toSendTime, now, String(chatId), 'group');
}

function toggleTgSubscriptionSilent(subscriptionId, { userId, chatId }) {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    let row;
    if (userId != null) {
        row = d.prepare('SELECT id, silent FROM tgbot_subscriptions WHERE id = ? AND user_id = ? AND type = ?')
            .get(subscriptionId, String(userId), 'private');
    } else if (chatId != null) {
        row = d.prepare('SELECT id, silent FROM tgbot_subscriptions WHERE id = ? AND chat_id = ? AND type = ?')
            .get(subscriptionId, String(chatId), 'group');
    } else return null;
    if (!row) return null;
    const next = row.silent ? 0 : 1;
    d.prepare('UPDATE tgbot_subscriptions SET silent = ?, updated_at = ? WHERE id = ?').run(next, now, row.id);
    return next;
}

function setTgSubscriptionSilent(subscriptionId, silent, { userId, chatId }) {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    const val = silent ? 1 : 0;
    if (userId != null) {
        const r = d.prepare('UPDATE tgbot_subscriptions SET silent = ?, updated_at = ? WHERE id = ? AND user_id = ? AND type = ?')
            .run(val, now, subscriptionId, String(userId), 'private');
        return r.changes > 0;
    }
    if (chatId != null) {
        const r = d.prepare('UPDATE tgbot_subscriptions SET silent = ?, updated_at = ? WHERE id = ? AND chat_id = ? AND type = ?')
            .run(val, now, subscriptionId, String(chatId), 'group');
        return r.changes > 0;
    }
    return false;
}

const INLINE_LUT_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const INLINE_LUT_CODE_LEN = 6;

function randomInlineLutCode() {
    let s = '';
    for (let i = 0; i < INLINE_LUT_CODE_LEN; i++) {
        s += INLINE_LUT_ALPHABET[Math.floor(Math.random() * INLINE_LUT_ALPHABET.length)];
    }
    return s;
}

function getOrCreateTgInlineLutId(entityType, entityKey, scope, lang) {
    const d = getDb();
    let row = d.prepare('SELECT code FROM tgbot_inline_lut WHERE entity_type = ? AND entity_key = ? AND scope = ? AND lang = ?')
        .get(entityType, entityKey, scope, lang);
    if (row) return row.code;
    return d.transaction(() => {
        row = d.prepare('SELECT code FROM tgbot_inline_lut WHERE entity_type = ? AND entity_key = ? AND scope = ? AND lang = ?')
            .get(entityType, entityKey, scope, lang);
        if (row) return row.code;
        for (let attempt = 0; attempt < 10; attempt++) {
            const code = randomInlineLutCode();
            try {
                d.prepare('INSERT INTO tgbot_inline_lut (code, entity_type, entity_key, scope, lang) VALUES (?, ?, ?, ?, ?)')
                    .run(code, entityType, entityKey, scope, lang);
                return code;
            } catch (e) {
                if (e.code !== 'SQLITE_CONSTRAINT' && e.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY') throw e;
            }
        }
        return null;
    })();
}

function getTgInlineLutByCode(code) {
    if (!code || (code.length !== 6 && code.length !== 4)) return null;
    const row = getDb().prepare('SELECT entity_type AS entityType, entity_key AS entityKey, scope, lang FROM tgbot_inline_lut WHERE code = ?').get(code);
    return row || null;
}

// --- Migrate helpers ---

function attachLegacyDb(legacyPath) {
    const d = getDb();
    d.prepare('ATTACH DATABASE ? AS legacy').run(legacyPath);
}

function detachLegacyDb() {
    getDb().prepare('DETACH DATABASE legacy').run();
}

function copyLegacyTable(tableName) {
    const d = getDb();
    d.exec(`DELETE FROM ${tableName}`);
    d.exec(`INSERT INTO main.${tableName} SELECT * FROM legacy.${tableName}`);
}

module.exports = {
    getDb,
    runInTransaction,
    getDayOfWeek,
    formatDateDisplay,
    upsertGroupCanon,
    upsertGroupAlias,
    findGroupIdByAlias,
    findGroupIdByDisplayName,
    findGroupIdByCanonicalKey,
    findGroupAliasBySource,
    upsertTeacherCanon,
    upsertTeacherAlias,
    findTeacherIdByAlias,
    findTeacherIdByCanonicalKey,
    findTeacherAliasBySource,
    upsertSubjectCanon,
    upsertSubjectAlias,
    upsertAuditoryCanon,
    upsertAuditoryAlias,
    findAuditoryIdByAlias,
    findAuditoryIdByCanonicalKey,
    findAuditoryAliasBySource,
    findAuditoryByCanonicalKey,
    findLessonByFusionKey,
    findLessonBySlotCanon,
    createLesson,
    touchLesson,
    updateLessonFields,
    decrementLessonConfidence,
    linkLessonGroup,
    linkLessonTeacher,
    linkLessonAuditory,
    getSourceId,
    insertIngestBatch,
    incrementBatchLessonsSeen,
    updateBatchStatus,
    linkLessonIngest,
    upsertScheduleMeta,
    getScheduleMeta,
    getScheduleDatesFrom,
    getGroupIdForRead,
    getTeacherIdForRead,
    resolveAuditoryIdForRead,
    getStudentLessonRows,
    getTeacherLessonRows,
    getAuditoryLessonRows,
    getDynamicSlotRows,
    getAuditoriesByBuilding,
    getOccupiedAuditoryIds,
    getAuditoryOccupiedSlots,
    getNormalizedBuildingsList,
    getNormalizedAuditoriesList,
    getNormalizedRoomTypesList,
    findAuditoryByQuery,
    getGroupTeachersAndSubjectsRows,
    getScheduleMaxCreatedAt,
    bumpScheduleCreatedAt,
    insertRequestStats,
    getTopRequestedEntities,
    upsertPreloadState,
    getPreloadStateEntities,
    updateLastPreloaded,
    getTgSubsByChatId,
    addTgGroupSub,
    removeTgGroupSub,
    removeTgGroupSubAll,
    getTgUserSubscriptions,
    addTgSubscription,
    removeTgSubscription,
    removeTgSubscriptionAll,
    getTgSubscriptionsDueForTime,
    getTgUserLang,
    setTgUserLang,
    getTgChatLang,
    setTgChatLang,
    updateTgUserSendTime,
    updateTgChatSendTime,
    toggleTgSubscriptionSilent,
    setTgSubscriptionSilent,
    getOrCreateTgInlineLutId,
    getTgInlineLutByCode,
    attachLegacyDb,
    detachLegacyDb,
    copyLegacyTable
};
