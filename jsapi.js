'use strict';

/**
 * JSAPI — общий слой доступа к расписанию и логам для HTTP-сервера и Telegram-бота.
 * Получение расписания (кэш → БД → парсеры), списки групп/преподавателей/аудиторий, recordStats.
 */

const { parseStudent } = require('./parser/parseStudent');
const { parseTeacher } = require('./parser/parseTeacher');
const { parseAuditory } = require('./parser/parseAuditory');
const { kisGet } = require('./parser/kisGet');
const { formatAuditoryName, parseAuditoryParts } = require('./parser/normalizeAuditory');
const { parseGroupName, academicYearLabel, normalizeTeacherName } = require('./parser/parseGroupName');

let dbLayer = null;
try {
    dbLayer = require('./db/db');
} catch (e) {
    console.warn('JSAPI: DB layer not available:', e.message);
}

const FRESHNESS_HOURS = 2;
const FRESHNESS_SECONDS = FRESHNESS_HOURS * 3600;
const SCHEDULE_CACHE_TTL = 7200000; // 2 часа для расписаний
const LIST_CACHE_TTL = 3600000;    // 1 час для списков групп/преподавателей/аудиторий

// Кэш расписаний: ключ = "student:group:date:subgroup" или "teacher:name:date", "auditory:name:date"
const scheduleCache = new Map();

// Кэши списков (для основного процесса; воркер получает списки через HTTP к своему API)
let groupsCache = { data: [], lastUpdated: 0 };
let teachersCache = { data: [], lastUpdated: 0 };
let auditoriesCache = { data: [], lastUpdated: 0 };

function getDateOffset(offsetDays = 0, baseDate = null) {
    const d = baseDate ? new Date(baseDate) : new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().split('T')[0];
}

function resolveBaseDate({ date = null, today = null, tomorrow = null } = {}) {
    if (tomorrow === true || tomorrow === 'true' || tomorrow === 1 || tomorrow === '1') {
        return getDateOffset(1);
    }
    if (today === true || today === 'true' || today === 1 || today === '1') {
        return getDateOffset(0);
    }
    if (date == null || date === '') {
        return getDateOffset(0);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
        return null;
    }
    return String(date);
}

function getScheduleCacheKey(type, entity, date, subgroup = null) {
    if (type === 'student') return `student:${entity}:${date}:${subgroup || 'all'}`;
    if (type === 'teacher') return `teacher:${entity}:${date}`;
    if (type === 'auditory') return `auditory:${entity}:${date}`;
    return `teacher:${entity}:${date}`;
}

function getCachedSchedule(key) {
    const cached = scheduleCache.get(key);
    if (cached && (Date.now() - cached.timestamp < SCHEDULE_CACHE_TTL)) {
        const age = Date.now() - cached.timestamp;
        const ttl = SCHEDULE_CACHE_TTL - age;
        return { data: cached.data, cacheHit: true, cacheAge: age, cacheTTL: ttl };
    }
    if (cached) scheduleCache.delete(key);
    return null;
}

function setCachedSchedule(key, data) {
    scheduleCache.set(key, { data, timestamp: Date.now() });
    if (scheduleCache.size > 1000) {
        const now = Date.now();
        for (const [k, v] of scheduleCache.entries()) {
            if (now - v.timestamp > SCHEDULE_CACHE_TTL) scheduleCache.delete(k);
        }
    }
}

function canonicalAuditory(name) {
    if (!name) return '';
    if (dbLayer && dbLayer.getCanonicalAuditoryName) {
        return dbLayer.getCanonicalAuditoryName(name);
    }
    return formatAuditoryName(name);
}

function normalizeLesson(lesson) {
    if (!lesson || lesson.status === 'Нет пар') return lesson;
    const rawAud = lesson.auditory || lesson.room || lesson.classroom || '';
    const auditory = rawAud ? canonicalAuditory(rawAud) : '';
    return {
        ...lesson,
        name: lesson.name ?? '',
        type: lesson.type ?? '',
        auditory,
        room: auditory,
        teacher: lesson.teacher ?? '',
        subgroup: lesson.subgroup ?? ''
    };
}

function normalizeWeekData(data) {
    if (!data || typeof data !== 'object') return data;
    const out = {};
    for (const date of Object.keys(data)) {
        const day = data[date];
        if (!day || !day.lessons) { out[date] = day; continue; }
        out[date] = { ...day, lessons: day.lessons.map(normalizeLesson) };
    }
    return out;
}

/** @deprecated use normalizeWeekData */
function normalizeStudentWeekData(data) {
    return normalizeWeekData(data);
}

function weekDataEqual(a, b) {
    if (!a || !b) return false;
    const keysA = Object.keys(a).filter(k => a[k] && typeof a[k] === 'object');
    const keysB = Object.keys(b).filter(k => b[k] && typeof b[k] === 'object');
    if (keysA.length !== keysB.length) return false;
    const norm = (day) => {
        const lessons = (day.lessons || []).filter(l => l.time && l.time.includes('-'));
        if (lessons.length === 0 && day.lessons?.length === 1 && day.lessons[0].status === 'Нет пар') return 'no_lessons';
        return lessons.map(l => `${l.time}|${l.name || l.subject || ''}|${l.teacher || ''}|${l.auditory || l.room || ''}`).sort().join(';');
    };
    for (const date of keysA) {
        if (!b[date] || norm(a[date]) !== norm(b[date])) return false;
    }
    return true;
}

function saveStudentScheduleToDbOrBump(group, baseDate, fullData, requestStatsId) {
    if (!dbLayer || !fullData) return;
    const normalizedData = normalizeWeekData(fullData);
    try {
        const weekFromDb = dbLayer.getStudentScheduleWeek(group, baseDate, null);
        if (weekFromDb && weekDataEqual(normalizedData, weekFromDb)) {
            for (const date of Object.keys(normalizedData)) dbLayer.bumpScheduleCreatedAt('group', group, date);
        } else {
            dbLayer.saveStudentScheduleToDb(group, baseDate, normalizedData, requestStatsId);
        }
    } catch (e) {
        console.warn('jsapi saveStudentScheduleToDbOrBump failed:', e.message);
        dbLayer.saveStudentScheduleToDb(group, baseDate, normalizedData, requestStatsId);
    }
}

function saveTeacherScheduleToDbOrBump(teacher, baseDate, fullData, requestStatsId) {
    if (!dbLayer || !fullData) return;
    const normalizedData = normalizeWeekData(fullData);
    try {
        const weekFromDb = dbLayer.getTeacherScheduleWeek(teacher, baseDate);
        if (weekFromDb && weekDataEqual(normalizedData, weekFromDb)) {
            for (const date of Object.keys(normalizedData)) dbLayer.bumpScheduleCreatedAt('teacher', teacher, date);
        } else {
            dbLayer.saveTeacherScheduleToDb(teacher, baseDate, normalizedData, requestStatsId);
        }
    } catch (e) {
        console.warn('jsapi saveTeacherScheduleToDbOrBump failed:', e.message);
        dbLayer.saveTeacherScheduleToDb(teacher, baseDate, normalizedData, requestStatsId);
    }
}

function saveAuditoryScheduleToDbOrBump(auditory, baseDate, fullData, requestStatsId) {
    if (!dbLayer || !fullData) return;
    const canonical = canonicalAuditory(auditory);
    const normalizedData = normalizeWeekData(fullData);
    try {
        const weekFromDb = dbLayer.getAuditoryScheduleWeek(canonical, baseDate);
        if (weekFromDb && weekDataEqual(normalizedData, weekFromDb)) {
            for (const date of Object.keys(normalizedData)) dbLayer.bumpScheduleCreatedAt('auditory', canonical, date);
        } else {
            dbLayer.saveAuditoryScheduleToDb(canonical, baseDate, normalizedData, requestStatsId);
        }
    } catch (e) {
        console.warn('jsapi saveAuditoryScheduleToDbOrBump failed:', e.message);
        dbLayer.saveAuditoryScheduleToDb(canonical, baseDate, normalizedData, requestStatsId);
    }
}

/** Записать статистику запроса (обёртка над db.insertRequestStats). */
function recordStats({ entityType, entityKey, requestedAt, processingTimeMs, type: responseType, source, ip, userAgent }) {
    if (!dbLayer || !dbLayer.insertRequestStats) return;
    try {
        dbLayer.insertRequestStats({
            ip: ip ?? null,
            userAgent: userAgent ?? null,
            entityType,
            entityKey,
            requestedAt: requestedAt != null ? requestedAt : Date.now(),
            processingTimeMs,
            type: responseType,
            source: source || 'cache'
        });
    } catch (e) {
        console.warn('jsapi recordStats failed:', e.message);
    }
}

async function getScheduleGroup(group, baseDate, subgroup = null, opts = null) {
    const cacheKey = getScheduleCacheKey('student', group, baseDate, subgroup);
    const cacheInfo = getCachedSchedule(cacheKey);
    if (cacheInfo) {
        if (opts) recordStats({ entityType: 'group', entityKey: group, requestedAt: opts.startTime, processingTimeMs: Date.now() - (opts.startTime || Date.now()), type: opts.type || 'json', source: 'cache', ip: opts.ip, userAgent: opts.userAgent });
        return { data: normalizeWeekData(cacheInfo.data), cacheInfo, source: 'cache' };
    }
    if (dbLayer) {
        let weekData = null;
        try {
            weekData = dbLayer.getStudentScheduleWeek(group, baseDate, subgroup);
            if (weekData) {
                const age = dbLayer.getScheduleMaxCreatedAtMinForWeek('group', group, baseDate);
                if (age == null || (Math.floor(Date.now() / 1000) - age) > FRESHNESS_SECONDS) weekData = null;
            }
        } catch (_) { weekData = null; }
        if (weekData) {
            const normalized = normalizeWeekData(weekData);
            setCachedSchedule(cacheKey, normalized);
            if (opts) recordStats({ entityType: 'group', entityKey: group, requestedAt: opts.startTime, processingTimeMs: Date.now() - (opts.startTime || Date.now()), type: opts.type || 'json', source: 'db', ip: opts.ip, userAgent: opts.userAgent });
            return { data: normalized, cacheInfo: null, source: 'db' };
        }
    }
    const parsed = await parseStudent(baseDate, group, subgroup, opts);
    const normalized = parsed ? normalizeWeekData(parsed) : {};
    if (parsed) setCachedSchedule(cacheKey, normalized);
    if (opts && parsed) {
        const startTime = opts.startTime || Date.now();
        const requestStatsId = dbLayer && dbLayer.insertRequestStats ? dbLayer.insertRequestStats({
            ip: opts.ip ?? null,
            userAgent: opts.userAgent ?? null,
            entityType: 'group',
            entityKey: group,
            requestedAt: startTime,
            processingTimeMs: Date.now() - startTime,
            type: opts.type || 'json',
            source: 'source'
        }) : null;
        saveStudentScheduleToDbOrBump(group, baseDate, normalized, requestStatsId);
    }
    return { data: normalized, cacheInfo: null, source: 'source' };
}

async function getScheduleTeacher(teacher, baseDate, opts = null) {
    const cacheKey = getScheduleCacheKey('teacher', teacher, baseDate);
    const cacheInfo = getCachedSchedule(cacheKey);
    if (cacheInfo) {
        if (opts) recordStats({ entityType: 'teacher', entityKey: teacher, requestedAt: opts.startTime, processingTimeMs: Date.now() - (opts.startTime || Date.now()), type: opts.type || 'json', source: 'cache', ip: opts.ip, userAgent: opts.userAgent });
        return { data: normalizeWeekData(cacheInfo.data), cacheInfo, source: 'cache' };
    }
    if (dbLayer) {
        let weekData = null;
        try {
            weekData = dbLayer.getTeacherScheduleWeek(teacher, baseDate);
            if (weekData) {
                const age = dbLayer.getScheduleMaxCreatedAtMinForWeek('teacher', teacher, baseDate);
                if (age == null || (Math.floor(Date.now() / 1000) - age) > FRESHNESS_SECONDS) weekData = null;
            }
        } catch (_) { weekData = null; }
        if (weekData) {
            const normalized = normalizeWeekData(weekData);
            setCachedSchedule(cacheKey, normalized);
            if (opts) recordStats({ entityType: 'teacher', entityKey: teacher, requestedAt: opts.startTime, processingTimeMs: Date.now() - (opts.startTime || Date.now()), type: opts.type || 'json', source: 'db', ip: opts.ip, userAgent: opts.userAgent });
            return { data: normalized, cacheInfo: null, source: 'db' };
        }
    }
    const parsed = await parseTeacher(baseDate, teacher, opts);
    const normalized = parsed ? normalizeWeekData(parsed) : {};
    if (parsed) setCachedSchedule(cacheKey, normalized);
    if (opts && parsed) {
        const startTime = opts.startTime || Date.now();
        const requestStatsId = dbLayer && dbLayer.insertRequestStats ? dbLayer.insertRequestStats({
            ip: opts.ip ?? null,
            userAgent: opts.userAgent ?? null,
            entityType: 'teacher',
            entityKey: teacher,
            requestedAt: startTime,
            processingTimeMs: Date.now() - startTime,
            type: opts.type || 'json',
            source: 'source'
        }) : null;
        saveTeacherScheduleToDbOrBump(teacher, baseDate, normalized, requestStatsId);
    }
    return { data: normalized, cacheInfo: null, source: 'source' };
}

async function getScheduleAuditory(auditory, baseDate, opts = null) {
    const canonical = canonicalAuditory(auditory);
    const cacheKey = getScheduleCacheKey('auditory', canonical, baseDate);
    const cacheInfo = getCachedSchedule(cacheKey);
    if (cacheInfo) {
        if (opts) recordStats({ entityType: 'auditory', entityKey: canonical, requestedAt: opts.startTime, processingTimeMs: Date.now() - (opts.startTime || Date.now()), type: opts.type || 'json', source: 'cache', ip: opts.ip, userAgent: opts.userAgent });
        return { data: normalizeWeekData(cacheInfo.data), cacheInfo, source: 'cache' };
    }
    if (dbLayer) {
        let weekData = null;
        try {
            weekData = dbLayer.getAuditoryScheduleWeek(canonical, baseDate);
            if (weekData) {
                const age = dbLayer.getScheduleMaxCreatedAtMinForWeek('auditory', canonical, baseDate);
                if (age == null || (Math.floor(Date.now() / 1000) - age) > FRESHNESS_SECONDS) weekData = null;
            }
        } catch (_) { weekData = null; }
        if (weekData) {
            const normalized = normalizeWeekData(weekData);
            setCachedSchedule(cacheKey, normalized);
            if (opts) recordStats({ entityType: 'auditory', entityKey: canonical, requestedAt: opts.startTime, processingTimeMs: Date.now() - (opts.startTime || Date.now()), type: opts.type || 'json', source: 'db', ip: opts.ip, userAgent: opts.userAgent });
            return { data: normalized, cacheInfo: null, source: 'db' };
        }
    }
    const parsed = await parseAuditory(baseDate, canonical, opts);
    const normalized = parsed ? normalizeWeekData(parsed) : {};
    if (parsed) setCachedSchedule(cacheKey, normalized);
    if (opts && parsed) {
        const startTime = opts.startTime || Date.now();
        const requestStatsId = dbLayer && dbLayer.insertRequestStats ? dbLayer.insertRequestStats({
            ip: opts.ip ?? null,
            userAgent: opts.userAgent ?? null,
            entityType: 'auditory',
            entityKey: canonical,
            requestedAt: startTime,
            processingTimeMs: Date.now() - startTime,
            type: opts.type || 'json',
            source: 'source'
        }) : null;
        saveAuditoryScheduleToDbOrBump(canonical, baseDate, normalized, requestStatsId);
    }
    return { data: normalized, cacheInfo: null, source: 'source' };
}

/** Обновление из источника при refresh (source_asked). */
async function fetchStudentFromSourceAndSave(group, baseDate, subgroup, opts) {
    const fullData = await parseStudent(baseDate, group, subgroup, opts);
    const normalized = fullData ? normalizeWeekData(fullData) : {};
    const cacheKey = getScheduleCacheKey('student', group, baseDate, subgroup);
    if (fullData) setCachedSchedule(cacheKey, normalized);
    if (dbLayer && fullData && opts) {
        try {
            const requestStatsId = dbLayer.insertRequestStats({
                ip: opts.ip ?? null,
                userAgent: opts.userAgent ?? null,
                entityType: 'group',
                entityKey: group,
                requestedAt: opts.startTime,
                processingTimeMs: Date.now() - opts.startTime,
                type: opts.type || 'json',
                source: 'source_asked'
            });
            saveStudentScheduleToDbOrBump(group, baseDate, normalized, requestStatsId);
        } catch (e) {
            console.warn('jsapi refresh saveStudentScheduleToDb failed:', e.message);
        }
    }
    return { data: normalized };
}

async function fetchTeacherFromSourceAndSave(teacher, baseDate, opts) {
    const fullData = await parseTeacher(baseDate, teacher, opts);
    const normalized = fullData ? normalizeWeekData(fullData) : {};
    const cacheKey = getScheduleCacheKey('teacher', teacher, baseDate);
    if (fullData) setCachedSchedule(cacheKey, normalized);
    if (dbLayer && fullData && opts) {
        try {
            const requestStatsId = dbLayer.insertRequestStats({
                ip: opts.ip ?? null,
                userAgent: opts.userAgent ?? null,
                entityType: 'teacher',
                entityKey: teacher,
                requestedAt: opts.startTime,
                processingTimeMs: Date.now() - opts.startTime,
                type: opts.type || 'json',
                source: 'source_asked'
            });
            saveTeacherScheduleToDbOrBump(teacher, baseDate, normalized, requestStatsId);
        } catch (e) {
            console.warn('jsapi refresh saveTeacherScheduleToDb failed:', e.message);
        }
    }
    return { data: normalized };
}

async function fetchAuditoryFromSourceAndSave(auditory, baseDate, opts) {
    const canonical = canonicalAuditory(auditory);
    const fullData = await parseAuditory(baseDate, canonical, opts);
    const normalized = fullData ? normalizeWeekData(fullData) : {};
    const cacheKey = getScheduleCacheKey('auditory', canonical, baseDate);
    if (fullData) setCachedSchedule(cacheKey, normalized);
    if (dbLayer && fullData && opts) {
        try {
            const requestStatsId = dbLayer.insertRequestStats({
                ip: opts.ip ?? null,
                userAgent: opts.userAgent ?? null,
                entityType: 'auditory',
                entityKey: canonical,
                requestedAt: opts.startTime,
                processingTimeMs: Date.now() - opts.startTime,
                type: opts.type || 'json',
                source: 'source_asked'
            });
            saveAuditoryScheduleToDbOrBump(canonical, baseDate, normalized, requestStatsId);
        } catch (e) {
            console.warn('jsapi refresh saveAuditoryScheduleToDb failed:', e.message);
        }
    }
    return { data: normalized };
}

/** Списки групп (для основного процесса — in-memory кэш; воркер вызывает свой API). */
async function getGroupsList() {
    if (Date.now() - groupsCache.lastUpdated > LIST_CACHE_TTL) {
        const { data: groups } = await kisGet('https://kis.vgltu.ru/list?type=Group', null);
        groupsCache = {
            data: Array.isArray(groups) ? groups.filter(g => typeof g === 'string' && g.trim() !== '') : [],
            lastUpdated: Date.now()
        };
    }
    return groupsCache.data;
}

async function getTeachersList() {
    if (Date.now() - teachersCache.lastUpdated > LIST_CACHE_TTL) {
        const { data: teachers } = await kisGet('https://kis.vgltu.ru/list?type=Teacher', null);
        teachersCache = {
            data: Array.isArray(teachers) ? teachers.filter(t => typeof t === 'string' && t.trim() !== '') : [],
            lastUpdated: Date.now()
        };
    }
    return teachersCache.data;
}

async function getAuditoriesList() {
    if (Date.now() - auditoriesCache.lastUpdated > LIST_CACHE_TTL) {
        const { data: list } = await kisGet('https://kis.vgltu.ru/list?type=Auditory', null);
        const raw = Array.isArray(list) ? list.filter(a => typeof a === 'string' && a.trim() !== '') : [];
        const byKey = new Map();
        for (const name of raw) {
            const canonical = canonicalAuditory(name);
            if (!canonical) continue;
            const key = parseAuditoryParts(canonical).normalizedKey || canonical;
            if (!byKey.has(key)) byKey.set(key, canonical);
            if (dbLayer && dbLayer.ensureAuditory) {
                try { dbLayer.ensureAuditory(canonical); } catch (_) { }
            }
        }
        const auditories = [...byKey.values()].sort((a, b) => a.localeCompare(b, 'ru'));
        auditoriesCache = { data: auditories, lastUpdated: Date.now() };
    }
    return auditoriesCache.data;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function warmupAllSchedulesForDate(baseDate, opts = {}) {
    const includeGroups = opts.includeGroups !== false;
    const includeTeachers = opts.includeTeachers !== false;
    const includeAuditories = opts.includeAuditories !== false;
    const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : 80;
    const userAgentBase = opts.userAgentBase || 'PlapserWarmup/1.0';
    const ip = opts.ip || 'warmup';
    const stats = {
        date: baseDate,
        groups: { total: 0, ok: 0, failed: 0 },
        teachers: { total: 0, ok: 0, failed: 0 },
        auditories: { total: 0, ok: 0, failed: 0 }
    };
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const startedAt = Date.now();

    const totalItems =
        (includeGroups ? (await getGroupsList()).length : 0) +
        (includeTeachers ? (await getTeachersList()).length : 0) +
        (includeAuditories ? (await getAuditoriesList()).length : 0);
    let processedItems = 0;

    const emitProgress = (stage, key = null) => {
        if (!onProgress) return;
        const elapsedMs = Date.now() - startedAt;
        const rate = processedItems > 0 ? (elapsedMs / processedItems) : 0;
        const remaining = Math.max(0, totalItems - processedItems);
        const etaMs = rate > 0 ? Math.round(remaining * rate) : null;
        onProgress({
            stage,
            key,
            processedItems,
            totalItems,
            elapsedMs,
            etaMs,
            stats
        });
    };

    if (includeGroups) {
        const groups = await getGroupsList();
        stats.groups.total = groups.length;
        emitProgress('groups_start');
        for (const group of groups) {
            try {
                const startTime = Date.now();
                await fetchStudentFromSourceAndSave(group, baseDate, null, {
                    ip,
                    userAgent: `${userAgentBase} entity=group key=${group}`,
                    startTime,
                    type: 'json-week'
                });
                stats.groups.ok++;
            } catch (_) {
                stats.groups.failed++;
            }
            processedItems++;
            emitProgress('groups_progress', group);
            if (delayMs > 0) await sleep(delayMs);
        }
        emitProgress('groups_done');
    }

    if (includeTeachers) {
        const teachers = await getTeachersList();
        stats.teachers.total = teachers.length;
        emitProgress('teachers_start');
        for (const teacher of teachers) {
            try {
                const startTime = Date.now();
                await fetchTeacherFromSourceAndSave(teacher, baseDate, {
                    ip,
                    userAgent: `${userAgentBase} entity=teacher key=${teacher}`,
                    startTime,
                    type: 'json-week'
                });
                stats.teachers.ok++;
            } catch (_) {
                stats.teachers.failed++;
            }
            processedItems++;
            emitProgress('teachers_progress', teacher);
            if (delayMs > 0) await sleep(delayMs);
        }
        emitProgress('teachers_done');
    }

    if (includeAuditories) {
        const auditories = await getAuditoriesList();
        stats.auditories.total = auditories.length;
        emitProgress('auditories_start');
        for (const auditory of auditories) {
            try {
                const startTime = Date.now();
                await fetchAuditoryFromSourceAndSave(auditory, baseDate, {
                    ip,
                    userAgent: `${userAgentBase} entity=auditory key=${auditory}`,
                    startTime,
                    type: 'json-week'
                });
                stats.auditories.ok++;
            } catch (_) {
                stats.auditories.failed++;
            }
            processedItems++;
            emitProgress('auditories_progress', auditory);
            if (delayMs > 0) await sleep(delayMs);
        }
        emitProgress('auditories_done');
    }

    if (onProgress) {
        onProgress({
            stage: 'done',
            key: null,
            processedItems,
            totalItems,
            elapsedMs: Date.now() - startedAt,
            etaMs: 0,
            stats
        });
    }
    return stats;
}

function getFreeAuditorySlots(baseDate, building = null) {
    if (!dbLayer || !dbLayer.getDynamicSlotsByDate) return [];
    return dbLayer.getDynamicSlotsByDate(baseDate, building || null);
}

function getFreeAuditoriesBySlot(baseDate, slot, building, roomType = null) {
    if (!dbLayer || !dbLayer.getFreeAuditoriesBySlot) return [];
    return dbLayer.getFreeAuditoriesBySlot(baseDate, slot, building, roomType || null);
}

function getFreeSlotsByAuditory(baseDate, auditory, building = null) {
    if (!dbLayer || !dbLayer.getFreeSlotsByAuditory) return null;
    return dbLayer.getFreeSlotsByAuditory(baseDate, canonicalAuditory(auditory), building || null);
}

function getNormalizedBuildings() {
    if (!dbLayer || !dbLayer.getNormalizedBuildings) return [];
    return dbLayer.getNormalizedBuildings();
}

function getNormalizedAuditories(building = null) {
    if (!dbLayer || !dbLayer.getNormalizedAuditories) return [];
    return dbLayer.getNormalizedAuditories(building || null);
}

function getNormalizedRoomTypes(building = null) {
    if (!dbLayer || !dbLayer.getNormalizedRoomTypes) return [];
    return dbLayer.getNormalizedRoomTypes(building || null);
}

function getGroupTeachersAndSubjects(groupName) {
    const group = String(groupName ?? '').trim();
    if (!group) return { error: 'bad_request', message: 'group is required' };
    if (!dbLayer || !dbLayer.getGroupTeachersAndSubjectsRows) {
        return { error: 'unavailable', message: 'Database layer not available' };
    }

    const rows = dbLayer.getGroupTeachersAndSubjectsRows(group);
    if (rows === null) return { error: 'not_found', message: 'Group not found in database' };
    if (!rows.length) return { error: 'not_found', message: 'No cached lessons with teacher and subject for this group' };

    const parsed = parseGroupName(group);
    const buckets = new Map();
    let dataFrom = rows[0].date;
    let dataTo = rows[0].date;

    for (const row of rows) {
        if (row.date < dataFrom) dataFrom = row.date;
        if (row.date > dataTo) dataTo = row.date;
        const yearLabel = academicYearLabel(row.date);
        if (!yearLabel) continue;
        if (!buckets.has(yearLabel)) buckets.set(yearLabel, new Map());
        const teacher = normalizeTeacherName(row.teacher_name);
        const subject = String(row.subject_name ?? '').trim();
        if (!teacher || !subject) continue;
        const key = `${teacher}\0${subject}`;
        buckets.get(yearLabel).set(key, { teacher, subject });
    }

    const academicYears = {};
    const academicYearsFound = [...buckets.keys()].sort();
    for (const label of academicYearsFound) {
        const items = [...buckets.get(label).values()].sort((a, b) => {
            const sub = a.subject.localeCompare(b.subject, 'ru');
            return sub !== 0 ? sub : a.teacher.localeCompare(b.teacher, 'ru');
        });
        academicYears[label] = { items };
    }

    if (!academicYearsFound.length) {
        return { error: 'not_found', message: 'No cached lessons with teacher and subject for this group' };
    }

    return {
        group,
        parsed: parsed ? {
            specialty: parsed.specialty,
            admissionYear: parsed.admissionYear,
            groupIndex: parsed.groupIndex,
            form: parsed.form
        } : null,
        academicYears,
        meta: {
            academicYearsFound,
            dataFrom,
            dataTo,
            slotsWithTeacherSubject: rows.length,
            note: 'Только закэшированные даты; для прошлых учебных лет нужен warmup'
        }
    };
}

module.exports = {
    getScheduleGroup,
    getScheduleTeacher,
    getScheduleAuditory,
    getGroupsList,
    getTeachersList,
    getAuditoriesList,
    recordStats,
    fetchStudentFromSourceAndSave,
    fetchTeacherFromSourceAndSave,
    fetchAuditoryFromSourceAndSave,
    setCachedSchedule,
    getScheduleCacheKey,
    resolveBaseDate,
    getFreeAuditorySlots,
    getFreeAuditoriesBySlot,
    getFreeSlotsByAuditory,
    getNormalizedBuildings,
    getNormalizedAuditories,
    getNormalizedRoomTypes,
    getGroupTeachersAndSubjects,
    warmupAllSchedulesForDate
};
