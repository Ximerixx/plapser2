#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');

const legacyPath = process.argv[2] || '/root/plapser2/db/plapser.db';
const loomPath = process.argv[3] || path.join(__dirname, '../fusionloom/data/fusionloom.db');

if (!fs.existsSync(legacyPath)) {
    console.error('Legacy DB not found:', legacyPath);
    process.exit(1);
}

process.env.FUSIONLOOM_DB_PATH = loomPath;
const db = require('../fusionloom/fusionloom_db');
const registry = require('../fusionloom/registry');
const { buildFusionKey } = require('../fusionloom/fuse');
const { hasReplacementChar, pickBestName } = require('../fusionloom/encoding');
const { parseGroupName } = require('../fusionloom/normalize/groups');
const { parseAuditoryParts } = require('../fusionloom/normalize/auditories');

const d = db.getDb();
d.pragma('journal_mode = WAL');
d.pragma('synchronous = OFF');
d.exec('DELETE FROM lesson_ingest');
d.exec('DELETE FROM lesson_groups');
d.exec('DELETE FROM lesson_teachers');
d.exec('DELETE FROM lesson_auditories');
d.exec('DELETE FROM lessons');
d.exec('DELETE FROM schedule_meta');
d.exec('DELETE FROM ingest_batches');
d.exec('DELETE FROM group_aliases');
d.exec('DELETE FROM teacher_aliases');
d.exec('DELETE FROM subject_aliases');
d.exec('DELETE FROM auditory_aliases');
d.exec('DELETE FROM groups');
d.exec('DELETE FROM teachers');
d.exec('DELETE FROM subjects');
d.exec('DELETE FROM auditories');

db.attachLegacyDb(legacyPath);
const legacy = d.prepare.bind(d);

const legacyIdMaps = {
    groups: new Map(),
    teachers: new Map(),
    subjects: new Map(),
    auditories: new Map(),
    normalized_auditories: new Map()
};

const repairStats = {
    groups: 0,
    teachers: 0,
    auditories: 0,
    meta: 0,
    skippedAuditoryAsGroup: 0
};

function cleanAuditoryNameByKey(normalizedKey) {
    if (!normalizedKey) return null;
    const row = legacy(`
        SELECT raw_name FROM legacy.normalized_auditories
        WHERE normalized_key = ? AND instr(raw_name, char(65533)) = 0
        ORDER BY updated_at DESC
        LIMIT 1
    `).get(normalizedKey);
    return row?.raw_name || null;
}

function repairAuditoryName(name) {
    if (!name || !hasReplacementChar(name)) return name;
    const parts = parseAuditoryParts(name);
    const repaired = cleanAuditoryNameByKey(parts.normalizedKey);
    if (repaired && repaired !== name) {
        repairStats.auditories++;
        return repaired;
    }
    return name;
}

function listCleanGroupCandidates(pattern) {
    return legacy(`
        SELECT name FROM legacy.groups
        WHERE instr(name, char(65533)) = 0 AND name LIKE '%' || ? || '-%'
    `, pattern).all().map((row) => row.name);
}

function voteGroupRepair(legacyGroupId, candidates) {
    if (!legacyGroupId || !candidates?.length) return null;
    const vote = legacy(`
        SELECT g2.name, COUNT(*) AS c
        FROM legacy.schedule_slots s1
        JOIN legacy.schedule_slots s2
          ON s1.date = s2.date
         AND s1.time_start = s2.time_start
         AND s1.time_end = s2.time_end
         AND s1.subject_id = s2.subject_id
         AND s1.subject_id IS NOT NULL
        JOIN legacy.groups g2 ON g2.id = s2.group_id
        WHERE s1.group_id = ? AND instr(g2.name, char(65533)) = 0
        GROUP BY g2.name
        ORDER BY c DESC
        LIMIT 1
    `).get(legacyGroupId);
    if (vote && candidates.includes(vote.name)) return vote.name;
    return pickBestName(candidates);
}

function repairGroupName(name, legacyGroupId = null) {
    if (!name) return null;
    if (!hasReplacementChar(name)) {
        if (parseGroupName(name)) return name;
        const parts = parseAuditoryParts(name);
        if (parts.normalizedKey) return null;
        return null;
    }

    const parts = parseAuditoryParts(name);
    if (parts.normalizedKey && !parseGroupName(name)) {
        repairStats.skippedAuditoryAsGroup++;
        return null;
    }

    const clean = name.replace(/\uFFFD/g, '');
    const match = clean.match(/(\d+)-(\d{3})/);
    if (match) {
        const candidates = listCleanGroupCandidates(`${match[1]}-${match[2]}`);
        const repaired = voteGroupRepair(legacyGroupId, candidates);
        if (repaired && repaired !== name) {
            repairStats.groups++;
            return repaired;
        }
    }
    return name;
}

function repairTeacherName(name) {
    if (!name || !hasReplacementChar(name)) return name;
    const cleanPrefix = name.replace(/\uFFFD/g, '').trim();
    if (!cleanPrefix) return name;
    const row = legacy(`
        SELECT name FROM legacy.teachers
        WHERE instr(name, char(65533)) = 0 AND name LIKE ? || '%'
        ORDER BY length(name) ASC
        LIMIT 1
    `).get(cleanPrefix);
    if (row?.name) {
        repairStats.teachers++;
        return row.name;
    }
    return name;
}

function repairEntityKey(entityType, entityKey) {
    if (!entityKey || !hasReplacementChar(entityKey)) return entityKey;
    if (entityType === 'auditory') {
        const repaired = repairAuditoryName(entityKey);
        if (repaired !== entityKey) {
            repairStats.meta++;
            return repaired;
        }
    }
    if (entityType === 'group') {
        const repaired = repairGroupName(entityKey);
        if (repaired && repaired !== entityKey) {
            repairStats.meta++;
            return repaired;
        }
    }
    if (entityType === 'teacher') {
        const repaired = repairTeacherName(entityKey);
        if (repaired !== entityKey) {
            repairStats.meta++;
            return repaired;
        }
    }
    return entityKey;
}

function buildLegacyIdMaps() {
    for (const { id, name } of legacy('SELECT id, name FROM legacy.groups').all()) {
        const repaired = repairGroupName(name, id);
        if (!repaired) continue;
        legacyIdMaps.groups.set(id, registry.resolveGroup(repaired));
    }
    for (const { id, name } of legacy('SELECT id, name FROM legacy.teachers').all()) {
        legacyIdMaps.teachers.set(id, registry.resolveTeacher(repairTeacherName(name)));
    }
    for (const { id, name } of legacy('SELECT id, name FROM legacy.subjects').all()) {
        legacyIdMaps.subjects.set(id, registry.resolveSubject(name));
    }
    for (const { id, raw_name, normalized_key } of legacy('SELECT id, raw_name, normalized_key FROM legacy.normalized_auditories').all()) {
        const repaired = repairAuditoryName(raw_name) || cleanAuditoryNameByKey(normalized_key) || raw_name;
        legacyIdMaps.normalized_auditories.set(id, registry.resolveAuditory(repaired));
    }
    for (const { id, name } of legacy('SELECT id, name FROM legacy.auditories').all()) {
        const repaired = repairAuditoryName(name);
        const parts = parseAuditoryParts(repaired);
        const fromNorm = cleanAuditoryNameByKey(parts.normalizedKey);
        legacyIdMaps.auditories.set(id, registry.resolveAuditory(fromNorm || repaired));
    }
}

function mapLegacyId(table, legacyId) {
    if (!legacyId) return null;
    return legacyIdMaps[table]?.get(legacyId) ?? null;
}

function migrateLessons() {
    console.log('Migrating lessons...');
    const slots = legacy(`
        SELECT date, time_start, time_end, group_id, teacher_id, subject_id, auditory_id, normalized_auditory_id,
               lesson_type, subgroup
        FROM legacy.schedule_slots
        ORDER BY date, time_start
    `).all();

    const batchId = db.insertIngestBatch({
        viewType: 'group',
        viewKey: 'legacy-migrate',
        anchorDate: slots[0]?.date || '2000-01-01',
        requestStatsId: null,
        status: 'ok'
    });

    const buckets = new Map();
    let processed = 0;
    for (const s of slots) {
        processed++;
        if (processed % 10000 === 0) console.log(`  slots processed: ${processed}/${slots.length}`);
        const subjectId = mapLegacyId('subjects', s.subject_id);
        let auditoryId = mapLegacyId('normalized_auditories', s.normalized_auditory_id);
        if (!auditoryId) auditoryId = mapLegacyId('auditories', s.auditory_id);
        const teacherId = mapLegacyId('teachers', s.teacher_id);
        const fusionKey = buildFusionKey(
            s.date, s.time_start, s.time_end, subjectId, auditoryId, s.subgroup
        );
        const bucketKey = `${s.date}|${s.time_start}|${s.time_end}|${fusionKey}`;
        if (!buckets.has(bucketKey)) {
            buckets.set(bucketKey, {
                date: s.date,
                timeStart: s.time_start,
                timeEnd: s.time_end,
                subjectId,
                auditoryId,
                teacherId,
                lessonType: s.lesson_type,
                subgroup: s.subgroup,
                fusionKey,
                groupIds: new Set()
            });
        }
        const b = buckets.get(bucketKey);
        const gid = mapLegacyId('groups', s.group_id);
        if (gid) b.groupIds.add(gid);
        if (!b.teacherId && teacherId) b.teacherId = teacherId;
    }

    db.runInTransaction(() => {
        for (const b of buckets.values()) {
            const lessonId = db.createLesson({
                date: b.date,
                timeStart: b.timeStart,
                timeEnd: b.timeEnd,
                subjectId: b.subjectId,
                lessonType: b.lessonType,
                subgroup: b.subgroup,
                fusionKey: b.fusionKey
            });
            for (const gid of b.groupIds) db.linkLessonGroup(lessonId, gid);
            if (b.teacherId) db.linkLessonTeacher(lessonId, b.teacherId);
            if (b.auditoryId) db.linkLessonAuditory(lessonId, b.auditoryId);
            db.linkLessonIngest(lessonId, batchId);
        }
    });
    console.log('Lessons migrated:', buckets.size);
}

function migrateMeta() {
    const rows = legacy('SELECT entity_type, entity_key, date, no_lessons FROM legacy.schedule_meta').all();
    for (const r of rows) {
        const entityKey = repairEntityKey(r.entity_type, r.entity_key);
        db.upsertScheduleMeta(r.entity_type, entityKey, r.date, r.no_lessons === 1, null);
    }
}

function migrateOps() {
    for (const table of ['request_stats', 'preload_state', 'tgbot_subscriptions', 'tgbot_prefs', 'tgbot_inline_lut']) {
        try {
            d.exec(`DELETE FROM main.${table}`);
            if (table === 'request_stats' || table === 'preload_state') {
                const rows = legacy(`SELECT * FROM legacy.${table}`).all();
                for (const row of rows) {
                    const entityKey = repairEntityKey(row.entity_type, row.entity_key);
                    const cols = Object.keys(row);
                    const values = cols.map((col) => (col === 'entity_key' ? entityKey : row[col]));
                    const placeholders = cols.map(() => '?').join(', ');
                    d.prepare(`INSERT INTO main.${table} (${cols.join(', ')}) VALUES (${placeholders})`).run(...values);
                }
            } else if (table === 'tgbot_subscriptions') {
                const rows = legacy(`SELECT * FROM legacy.${table}`).all();
                for (const row of rows) {
                    const entityKey = repairEntityKey(row.entity_type, row.entity_key);
                    d.prepare(`
                        INSERT INTO main.tgbot_subscriptions
                        (id, type, chat_id, user_id, entity_type, entity_key, to_send_time, silent, requested_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).run(row.id, row.type, row.chat_id, row.user_id, row.entity_type, entityKey, row.to_send_time, row.silent, row.requested_at, row.updated_at);
                }
            } else if (table === 'tgbot_inline_lut') {
                const rows = legacy(`SELECT * FROM legacy.${table}`).all();
                for (const row of rows) {
                    const entityKey = repairEntityKey(row.entity_type, row.entity_key);
                    d.prepare(`
                        INSERT INTO main.tgbot_inline_lut (code, entity_type, entity_key, scope, lang)
                        VALUES (?, ?, ?, ?, ?)
                    `).run(row.code, row.entity_type, entityKey, row.scope, row.lang);
                }
            } else {
                d.exec(`INSERT INTO main.${table} SELECT * FROM legacy.${table}`);
            }
            console.log(`Copied ${table}`);
        } catch (e) {
            console.warn(`Skip ${table}:`, e.message);
        }
    }
}

buildLegacyIdMaps();
console.log('Registry maps built');
migrateLessons();
migrateMeta();
migrateOps();
db.detachLegacyDb();

const lessons = d.prepare('SELECT COUNT(*) AS c FROM lessons').get().c;
const badGroups = d.prepare(`SELECT COUNT(*) AS c FROM groups WHERE instr(display_name, char(65533)) > 0`).get().c;
const badAud = d.prepare(`SELECT COUNT(*) AS c FROM auditories WHERE instr(display_name, char(65533)) > 0`).get().c;
const groupCount = d.prepare('SELECT COUNT(*) AS c FROM groups').get().c;
const subjectPlain = d.prepare(`
    SELECT COUNT(*) AS c FROM subjects
    WHERE display_name NOT LIKE 'лек.%' AND display_name NOT LIKE 'пр.%' AND display_name NOT LIKE 'лаб.%'
`).get().c;
const lowercaseGroups = d.prepare(`
    SELECT display_name FROM groups
    WHERE display_name GLOB '*[а-яё]*' AND display_name LIKE '%-%'
    LIMIT 5
`).all();
const physics = d.prepare(`SELECT display_name FROM subjects WHERE canonical_key = 'физика'`).get();

console.log('Migration complete. lessons:', lessons, 'groups:', groupCount, 'plain subjects:', subjectPlain);
console.log('Encoding repair:', repairStats);
console.log('Remaining replacement chars — groups:', badGroups, 'auditories:', badAud);
if (lowercaseGroups.length) console.log('Lowercase group samples:', lowercaseGroups.map((r) => r.display_name).join(', '));
if (physics) console.log('Subject «Физика»:', physics.display_name);
