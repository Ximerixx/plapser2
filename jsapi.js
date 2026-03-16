'use strict';

/**
 * JSAPI — общий слой доступа к расписанию и логам для HTTP-сервера и Telegram-бота.
 * Получение расписания (кэш → БД → парсеры), списки групп/преподавателей/аудиторий, recordStats.
 */

const { parseStudent } = require('./parser/parseStudent');
const { parseTeacher } = require('./parser/parseTeacher');
const { parseAuditory } = require('./parser/parseAuditory');

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
        const response = await fetch('https://kis.vgltu.ru/list?type=Group');
        const groups = await response.json();
        groupsCache = {
            data: Array.isArray(groups) ? groups.filter(g => typeof g === 'string' && g.trim() !== '') : [],
            lastUpdated: Date.now()
        };
    }
    return groupsCache.data;
}

async function getTeachersList() {
    if (Date.now() - teachersCache.lastUpdated > LIST_CACHE_TTL) {
        const response = await fetch('https://kis.vgltu.ru/list?type=Teacher');
        const teachers = await response.json();
        teachersCache = {
            data: Array.isArray(teachers) ? teachers.filter(t => typeof t === 'string' && t.trim() !== '') : [],
            lastUpdated: Date.now()
        };
    }
    return teachersCache.data;
}

async function getAuditoriesList() {
    if (Date.now() - auditoriesCache.lastUpdated > LIST_CACHE_TTL) {
        const response = await fetch('https://kis.vgltu.ru/list?type=Auditory');
        const list = await response.json();
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
    getScheduleCacheKey
};
