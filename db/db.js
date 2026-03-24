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
    } catch (_) { }
    if (!columnExists(d, 'schedule_slots', 'auditory_id')) {
        d.exec('ALTER TABLE schedule_slots ADD COLUMN auditory_id INTEGER REFERENCES auditories(id)');
    }
    if (!columnExists(d, 'schedule_slots', 'normalized_auditory_id')) {
        try {
            d.exec('ALTER TABLE schedule_slots ADD COLUMN normalized_auditory_id INTEGER REFERENCES normalized_auditories(id)');
        } catch (_) {
            // Fallback for older SQLite variations where REFERENCES in ADD COLUMN can fail.
            d.exec('ALTER TABLE schedule_slots ADD COLUMN normalized_auditory_id INTEGER');
        }
    }
    try {
        d.exec('CREATE INDEX IF NOT EXISTS idx_schedule_slots_auditory_date ON schedule_slots(auditory_id, date)');
        d.exec('CREATE INDEX IF NOT EXISTS idx_schedule_slots_normalized_auditory_date ON schedule_slots(normalized_auditory_id, date)');
        d.exec('CREATE INDEX IF NOT EXISTS idx_schedule_slots_free_search ON schedule_slots(date, normalized_auditory_id, time_start, time_end)');
        d.exec('CREATE INDEX IF NOT EXISTS idx_normalized_auditories_building ON normalized_auditories(building)');
        d.exec('CREATE INDEX IF NOT EXISTS idx_normalized_auditories_room_type ON normalized_auditories(room_type)');
    } catch (_) { }
    migrateEntityTypeToIncludeAuditory(d);
    migrateSourceAsked(d);
    migrateClassroomsToAuditories(d);
    migrateNormalizedAuditories(d);
    try {
        d.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_slots_dedup
            ON schedule_slots (group_id, date, time_start, time_end,
                COALESCE(subject_id, -1), COALESCE(teacher_id, -1), COALESCE(auditory_id, -1))
        `);
    } catch (_) {
        // Index creation fails if duplicates exist; run scripts/dedupe-schedule-slots.js then restart
    }
    const hasPreloadState = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='preload_state'").get();
    if (!hasPreloadState) {
        d.exec(`
            CREATE TABLE preload_state (
              entity_type TEXT NOT NULL CHECK (entity_type IN ('group', 'teacher', 'auditory')),
              entity_key TEXT NOT NULL,
              request_count INTEGER NOT NULL DEFAULT 0,
              last_preloaded_at INTEGER,
              PRIMARY KEY (entity_type, entity_key)
            )
        `);
    }
    migrateTgbotTables(d);
}

// ----------- tgbot integration -----------
function migrateTgbotTables(d) {
    const hasSubs = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tgbot_subscriptions'").get();
    if (!hasSubs) {
        d.exec(`
            CREATE TABLE tgbot_subscriptions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              type TEXT NOT NULL CHECK (type IN ('group', 'private')),
              chat_id TEXT,
              user_id TEXT,
              entity_type TEXT NOT NULL CHECK (entity_type IN ('group', 'teacher', 'auditory')),
              entity_key TEXT NOT NULL,
              to_send_time TEXT NOT NULL DEFAULT '07:00',
              requested_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
        `);
        d.exec('CREATE INDEX IF NOT EXISTS idx_tgbot_subs_chat ON tgbot_subscriptions(chat_id)');
        d.exec('CREATE INDEX IF NOT EXISTS idx_tgbot_subs_user ON tgbot_subscriptions(user_id)');
        d.exec('CREATE INDEX IF NOT EXISTS idx_tgbot_subs_due ON tgbot_subscriptions(to_send_time)');
    }
    const hasPrefs = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tgbot_prefs'").get();
    if (!hasPrefs) {
        d.exec(`
            CREATE TABLE tgbot_prefs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id TEXT,
              chat_id TEXT,
              lang TEXT NOT NULL CHECK (lang IN ('ru', 'en')),
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              UNIQUE(user_id),
              UNIQUE(chat_id)
            )
        `);
    }
    const hasLut = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tgbot_inline_lut'").get();
    if (!hasLut) {
        d.exec(`
            CREATE TABLE tgbot_inline_lut (
              code TEXT PRIMARY KEY,
              entity_type TEXT NOT NULL CHECK (entity_type IN ('group', 'teacher', 'auditory')),
              entity_key TEXT NOT NULL,
              scope TEXT NOT NULL CHECK (scope IN ('today', 'week', 'tomorrow')),
              lang TEXT NOT NULL CHECK (lang IN ('ru', 'en')),
              UNIQUE(entity_type, entity_key, scope, lang)
            )
        `);
    } else {
        const info = d.prepare("PRAGMA table_info(tgbot_inline_lut)").all();
        const hasIdCol = info.some(c => c.name === 'id');
        if (hasIdCol) {
            migrateTgbotInlineLutIdToCode(d);
        }
        const hasSeq = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tgbot_inline_seq'").get();
        if (hasSeq) {
            d.exec('DROP TABLE tgbot_inline_seq');
        }
    }
}
function migrateTgbotInlineLutIdToCode(d) {
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const R = 64, L = 4;
    function enc(n) {
        if (n < 0 || n >= Math.pow(R, L)) return null;
        let s = '';
        for (let i = 0; i < L; i++) { s = ALPHABET[n % R] + s; n = Math.floor(n / R); }
        return s;
    }
    const rows = d.prepare('SELECT id, entity_type, entity_key, scope, lang FROM tgbot_inline_lut').all();
    d.exec(`
        CREATE TABLE tgbot_inline_lut_new (
          code TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL CHECK (entity_type IN ('group', 'teacher', 'auditory')),
          entity_key TEXT NOT NULL,
          scope TEXT NOT NULL CHECK (scope IN ('today', 'week', 'tomorrow')),
          lang TEXT NOT NULL CHECK (lang IN ('ru', 'en')),
          UNIQUE(entity_type, entity_key, scope, lang)
        )
    `);
    const ins = d.prepare('INSERT INTO tgbot_inline_lut_new (code, entity_type, entity_key, scope, lang) VALUES (?, ?, ?, ?, ?)');
    for (const r of rows) {
        const code = enc(r.id);
        if (code) ins.run(code, r.entity_type, r.entity_key, r.scope, r.lang);
    }
    d.exec('DROP TABLE tgbot_inline_lut');
    d.exec('ALTER TABLE tgbot_inline_lut_new RENAME TO tgbot_inline_lut');
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
    } catch (_) { }
    d.pragma('foreign_keys = ON');
}

function normalizeRoomType(rawType) {
    if (!rawType) return null;
    const t = String(rawType).toLowerCase().trim();
    if (!t) return null;
    if (t.includes('комп') || t.includes('информ')) return 'комп';
    if (t.includes('лаб')) return 'лаб';
    if (t.includes('пр')) return 'пр';
    if (t === 'л' || t.includes('лек')) return 'лек';
    if (t.includes('дис')) return 'дис';
    if (t.includes('мастер')) return 'мастер';
    return t;
}

function parseAuditoryParts(rawName) {
    const raw = String(rawName ?? '').replace(/\s+/g, ' ').trim();
    if (!raw) {
        return { rawName: '', roomNumber: null, roomType: null, building: null, normalizedKey: '' };
    }
    const slashIdx = raw.indexOf('/');
    let left = slashIdx >= 0 ? raw.slice(0, slashIdx).trim() : raw;
    const right = slashIdx >= 0 ? raw.slice(slashIdx + 1).trim() : '';

    // Ignore leading section markers (А/Б/В/Г/Д) before actual room token.
    left = left.replace(/^[АБВГД]\s*/iu, '').trim();
    const hasAngl = /англ/iu.test(left);

    // Room number stores only digits by requirement.
    const roomDigits = (left.match(/\d+/u) || [null])[0];
    const roomNumber = roomDigits || null;

    let rest = left;
    if (roomDigits) {
        const idx = rest.indexOf(roomDigits);
        rest = idx >= 0 ? (rest.slice(0, idx) + ' ' + rest.slice(idx + roomDigits.length)).trim() : rest;
    }
    // Drop one-letter noise prefixes that sometimes appear before type text.
    rest = rest.replace(/^[АБВГД]\s*/iu, '').trim();
    let roomType = normalizeRoomType(rest);
    if (!roomType && hasAngl) roomType = 'англ';

    const building = right ? right.toUpperCase() : null;
    const normalizedKey = `${roomNumber || ''}|${roomType || ''}|${building || ''}`;
    return { rawName: raw, roomNumber: roomNumber || null, roomType, building, normalizedKey };
}

function ensureNormalizedAuditory(rawName) {
    const d = getDb();
    const parts = parseAuditoryParts(rawName);
    if (!parts.rawName) return null;
    let row = d.prepare('SELECT id FROM normalized_auditories WHERE raw_name = ?').get(parts.rawName);
    if (row) return row.id;
    row = d.prepare('SELECT id FROM normalized_auditories WHERE normalized_key = ?').get(parts.normalizedKey);
    if (row) {
        d.prepare('UPDATE normalized_auditories SET raw_name = ?, updated_at = unixepoch() WHERE id = ?').run(parts.rawName, row.id);
        return row.id;
    }
    const result = d.prepare(`
        INSERT INTO normalized_auditories (raw_name, room_number, room_type, building, normalized_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())
    `).run(parts.rawName, parts.roomNumber, parts.roomType, parts.building, parts.normalizedKey);
    return result.lastInsertRowid;
}

function migrateNormalizedAuditories(d) {
    if (!columnExists(d, 'schedule_slots', 'normalized_auditory_id')) return;
    const hasTable = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='normalized_auditories'").get();
    if (!hasTable) {
        d.exec(`
            CREATE TABLE normalized_auditories (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              raw_name TEXT NOT NULL UNIQUE,
              room_number TEXT,
              room_type TEXT,
              building TEXT,
              normalized_key TEXT NOT NULL UNIQUE,
              created_at INTEGER NOT NULL DEFAULT (unixepoch()),
              updated_at INTEGER NOT NULL DEFAULT (unixepoch())
            )
        `);
    }

    // Seed normalized table from raw auditories names even before slot relinking.
    const rawAuditories = d.prepare('SELECT name FROM auditories').all();
    for (const row of rawAuditories) {
        try { ensureNormalizedAuditory(row.name); } catch (_) { }
    }

    const rows = d.prepare(`
        SELECT s.id AS slot_id, a.name AS auditory_name
        FROM schedule_slots s
        LEFT JOIN auditories a ON a.id = s.auditory_id
        WHERE s.auditory_id IS NOT NULL
          AND s.normalized_auditory_id IS NULL
    `).all();
    if (!rows.length) return;
    const updateSlot = d.prepare('UPDATE schedule_slots SET normalized_auditory_id = ? WHERE id = ?');
    const upsertNorm = d.transaction(() => {
        for (const row of rows) {
            const normId = ensureNormalizedAuditory(row.auditory_name || '');
            if (normId) updateSlot.run(normId, row.slot_id);
        }
    });
    upsertNorm();
}

function rebuildNormalizedAuditories() {
    const d = getDb();
    if (!columnExists(d, 'schedule_slots', 'normalized_auditory_id')) return;
    const run = d.transaction(() => {
        d.prepare('UPDATE schedule_slots SET normalized_auditory_id = NULL').run();
        d.prepare('DELETE FROM normalized_auditories').run();

        const fromAuditories = d.prepare('SELECT name FROM auditories').all();
        for (const row of fromAuditories) {
            try { ensureNormalizedAuditory(row.name); } catch (_) { }
        }

        const slots = d.prepare(`
            SELECT s.id AS slot_id, a.name AS auditory_name
            FROM schedule_slots s
            LEFT JOIN auditories a ON a.id = s.auditory_id
            WHERE s.auditory_id IS NOT NULL
        `).all();
        const upd = d.prepare('UPDATE schedule_slots SET normalized_auditory_id = ? WHERE id = ?');
        for (const row of slots) {
            const normId = ensureNormalizedAuditory(row.auditory_name || '');
            if (normId) upd.run(normId, row.slot_id);
        }
    });
    run();
}

function getNormalizedBuildings() {
    const d = getDb();
    return d.prepare(`
        SELECT DISTINCT building
        FROM normalized_auditories
        WHERE building IS NOT NULL AND TRIM(building) <> ''
        ORDER BY building
    `).all().map(r => r.building);
}

function getNormalizedAuditories(building = null) {
    const d = getDb();
    if (building) {
        const b = String(building).trim().toUpperCase();
        return d.prepare(`
            SELECT id, raw_name AS rawName, room_number AS roomNumber, room_type AS roomType, building
            FROM normalized_auditories
            WHERE building = ?
            ORDER BY room_number, raw_name
        `).all(b);
    }
    return d.prepare(`
        SELECT id, raw_name AS rawName, room_number AS roomNumber, room_type AS roomType, building
        FROM normalized_auditories
        ORDER BY building, room_number, raw_name
    `).all();
}

function getNormalizedRoomTypes(building = null) {
    const d = getDb();
    if (building) {
        const b = String(building).trim().toUpperCase();
        return d.prepare(`
            SELECT DISTINCT room_type AS roomType
            FROM normalized_auditories
            WHERE building = ? AND room_type IS NOT NULL AND TRIM(room_type) <> ''
            ORDER BY room_type
        `).all(b).map(r => r.roomType);
    }
    return d.prepare(`
        SELECT DISTINCT room_type AS roomType
        FROM normalized_auditories
        WHERE room_type IS NOT NULL AND TRIM(room_type) <> ''
        ORDER BY room_type
    `).all().map(r => r.roomType);
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
    try { d.exec('CREATE INDEX IF NOT EXISTS idx_request_stats_requested_at ON request_stats(requested_at)'); } catch (_) { }
    try { d.exec('CREATE INDEX IF NOT EXISTS idx_request_stats_entity ON request_stats(entity_type, entity_key)'); } catch (_) { }
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
    try { d.exec('CREATE INDEX IF NOT EXISTS idx_request_stats_requested_at ON request_stats(requested_at)'); } catch (_) { }
    try { d.exec('CREATE INDEX IF NOT EXISTS idx_request_stats_entity ON request_stats(entity_type, entity_key)'); } catch (_) { }

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
    try { d.exec('CREATE INDEX IF NOT EXISTS idx_schedule_meta_lookup ON schedule_meta(entity_type, entity_key, date)'); } catch (_) { }
    try { d.exec('CREATE INDEX IF NOT EXISTS idx_schedule_meta_request_stats_id ON schedule_meta(request_stats_id)'); } catch (_) { }
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
    const teacherId = row.teacher_id ?? null;
    const subjectId = row.subject_id ?? null;
    const auditoryId = row.auditory_id ?? null;
    const normalizedAuditoryId = row.normalized_auditory_id ?? null;
    const exists = d.prepare(`
        SELECT 1 FROM schedule_slots
        WHERE group_id = ? AND date = ? AND time_start = ? AND time_end = ?
          AND COALESCE(subject_id, -1) = COALESCE(?, -1)
          AND COALESCE(teacher_id, -1) = COALESCE(?, -1)
          AND COALESCE(auditory_id, -1) = COALESCE(?, -1)
        LIMIT 1
    `).get(row.group_id, row.date, row.time_start, row.time_end, subjectId, teacherId, auditoryId);
    if (exists) return;
    d.prepare(`
        INSERT OR IGNORE INTO schedule_slots (date, time_start, time_end, group_id, teacher_id, subject_id, auditory_id, normalized_auditory_id, lesson_type, subgroup, request_stats_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        row.date,
        row.time_start,
        row.time_end,
        row.group_id,
        teacherId,
        subjectId,
        auditoryId,
        normalizedAuditoryId,
        row.lesson_type ?? null,
        row.subgroup ?? null,
        row.request_stats_id ?? null
    );
}

// created_at для schedule_meta задаётся здесь; для schedule_slots — DEFAULT (unixepoch()) в схеме при INSERT
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
        const auditory = (r.auditory_name != null ? String(r.auditory_name) : '');
        return {
            time: `${r.time_start}-${r.time_end}`,
            type: (r.lesson_type != null ? String(r.lesson_type) : ''),
            name: (r.subject_name != null ? String(r.subject_name) : ''),
            subgroup: (r.subgroup != null ? String(r.subgroup) : ''),
            groups: [r.group_name],
            auditory,
            room: auditory,
            teacher: (r.teacher_name != null ? String(r.teacher_name) : '')
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

function parseTimeRange(timeRange) {
    if (!timeRange || typeof timeRange !== 'string' || !timeRange.includes('-')) return null;
    const [start, end] = timeRange.split('-').map(s => s.trim());
    if (!start || !end) return null;
    return { start, end };
}

function getDynamicSlotsByDate(date, building = null) {
    const d = getDb();
    const buildingFilter = building ? String(building).trim().toUpperCase() : null;
    const params = [date];
    let where = 's.date = ?';
    if (buildingFilter) {
        where += ' AND na.building = ?';
        params.push(buildingFilter);
    }
    return d.prepare(`
        SELECT DISTINCT s.time_start, s.time_end
        FROM schedule_slots s
        LEFT JOIN normalized_auditories na ON na.id = s.normalized_auditory_id
        WHERE ${where}
        ORDER BY s.time_start, s.time_end
    `).all(...params).map(r => `${r.time_start}-${r.time_end}`);
}

function getFreeAuditoriesBySlot(date, timeRange, building, roomType = null) {
    const d = getDb();
    const parsed = parseTimeRange(timeRange);
    if (!parsed) return [];
    const buildingFilter = String(building ?? '').trim().toUpperCase();
    if (!buildingFilter) return [];
    const typeFilter = roomType ? normalizeRoomType(roomType) : null;
    const params = [buildingFilter];
    let typeWhere = '';
    if (typeFilter) {
        typeWhere = ' AND na.room_type = ?';
        params.push(typeFilter);
    }
    const allRooms = d.prepare(`
        SELECT na.id, na.raw_name, na.room_number, na.room_type, na.building
        FROM normalized_auditories na
        WHERE na.building = ? ${typeWhere}
        ORDER BY na.room_number, na.raw_name
    `).all(...params);
    if (!allRooms.length) return [];
    const occupiedRows = d.prepare(`
        SELECT DISTINCT s.normalized_auditory_id AS id
        FROM schedule_slots s
        JOIN normalized_auditories na ON na.id = s.normalized_auditory_id
        WHERE s.date = ?
          AND na.building = ?
          AND s.normalized_auditory_id IS NOT NULL
          AND s.time_start < ?
          AND s.time_end > ?
          ${typeFilter ? 'AND na.room_type = ?' : ''}
    `).all(date, buildingFilter, parsed.end, parsed.start, ...(typeFilter ? [typeFilter] : []));
    const occupiedIds = new Set(occupiedRows.map(r => r.id));
    return allRooms
        .filter(r => !occupiedIds.has(r.id))
        .map(r => ({
            id: r.id,
            rawName: r.raw_name,
            roomNumber: r.room_number,
            roomType: r.room_type,
            building: r.building
        }));
}

function findNormalizedAuditoryByQuery(query, building = null) {
    const d = getDb();
    const q = String(query ?? '').trim();
    if (!q) return null;
    const upper = q.toUpperCase();
    if (building) {
        const b = String(building).trim().toUpperCase();
        return d.prepare(`
            SELECT id, raw_name, room_number, room_type, building
            FROM normalized_auditories
            WHERE building = ? AND (raw_name = ? OR room_number = ? OR raw_name LIKE ?)
            ORDER BY CASE WHEN raw_name = ? THEN 0 ELSE 1 END, id
            LIMIT 1
        `).get(b, q, upper, `%${q}%`, q) || null;
    }
    return d.prepare(`
        SELECT id, raw_name, room_number, room_type, building
        FROM normalized_auditories
        WHERE raw_name = ? OR room_number = ? OR raw_name LIKE ?
        ORDER BY CASE WHEN raw_name = ? THEN 0 ELSE 1 END, id
        LIMIT 1
    `).get(q, upper, `%${q}%`, q) || null;
}

function getFreeSlotsByAuditory(date, auditoryQuery, building = null) {
    const d = getDb();
    const room = findNormalizedAuditoryByQuery(auditoryQuery, building);
    if (!room) return null;
    const slots = getDynamicSlotsByDate(date, room.building);
    const occupied = d.prepare(`
        SELECT time_start, time_end
        FROM schedule_slots
        WHERE date = ? AND normalized_auditory_id = ?
    `).all(date, room.id).map(r => `${r.time_start}-${r.time_end}`);
    const occupiedSet = new Set(occupied);
    const freeSlots = slots.filter(s => !occupiedSet.has(s));
    return {
        auditory: {
            id: room.id,
            rawName: room.raw_name,
            roomNumber: room.room_number,
            roomType: room.room_type,
            building: room.building
        },
        freeSlots,
        occupiedSlots: slots.filter(s => occupiedSet.has(s))
    };
}

function formatDateDisplay(isoDate) {
    const [y, m, d] = isoDate.split('-');
    const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${y}`;
}

/** Возраст данных для (entity_type, entity_key, date): max(created_at) из слотов или created_at из меты (для «Нет пар»). */
function getScheduleMaxCreatedAt(entityType, entityKey, date) {
    const d = getDb();
    let id = null;
    let column = null;
    if (entityType === 'group') {
        const r = d.prepare('SELECT id FROM groups WHERE name = ?').get(entityKey);
        if (r) { id = r.id; column = 'group_id'; }
    } else if (entityType === 'teacher') {
        const r = d.prepare('SELECT id FROM teachers WHERE name = ?').get(entityKey);
        if (r) { id = r.id; column = 'teacher_id'; }
    } else if (entityType === 'auditory') {
        const r = d.prepare('SELECT id FROM auditories WHERE name = ?').get(entityKey);
        if (r) { id = r.id; column = 'auditory_id'; }
    }
    if (id == null || !column) return null;
    const slot = d.prepare(`SELECT MAX(created_at) AS mx FROM schedule_slots WHERE ${column} = ? AND date = ?`).get(id, date);
    if (slot && slot.mx != null) return slot.mx;
    const meta = d.prepare('SELECT created_at FROM schedule_meta WHERE entity_type = ? AND entity_key = ? AND date = ?').get(entityType, entityKey, date);
    return meta ? meta.created_at : null;
}

/** Минимальный возраст по семи дням с baseDate (для недели). */
function getScheduleMaxCreatedAtMinForWeek(entityType, entityKey, baseDate) {
    let minTs = null;
    for (let i = 0; i < 7; i++) {
        const d = new Date(baseDate + 'T12:00:00');
        d.setDate(d.getDate() + i);
        const dateStr = d.toISOString().split('T')[0];
        const ts = getScheduleMaxCreatedAt(entityType, entityKey, dateStr);
        if (ts == null) return null;
        if (minTs == null || ts < minTs) minTs = ts;
    }
    return minTs;
}

/** Обновить created_at для (entity_type, entity_key, date) без перезаписи слотов — только «тик» для эйджинга. */
function bumpScheduleCreatedAt(entityType, entityKey, date) {
    const d = getDb();
    let id = null;
    let column = null;
    if (entityType === 'group') {
        const r = d.prepare('SELECT id FROM groups WHERE name = ?').get(entityKey);
        if (r) { id = r.id; column = 'group_id'; }
    } else if (entityType === 'teacher') {
        const r = d.prepare('SELECT id FROM teachers WHERE name = ?').get(entityKey);
        if (r) { id = r.id; column = 'teacher_id'; }
    } else if (entityType === 'auditory') {
        const r = d.prepare('SELECT id FROM auditories WHERE name = ?').get(entityKey);
        if (r) { id = r.id; column = 'auditory_id'; }
    }
    if (id == null || !column) return;
    d.prepare(`UPDATE schedule_slots SET created_at = unixepoch() WHERE ${column} = ? AND date = ?`).run(id, date);
    d.prepare('UPDATE schedule_meta SET created_at = unixepoch() WHERE entity_type = ? AND entity_key = ? AND date = ?').run(entityType, entityKey, date);
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
                const normalizedAuditoryId = (roomName && String(roomName).trim()) ? ensureNormalizedAuditory(String(roomName).trim()) : null;
                insertScheduleSlot({
                    date: dateKey,
                    time_start: timeStart,
                    time_end: timeEnd,
                    group_id: groupId,
                    teacher_id: teacherId,
                    subject_id: subjectId,
                    auditory_id: auditoryId,
                    normalized_auditory_id: normalizedAuditoryId,
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
                const normalizedAuditoryId = (roomName && String(roomName).trim()) ? ensureNormalizedAuditory(String(roomName).trim()) : null;
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
                        normalized_auditory_id: normalizedAuditoryId,
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
                const normalizedAuditoryId = (roomName && String(roomName).trim()) ? ensureNormalizedAuditory(String(roomName).trim()) : null;
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
                        normalized_auditory_id: normalizedAuditoryId,
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

/** Топ запросов за sinceDays дней по request_stats; limitPerType — макс. записей на каждый entity_type. */
function getTopRequestedEntities(sinceDays = 7, limitPerType = 5) {
    const d = getDb();
    const since = Math.floor(Date.now() / 1000) - sinceDays * 86400;
    const rows = d.prepare(`
        SELECT entity_type, entity_key, COUNT(*) AS cnt
        FROM request_stats
        WHERE requested_at >= ?
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

/** Записать текущий топ в preload_state (заменяет содержимое). */
function upsertPreloadState(entities) {
    const d = getDb();
    const run = d.transaction((list) => {
        d.prepare('DELETE FROM preload_state').run();
        const stmt = d.prepare('INSERT INTO preload_state (entity_type, entity_key, request_count) VALUES (?, ?, ?)');
        for (const e of list) {
            stmt.run(e.entity_type, e.entity_key, e.request_count || 0);
        }
    });
    run(entities);
}

/** Список сущностей из preload_state для предзагрузки. */
function getPreloadStateEntities() {
    const d = getDb();
    return d.prepare('SELECT entity_type, entity_key FROM preload_state').all();
}

/** Обновить last_preloaded_at для сущности. */
function updateLastPreloaded(entityType, entityKey) {
    const d = getDb();
    d.prepare('UPDATE preload_state SET last_preloaded_at = unixepoch() WHERE entity_type = ? AND entity_key = ?').run(entityType, entityKey);
}

// ----------- tgbot integration (methods) -----------
function getTgSubsByChatId(chatId) {
    const d = getDb();
    return d.prepare('SELECT * FROM tgbot_subscriptions WHERE chat_id = ? AND type = ? ORDER BY id').all(String(chatId), 'group');
}

function addTgGroupSub(chatId, entityType, entityKey, toSendTime = '07:00') {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    const existing = d.prepare('SELECT id FROM tgbot_subscriptions WHERE chat_id = ? AND type = ? AND entity_type = ? AND entity_key = ?').get(String(chatId), 'group', entityType, entityKey);
    if (existing) {
        d.prepare('UPDATE tgbot_subscriptions SET to_send_time = ?, updated_at = ? WHERE id = ?').run(toSendTime, now, existing.id);
        return existing.id;
    }
    const r = d.prepare(`
        INSERT INTO tgbot_subscriptions (type, chat_id, user_id, entity_type, entity_key, to_send_time, requested_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
    `).run('group', String(chatId), entityType, entityKey, toSendTime, now, now);
    return r.lastInsertRowid;
}

function removeTgGroupSub(chatId, entityType, entityKey) {
    const d = getDb();
    return d.prepare('DELETE FROM tgbot_subscriptions WHERE chat_id = ? AND type = ? AND entity_type = ? AND entity_key = ?').run(String(chatId), 'group', entityType, entityKey);
}

function removeTgGroupSubAll(chatId) {
    const d = getDb();
    return d.prepare('DELETE FROM tgbot_subscriptions WHERE chat_id = ? AND type = ?').run(String(chatId), 'group');
}

function getTgUserSubscriptions(userId) {
    const d = getDb();
    return d.prepare('SELECT * FROM tgbot_subscriptions WHERE user_id = ? AND type = ? ORDER BY id').all(String(userId), 'private');
}

function addTgSubscription(userId, entityType, entityKey, toSendTime = '07:00') {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    const r = d.prepare(`
        INSERT INTO tgbot_subscriptions (type, chat_id, user_id, entity_type, entity_key, to_send_time, requested_at, updated_at)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?)
    `).run('private', String(userId), entityType, entityKey, toSendTime, now, now);
    return r.lastInsertRowid;
}

function removeTgSubscription(userId, subscriptionId) {
    const d = getDb();
    return d.prepare('DELETE FROM tgbot_subscriptions WHERE user_id = ? AND type = ? AND id = ?').run(String(userId), 'private', subscriptionId);
}

function removeTgSubscriptionAll(userId) {
    const d = getDb();
    return d.prepare('DELETE FROM tgbot_subscriptions WHERE user_id = ? AND type = ?').run(String(userId), 'private');
}

function getTgSubscriptionsDueForTime(hhmm) {
    const d = getDb();
    return d.prepare('SELECT * FROM tgbot_subscriptions WHERE to_send_time = ?').all(hhmm);
}

function getTgUserLang(userId) {
    const d = getDb();
    const row = d.prepare('SELECT lang FROM tgbot_prefs WHERE user_id = ?').get(String(userId));
    return row ? row.lang : null;
}

function setTgUserLang(userId, lang) {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    const existing = d.prepare('SELECT id FROM tgbot_prefs WHERE user_id = ?').get(String(userId));
    if (existing) {
        d.prepare('UPDATE tgbot_prefs SET lang = ?, updated_at = ? WHERE user_id = ?').run(lang, now, String(userId));
    } else {
        d.prepare('INSERT INTO tgbot_prefs (user_id, chat_id, lang, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)').run(String(userId), lang, now, now);
    }
}

function getTgChatLang(chatId) {
    const d = getDb();
    const row = d.prepare('SELECT lang FROM tgbot_prefs WHERE chat_id = ?').get(String(chatId));
    return row ? row.lang : null;
}

function setTgChatLang(chatId, lang) {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    const existing = d.prepare('SELECT id FROM tgbot_prefs WHERE chat_id = ?').get(String(chatId));
    if (existing) {
        d.prepare('UPDATE tgbot_prefs SET lang = ?, updated_at = ? WHERE chat_id = ?').run(lang, now, String(chatId));
    } else {
        d.prepare('INSERT INTO tgbot_prefs (user_id, chat_id, lang, created_at, updated_at) VALUES (NULL, ?, ?, ?, ?)').run(String(chatId), lang, now, now);
    }
}

/** Update to_send_time for all private subscriptions of a user. */
function updateTgUserSendTime(userId, toSendTime) {
    const d = getDb();
    const now = Math.floor(Date.now() / 1000);
    return d.prepare('UPDATE tgbot_subscriptions SET to_send_time = ?, updated_at = ? WHERE user_id = ? AND type = ?').run(toSendTime, now, String(userId), 'private');
}

/** Inline LUT: (entity_type, entity_key, scope, lang) <-> random 6-char code. A–Z, a–z, 0–9 => 62^6 codes. */
const INLINE_LUT_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const INLINE_LUT_CODE_LEN = 6;
const INLINE_LUT_MAX_ATTEMPTS = 10;

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
    const insert = d.transaction(() => {
        row = d.prepare('SELECT code FROM tgbot_inline_lut WHERE entity_type = ? AND entity_key = ? AND scope = ? AND lang = ?')
            .get(entityType, entityKey, scope, lang);
        if (row) return row.code;
        for (let attempt = 0; attempt < INLINE_LUT_MAX_ATTEMPTS; attempt++) {
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
    });
    return insert();
}

function getTgInlineLutByCode(code) {
    if (!code || (code.length !== 6 && code.length !== 4)) return null;
    const d = getDb();
    const row = d.prepare('SELECT entity_type AS entityType, entity_key AS entityKey, scope, lang FROM tgbot_inline_lut WHERE code = ?').get(code);
    return row || null;
}

module.exports = {
    getDb,
    ensureGroup,
    ensureTeacher,
    ensureAuditory,
    ensureNormalizedAuditory,
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
    getDynamicSlotsByDate,
    getFreeAuditoriesBySlot,
    getFreeSlotsByAuditory,
    getNormalizedBuildings,
    getNormalizedAuditories,
    getNormalizedRoomTypes,
    rebuildNormalizedAuditories,
    getScheduleMaxCreatedAt,
    getScheduleMaxCreatedAtMinForWeek,
    bumpScheduleCreatedAt,
    getTopRequestedEntities,
    upsertPreloadState,
    getPreloadStateEntities,
    updateLastPreloaded,
    saveStudentScheduleToDb,
    saveTeacherScheduleToDb,
    saveAuditoryScheduleToDb,
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
    getOrCreateTgInlineLutId,
    getTgInlineLutByCode
};
