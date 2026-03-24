'use strict';

/**
 * JSAPI — общий слой доступа к расписанию и логам для HTTP-сервера и Telegram-бота.
 * Получение расписания (кэш → БД → парсеры), списки групп/преподавателей/аудиторий, recordStats.
 */

const { parseStudent } = require('./parser/parseStudent');
const { parseTeacher } = require('./parser/parseTeacher');
const { parseAuditory } = require('./parser/parseAuditory');
const axios = require('axios');

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

function normalizeLesson(lesson) {
    if (!lesson || lesson.status === 'Нет пар') return lesson;
    return {
        ...lesson,
        name: lesson.name ?? '',
        type: lesson.type ?? '',
        auditory: lesson.auditory ?? '',
        room: lesson.room ?? lesson.auditory ?? '',
        teacher: lesson.teacher ?? '',
        subgroup: lesson.subgroup ?? ''
    };
}

function normalizeStudentWeekData(data) {
    if (!data || typeof data !== 'object') return data;
    const out = {};
    for (const date of Object.keys(data)) {
        const day = data[date];
        if (!day || !day.lessons) { out[date] = day; continue; }
        out[date] = { ...day, lessons: day.lessons.map(normalizeLesson) };
    }
    return out;
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
    try {
        const weekFromDb = dbLayer.getStudentScheduleWeek(group, baseDate, null);
        if (weekFromDb && weekDataEqual(fullData, weekFromDb)) {
            for (const date of Object.keys(fullData)) dbLayer.bumpScheduleCreatedAt('group', group, date);
        } else {
            dbLayer.saveStudentScheduleToDb(group, baseDate, fullData, requestStatsId);
        }
    } catch (e) {
        console.warn('jsapi saveStudentScheduleToDbOrBump failed:', e.message);
        dbLayer.saveStudentScheduleToDb(group, baseDate, fullData, requestStatsId);
    }
}

function saveTeacherScheduleToDbOrBump(teacher, baseDate, fullData, requestStatsId) {
    if (!dbLayer || !fullData) return;
    try {
        const weekFromDb = dbLayer.getTeacherScheduleWeek(teacher, baseDate);
        if (weekFromDb && weekDataEqual(fullData, weekFromDb)) {
            for (const date of Object.keys(fullData)) dbLayer.bumpScheduleCreatedAt('teacher', teacher, date);
        } else {
            dbLayer.saveTeacherScheduleToDb(teacher, baseDate, fullData, requestStatsId);
        }
    } catch (e) {
        console.warn('jsapi saveTeacherScheduleToDbOrBump failed:', e.message);
        dbLayer.saveTeacherScheduleToDb(teacher, baseDate, fullData, requestStatsId);
    }
}

function saveAuditoryScheduleToDbOrBump(auditory, baseDate, fullData, requestStatsId) {
    if (!dbLayer || !fullData) return;
    try {
        const weekFromDb = dbLayer.getAuditoryScheduleWeek(auditory, baseDate);
        if (weekFromDb && weekDataEqual(fullData, weekFromDb)) {
            for (const date of Object.keys(fullData)) dbLayer.bumpScheduleCreatedAt('auditory', auditory, date);
        } else {
            dbLayer.saveAuditoryScheduleToDb(auditory, baseDate, fullData, requestStatsId);
        }
    } catch (e) {
        console.warn('jsapi saveAuditoryScheduleToDbOrBump failed:', e.message);
        dbLayer.saveAuditoryScheduleToDb(auditory, baseDate, fullData, requestStatsId);
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
        return { data: normalizeStudentWeekData(cacheInfo.data), cacheInfo, source: 'cache' };
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
            setCachedSchedule(cacheKey, weekData);
            if (opts) recordStats({ entityType: 'group', entityKey: group, requestedAt: opts.startTime, processingTimeMs: Date.now() - (opts.startTime || Date.now()), type: opts.type || 'json', source: 'db', ip: opts.ip, userAgent: opts.userAgent });
            return { data: normalizeStudentWeekData(weekData), cacheInfo: null, source: 'db' };
        }
    }
    const parsed = await parseStudent(baseDate, group, subgroup);
    if (parsed) setCachedSchedule(cacheKey, parsed);
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
        saveStudentScheduleToDbOrBump(group, baseDate, parsed, requestStatsId);
    }
    return { data: normalizeStudentWeekData(parsed || {}), cacheInfo: null, source: 'source' };
}

async function getScheduleTeacher(teacher, baseDate, opts = null) {
    const cacheKey = getScheduleCacheKey('teacher', teacher, baseDate);
    const cacheInfo = getCachedSchedule(cacheKey);
    if (cacheInfo) {
        if (opts) recordStats({ entityType: 'teacher', entityKey: teacher, requestedAt: opts.startTime, processingTimeMs: Date.now() - (opts.startTime || Date.now()), type: opts.type || 'json', source: 'cache', ip: opts.ip, userAgent: opts.userAgent });
        return { data: cacheInfo.data, cacheInfo, source: 'cache' };
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
            setCachedSchedule(cacheKey, weekData);
            if (opts) recordStats({ entityType: 'teacher', entityKey: teacher, requestedAt: opts.startTime, processingTimeMs: Date.now() - (opts.startTime || Date.now()), type: opts.type || 'json', source: 'db', ip: opts.ip, userAgent: opts.userAgent });
            return { data: weekData, cacheInfo: null, source: 'db' };
        }
    }
    const parsed = await parseTeacher(baseDate, teacher);
    if (parsed) setCachedSchedule(cacheKey, parsed);
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
        saveTeacherScheduleToDbOrBump(teacher, baseDate, parsed, requestStatsId);
    }
    return { data: parsed || {}, cacheInfo: null, source: 'source' };
}

async function getScheduleAuditory(auditory, baseDate, opts = null) {
    const cacheKey = getScheduleCacheKey('auditory', auditory, baseDate);
    const cacheInfo = getCachedSchedule(cacheKey);
    if (cacheInfo) {
        if (opts) recordStats({ entityType: 'auditory', entityKey: auditory, requestedAt: opts.startTime, processingTimeMs: Date.now() - (opts.startTime || Date.now()), type: opts.type || 'json', source: 'cache', ip: opts.ip, userAgent: opts.userAgent });
        return { data: cacheInfo.data, cacheInfo, source: 'cache' };
    }
    if (dbLayer) {
        let weekData = null;
        try {
            weekData = dbLayer.getAuditoryScheduleWeek(auditory, baseDate);
            if (weekData) {
                const age = dbLayer.getScheduleMaxCreatedAtMinForWeek('auditory', auditory, baseDate);
                if (age == null || (Math.floor(Date.now() / 1000) - age) > FRESHNESS_SECONDS) weekData = null;
            }
        } catch (_) { weekData = null; }
        if (weekData) {
            setCachedSchedule(cacheKey, weekData);
            if (opts) recordStats({ entityType: 'auditory', entityKey: auditory, requestedAt: opts.startTime, processingTimeMs: Date.now() - (opts.startTime || Date.now()), type: opts.type || 'json', source: 'db', ip: opts.ip, userAgent: opts.userAgent });
            return { data: weekData, cacheInfo: null, source: 'db' };
        }
    }
    const parsed = await parseAuditory(baseDate, auditory);
    if (parsed) setCachedSchedule(cacheKey, parsed);
    if (opts && parsed) {
        const startTime = opts.startTime || Date.now();
        const requestStatsId = dbLayer && dbLayer.insertRequestStats ? dbLayer.insertRequestStats({
            ip: opts.ip ?? null,
            userAgent: opts.userAgent ?? null,
            entityType: 'auditory',
            entityKey: auditory,
            requestedAt: startTime,
            processingTimeMs: Date.now() - startTime,
            type: opts.type || 'json',
            source: 'source'
        }) : null;
        saveAuditoryScheduleToDbOrBump(auditory, baseDate, parsed, requestStatsId);
    }
    return { data: parsed || {}, cacheInfo: null, source: 'source' };
}

/** Обновление из источника при refresh (source_asked). */
async function fetchStudentFromSourceAndSave(group, baseDate, subgroup, opts) {
    const fullData = await parseStudent(baseDate, group, subgroup);
    const cacheKey = getScheduleCacheKey('student', group, baseDate, subgroup);
    if (fullData) setCachedSchedule(cacheKey, fullData);
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
            saveStudentScheduleToDbOrBump(group, baseDate, fullData, requestStatsId);
        } catch (e) {
            console.warn('jsapi refresh saveStudentScheduleToDb failed:', e.message);
        }
    }
    return { data: fullData || {} };
}

async function fetchTeacherFromSourceAndSave(teacher, baseDate, opts) {
    const fullData = await parseTeacher(baseDate, teacher);
    const cacheKey = getScheduleCacheKey('teacher', teacher, baseDate);
    if (fullData) setCachedSchedule(cacheKey, fullData);
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
            saveTeacherScheduleToDbOrBump(teacher, baseDate, fullData, requestStatsId);
        } catch (e) {
            console.warn('jsapi refresh saveTeacherScheduleToDb failed:', e.message);
        }
    }
    return { data: fullData || {} };
}

async function fetchAuditoryFromSourceAndSave(auditory, baseDate, opts) {
    const fullData = await parseAuditory(baseDate, auditory);
    const cacheKey = getScheduleCacheKey('auditory', auditory, baseDate);
    if (fullData) setCachedSchedule(cacheKey, fullData);
    if (dbLayer && fullData && opts) {
        try {
            const requestStatsId = dbLayer.insertRequestStats({
                ip: opts.ip ?? null,
                userAgent: opts.userAgent ?? null,
                entityType: 'auditory',
                entityKey: auditory,
                requestedAt: opts.startTime,
                processingTimeMs: Date.now() - opts.startTime,
                type: opts.type || 'json',
                source: 'source_asked'
            });
            saveAuditoryScheduleToDbOrBump(auditory, baseDate, fullData, requestStatsId);
        } catch (e) {
            console.warn('jsapi refresh saveAuditoryScheduleToDb failed:', e.message);
        }
    }
    return { data: fullData || {} };
}

/** Списки групп (для основного процесса — in-memory кэш; воркер вызывает свой API). */
async function getGroupsList() {
    if (Date.now() - groupsCache.lastUpdated > LIST_CACHE_TTL) {
        const { data: groups } = await axios.get('https://kis.vgltu.ru/list?type=Group', { timeout: 10000 });
        groupsCache = {
            data: Array.isArray(groups) ? groups.filter(g => typeof g === 'string' && g.trim() !== '') : [],
            lastUpdated: Date.now()
        };
    }
    return groupsCache.data;
}

async function getTeachersList() {
    if (Date.now() - teachersCache.lastUpdated > LIST_CACHE_TTL) {
        const { data: teachers } = await axios.get('https://kis.vgltu.ru/list?type=Teacher', { timeout: 10000 });
        teachersCache = {
            data: Array.isArray(teachers) ? teachers.filter(t => typeof t === 'string' && t.trim() !== '') : [],
            lastUpdated: Date.now()
        };
    }
    return teachersCache.data;
}

async function getAuditoriesList() {
    if (Date.now() - auditoriesCache.lastUpdated > LIST_CACHE_TTL) {
        const { data: list } = await axios.get('https://kis.vgltu.ru/list?type=Auditory', { timeout: 10000 });
        const auditories = Array.isArray(list) ? list.filter(a => typeof a === 'string' && a.trim() !== '') : [];
        if (dbLayer && dbLayer.ensureAuditory) {
            for (const name of auditories) {
                try { dbLayer.ensureAuditory(name); } catch (_) { }
            }
        }
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
    return dbLayer.getFreeSlotsByAuditory(baseDate, auditory, building || null);
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
    warmupAllSchedulesForDate
};
