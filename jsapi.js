'use strict';

/**
 * JSAPI — общий слой доступа к расписанию и логам для HTTP-сервера и Telegram-бота.
 * Кэш → fusionloom → парсеры KIS. Единственная точка входа в fusionloom для приложения.
 */

const { parseStudent } = require('./parser/parseStudent');
const { parseTeacher } = require('./parser/parseTeacher');
const { parseAuditory } = require('./parser/parseAuditory');
const { kisGet } = require('./parser/kisGet');
const { formatAuditoryName, parseAuditoryParts } = require('./parser/normalizeAuditory');
const { parseGroupName, academicYearLabel, normalizeTeacherName } = require('./parser/parseGroupName');
const { kisGroupQueryName, kisTeacherQueryName } = require('./fusionloom/normalize/kis_query');

const { ingestWeek } = require('./fusionloom/ingest');
const loomRead = require('./fusionloom/read');
const loomOps = require('./fusionloom/ops');
const registry = require('./fusionloom/registry');

let scheduleConfig = { extendedWeekFromToday: true, extendedWeekMaxDays: 21 };
try {
    const { loadPlapserConfig } = require('./config/loader');
    const cfg = loadPlapserConfig();
    scheduleConfig = {
        extendedWeekFromToday: cfg.schedule?.extendedWeekFromToday !== false,
        extendedWeekMaxDays: cfg.schedule?.extendedWeekMaxDays ?? 21
    };
} catch (_) { }

const dbLayer = {
    getStudentScheduleWeek: (...args) => loomRead.getStudentScheduleWeek(...args),
    getTeacherScheduleWeek: (...args) => loomRead.getTeacherScheduleWeek(...args),
    getAuditoryScheduleWeek: (...args) => loomRead.getAuditoryScheduleWeek(...args),
    getScheduleMaxCreatedAtMinForWeek: (...args) => loomRead.getScheduleMaxCreatedAtMinForWeek(...args),
    bumpScheduleCreatedAt: (...args) => loomRead.bumpScheduleCreatedAt(...args),
    insertRequestStats: (opts) => loomOps.insertRequestStats(opts),
    getDynamicSlotsByDate: (...args) => loomRead.getDynamicSlotsByDate(...args),
    getFreeAuditoriesBySlot: (...args) => loomRead.getFreeAuditoriesBySlot(...args),
    getFreeSlotsByAuditory: (...args) => loomRead.getFreeSlotsByAuditory(...args),
    getNormalizedBuildings: () => loomRead.getNormalizedBuildings(),
    getNormalizedAuditories: (b) => loomRead.getNormalizedAuditories(b),
    getNormalizedRoomTypes: (b) => loomRead.getNormalizedRoomTypes(b),
    getGroupTeachersAndSubjectsRows: (g) => loomRead.getGroupTeachersAndSubjectsRows(g),
    getCanonicalAuditoryName: (n) => registry.getCanonicalAuditoryName(n),
    getKisAuditoryName: (n) => registry.getKisAuditoryName(n),
    getKisGroupName: (n) => registry.getKisGroupName(n),
    getKisTeacherName: (n) => registry.getKisTeacherName(n),
    getCanonicalTeacherName: (n) => registry.getCanonicalTeacherName(n),
    ensureAuditory: (name) => { registry.resolveAuditory(name); },
    ensureGroup: (name) => { registry.resolveGroup(name); },
    ensureTeacher: (name) => { registry.resolveTeacher(name); }
};

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

function isWeekResponseType(type) {
    return type === 'json-week' || type === 'ics-week';
}

/** json-week/ics-week от сегодня → читать все известные даты (как KIS), не только 7. */
function weekReadOpts(baseDate, opts = null) {
    const extended = scheduleConfig.extendedWeekFromToday
        && isWeekResponseType(opts?.type)
        && baseDate === getDateOffset(0);
    return {
        extended,
        maxDays: scheduleConfig.extendedWeekMaxDays
    };
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

function resolveAuditoryQuery(auditory, opts = {}) {
    const rawName = canonicalAuditory(auditory);
    const kisName = dbLayer.getKisAuditoryName
        ? dbLayer.getKisAuditoryName(auditory)
        : rawName;
    return { rawName, kisName, normalizedId: null, legacyNames: [] };
}

async function resolveGroupQuery(group) {
    const list = await getGroupsList();
    const kisName = kisGroupQueryName(group, list);
    if (dbLayer.ensureGroup) {
        try { dbLayer.ensureGroup(kisName); } catch (_) { }
    }
    return { rawName: kisName, kisName };
}

async function resolveTeacherQuery(teacher) {
    const list = await getTeachersList();
    const kisName = kisTeacherQueryName(teacher, list);
    const rawName = dbLayer.getCanonicalTeacherName
        ? dbLayer.getCanonicalTeacherName(kisName)
        : normalizeTeacherName(kisName);
    if (dbLayer.ensureTeacher) {
        try { dbLayer.ensureTeacher(kisName); } catch (_) { }
    }
    return { rawName, kisName };
}

function weekHasActiveLessons(weekData) {
    if (!weekData || typeof weekData !== 'object') return false;
    for (const day of Object.values(weekData)) {
        const lessons = day?.lessons || [];
        if (lessons.some(l => l.time && l.time.includes('-') && l.status !== 'Нет пар')) return true;
    }
    return false;
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
    if (!fullData) return;
    const normalizedData = normalizeWeekData(fullData);
    try {
        const weekFromDb = loomRead.getStudentScheduleWeek(group, baseDate, null);
        if (weekFromDb && weekDataEqual(normalizedData, weekFromDb)) {
            for (const date of Object.keys(normalizedData)) loomRead.bumpScheduleCreatedAt('group', group, date);
        } else {
            ingestWeek({ viewType: 'group', viewKey: group, anchorDate: baseDate, parsedWeek: normalizedData, requestStatsId });
        }
    } catch (e) {
        console.warn('jsapi saveStudentSchedule failed:', e.message);
        ingestWeek({ viewType: 'group', viewKey: group, anchorDate: baseDate, parsedWeek: normalizedData, requestStatsId });
    }
}

function saveTeacherScheduleToDbOrBump(teacher, baseDate, fullData, requestStatsId) {
    if (!fullData) return;
    const normalizedData = normalizeWeekData(fullData);
    try {
        const weekFromDb = loomRead.getTeacherScheduleWeek(teacher, baseDate);
        if (weekFromDb && weekDataEqual(normalizedData, weekFromDb)) {
            for (const date of Object.keys(normalizedData)) loomRead.bumpScheduleCreatedAt('teacher', teacher, date);
        } else {
            ingestWeek({ viewType: 'teacher', viewKey: teacher, anchorDate: baseDate, parsedWeek: normalizedData, requestStatsId });
        }
    } catch (e) {
        console.warn('jsapi saveTeacherSchedule failed:', e.message);
        ingestWeek({ viewType: 'teacher', viewKey: teacher, anchorDate: baseDate, parsedWeek: normalizedData, requestStatsId });
    }
}

function saveAuditoryScheduleToDbOrBump(auditory, baseDate, fullData, requestStatsId) {
    if (!fullData) return;
    const canonical = canonicalAuditory(auditory);
    const normalizedData = normalizeWeekData(fullData);
    try {
        const weekFromDb = loomRead.getAuditoryScheduleWeek(canonical, baseDate);
        if (weekFromDb && weekDataEqual(normalizedData, weekFromDb)) {
            for (const date of Object.keys(normalizedData)) loomRead.bumpScheduleCreatedAt('auditory', canonical, date);
        } else {
            ingestWeek({ viewType: 'auditory', viewKey: canonical, anchorDate: baseDate, parsedWeek: normalizedData, requestStatsId });
        }
    } catch (e) {
        console.warn('jsapi saveAuditorySchedule failed:', e.message);
        ingestWeek({ viewType: 'auditory', viewKey: canonical, anchorDate: baseDate, parsedWeek: normalizedData, requestStatsId });
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
    const resolved = await resolveGroupQuery(group);
    const canonical = resolved.rawName || group;
    const kisName = resolved.kisName || canonical;
    const readOpts = weekReadOpts(baseDate, opts);
    const cacheKey = getScheduleCacheKey('student', canonical, baseDate, subgroup);
    const cacheInfo = getCachedSchedule(cacheKey);
    if (cacheInfo) {
        if (opts) recordStats({ entityType: 'group', entityKey: canonical, requestedAt: opts.startTime, processingTimeMs: Date.now() - (opts.startTime || Date.now()), type: opts.type || 'json', source: 'cache', ip: opts.ip, userAgent: opts.userAgent });
        return { data: normalizeWeekData(cacheInfo.data), cacheInfo, source: 'cache' };
    }
    if (dbLayer) {
        let weekData = null;
        try {
            weekData = dbLayer.getStudentScheduleWeek(canonical, baseDate, subgroup, readOpts);
            if (weekData) {
                const age = dbLayer.getScheduleMaxCreatedAtMinForWeek('group', canonical, baseDate, readOpts);
                if (age == null || (Math.floor(Date.now() / 1000) - age) > FRESHNESS_SECONDS) weekData = null;
            }
        } catch (_) { weekData = null; }
        if (weekData) {
            const normalized = normalizeWeekData(weekData);
            setCachedSchedule(cacheKey, normalized);
            if (opts) recordStats({ entityType: 'group', entityKey: canonical, requestedAt: opts.startTime, processingTimeMs: Date.now() - (opts.startTime || Date.now()), type: opts.type || 'json', source: 'db', ip: opts.ip, userAgent: opts.userAgent });
            return { data: normalized, cacheInfo: null, source: 'db' };
        }
    }
    const parsed = await parseStudent(baseDate, kisName, subgroup, opts);
    const normalized = parsed ? normalizeWeekData(parsed) : {};
    if (parsed) setCachedSchedule(cacheKey, normalized);
    if (opts && parsed) {
        const startTime = opts.startTime || Date.now();
        const requestStatsId = dbLayer && dbLayer.insertRequestStats ? dbLayer.insertRequestStats({
            ip: opts.ip ?? null,
            userAgent: opts.userAgent ?? null,
            entityType: 'group',
            entityKey: canonical,
            requestedAt: startTime,
            processingTimeMs: Date.now() - startTime,
            type: opts.type || 'json',
            source: 'source'
        }) : null;
        saveStudentScheduleToDbOrBump(canonical, baseDate, normalized, requestStatsId);
    }
    return { data: normalized, cacheInfo: null, source: 'source' };
}

async function getScheduleTeacher(teacher, baseDate, opts = null) {
    const resolved = await resolveTeacherQuery(teacher);
    const canonical = resolved.rawName || teacher;
    const kisName = resolved.kisName || canonical;
    const readOpts = weekReadOpts(baseDate, opts);
    const cacheKey = getScheduleCacheKey('teacher', canonical, baseDate);
    const cacheInfo = getCachedSchedule(cacheKey);
    if (cacheInfo) {
        if (opts) recordStats({ entityType: 'teacher', entityKey: canonical, requestedAt: opts.startTime, processingTimeMs: Date.now() - (opts.startTime || Date.now()), type: opts.type || 'json', source: 'cache', ip: opts.ip, userAgent: opts.userAgent });
        return { data: normalizeWeekData(cacheInfo.data), cacheInfo, source: 'cache' };
    }
    if (dbLayer) {
        let weekData = null;
        try {
            weekData = dbLayer.getTeacherScheduleWeek(canonical, baseDate, readOpts);
            if (weekData) {
                const age = dbLayer.getScheduleMaxCreatedAtMinForWeek('teacher', canonical, baseDate, readOpts);
                if (age == null || (Math.floor(Date.now() / 1000) - age) > FRESHNESS_SECONDS) weekData = null;
            }
        } catch (_) { weekData = null; }
        if (weekData) {
            const normalized = normalizeWeekData(weekData);
            setCachedSchedule(cacheKey, normalized);
            if (opts) recordStats({ entityType: 'teacher', entityKey: canonical, requestedAt: opts.startTime, processingTimeMs: Date.now() - (opts.startTime || Date.now()), type: opts.type || 'json', source: 'db', ip: opts.ip, userAgent: opts.userAgent });
            return { data: normalized, cacheInfo: null, source: 'db' };
        }
    }
    const parsed = await parseTeacher(baseDate, kisName, opts);
    const normalized = parsed ? normalizeWeekData(parsed) : {};
    if (parsed) setCachedSchedule(cacheKey, normalized);
    if (opts && parsed) {
        const startTime = opts.startTime || Date.now();
        const requestStatsId = dbLayer && dbLayer.insertRequestStats ? dbLayer.insertRequestStats({
            ip: opts.ip ?? null,
            userAgent: opts.userAgent ?? null,
            entityType: 'teacher',
            entityKey: canonical,
            requestedAt: startTime,
            processingTimeMs: Date.now() - startTime,
            type: opts.type || 'json',
            source: 'source'
        }) : null;
        saveTeacherScheduleToDbOrBump(canonical, baseDate, normalized, requestStatsId);
    }
    return { data: normalized, cacheInfo: null, source: 'source' };
}

async function getScheduleAuditory(auditory, baseDate, opts = null) {
    const resolved = resolveAuditoryQuery(auditory, { building: opts?.building });
    const canonical = resolved.rawName || canonicalAuditory(auditory);
    const readOpts = weekReadOpts(baseDate, opts);
    const cacheKey = getScheduleCacheKey('auditory', canonical, baseDate);
    const cacheInfo = getCachedSchedule(cacheKey);
    if (cacheInfo) {
        if (opts) recordStats({ entityType: 'auditory', entityKey: canonical, requestedAt: opts.startTime, processingTimeMs: Date.now() - (opts.startTime || Date.now()), type: opts.type || 'json', source: 'cache', ip: opts.ip, userAgent: opts.userAgent });
        return { data: normalizeWeekData(cacheInfo.data), cacheInfo, source: 'cache' };
    }
    let weekDataStale = null;
    if (dbLayer) {
        let weekData = null;
        try {
            weekData = dbLayer.getAuditoryScheduleWeek(canonical, baseDate, readOpts);
            if (weekData) {
                weekDataStale = weekData;
                const age = dbLayer.getScheduleMaxCreatedAtMinForWeek('auditory', canonical, baseDate, readOpts);
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
    const kisName = resolved.kisName || canonical;
    const parsed = await parseAuditory(baseDate, kisName, opts);
    let normalized = parsed ? normalizeWeekData(parsed) : {};
    if (!weekHasActiveLessons(normalized) && weekDataStale) {
        const staleNormalized = normalizeWeekData(weekDataStale);
        if (weekHasActiveLessons(staleNormalized)) {
            normalized = staleNormalized;
            setCachedSchedule(cacheKey, normalized);
            if (opts) recordStats({ entityType: 'auditory', entityKey: canonical, requestedAt: opts.startTime, processingTimeMs: Date.now() - (opts.startTime || Date.now()), type: opts.type || 'json', source: 'db', ip: opts.ip, userAgent: opts.userAgent });
            return { data: normalized, cacheInfo: null, source: 'db' };
        }
    }
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
    const resolved = await resolveGroupQuery(group);
    const canonical = resolved.rawName || group;
    const kisName = resolved.kisName || canonical;
    const fullData = await parseStudent(baseDate, kisName, subgroup, opts);
    const normalized = fullData ? normalizeWeekData(fullData) : {};
    const cacheKey = getScheduleCacheKey('student', canonical, baseDate, subgroup);
    if (fullData) setCachedSchedule(cacheKey, normalized);
    if (dbLayer && fullData && opts) {
        try {
            const requestStatsId = dbLayer.insertRequestStats({
                ip: opts.ip ?? null,
                userAgent: opts.userAgent ?? null,
                entityType: 'group',
                entityKey: canonical,
                requestedAt: opts.startTime,
                processingTimeMs: Date.now() - opts.startTime,
                type: opts.type || 'json',
                source: 'source_asked'
            });
            saveStudentScheduleToDbOrBump(canonical, baseDate, normalized, requestStatsId);
        } catch (e) {
            console.warn('jsapi refresh saveStudentSchedule failed:', e.message);
        }
    }
    return { data: normalized };
}

async function fetchTeacherFromSourceAndSave(teacher, baseDate, opts) {
    const resolved = await resolveTeacherQuery(teacher);
    const canonical = resolved.rawName || teacher;
    const kisName = resolved.kisName || canonical;
    const fullData = await parseTeacher(baseDate, kisName, opts);
    const normalized = fullData ? normalizeWeekData(fullData) : {};
    const cacheKey = getScheduleCacheKey('teacher', canonical, baseDate);
    if (fullData) setCachedSchedule(cacheKey, normalized);
    if (dbLayer && fullData && opts) {
        try {
            const requestStatsId = dbLayer.insertRequestStats({
                ip: opts.ip ?? null,
                userAgent: opts.userAgent ?? null,
                entityType: 'teacher',
                entityKey: canonical,
                requestedAt: opts.startTime,
                processingTimeMs: Date.now() - opts.startTime,
                type: opts.type || 'json',
                source: 'source_asked'
            });
            saveTeacherScheduleToDbOrBump(canonical, baseDate, normalized, requestStatsId);
        } catch (e) {
            console.warn('jsapi refresh saveTeacherSchedule failed:', e.message);
        }
    }
    return { data: normalized };
}

async function fetchAuditoryFromSourceAndSave(auditory, baseDate, opts) {
    const resolved = resolveAuditoryQuery(auditory, { building: opts?.building });
    const canonical = resolved.rawName || canonicalAuditory(auditory);
    const kisName = resolved.kisName || canonical;
    const readOpts = weekReadOpts(baseDate, opts);
    const fullData = await parseAuditory(baseDate, kisName, opts);
    let normalized = fullData ? normalizeWeekData(fullData) : {};
    if (!weekHasActiveLessons(normalized) && dbLayer) {
        const weekDataStale = dbLayer.getAuditoryScheduleWeek(canonical, baseDate, readOpts);
        const staleNormalized = weekDataStale ? normalizeWeekData(weekDataStale) : null;
        if (weekHasActiveLessons(staleNormalized)) normalized = staleNormalized;
    }
    const cacheKey = getScheduleCacheKey('auditory', canonical, baseDate);
    if (normalized && Object.keys(normalized).length) setCachedSchedule(cacheKey, normalized);
    if (dbLayer && normalized && Object.keys(normalized).length && opts) {
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
            console.warn('jsapi refresh saveAuditorySchedule failed:', e.message);
        }
    }
    return { data: normalized };
}

/** Списки групп (для основного процесса — in-memory кэш; воркер вызывает свой API). */
async function getGroupsList() {
    if (Date.now() - groupsCache.lastUpdated > LIST_CACHE_TTL) {
        const { data: groups } = await kisGet('https://kis.vgltu.ru/list?type=Group', null);
        const data = Array.isArray(groups) ? groups.filter(g => typeof g === 'string' && g.trim() !== '') : [];
        for (const name of data) {
            if (dbLayer.ensureGroup) {
                try { dbLayer.ensureGroup(name); } catch (_) { }
            }
        }
        groupsCache = { data, lastUpdated: Date.now() };
    }
    return groupsCache.data;
}

async function getTeachersList() {
    if (Date.now() - teachersCache.lastUpdated > LIST_CACHE_TTL) {
        const { data: teachers } = await kisGet('https://kis.vgltu.ru/list?type=Teacher', null);
        const data = Array.isArray(teachers) ? teachers.filter(t => typeof t === 'string' && t.trim() !== '') : [];
        for (const name of data) {
            if (dbLayer.ensureTeacher) {
                try { dbLayer.ensureTeacher(name); } catch (_) { }
            }
        }
        teachersCache = { data, lastUpdated: Date.now() };
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
            const key = parseAuditoryParts(name).normalizedKey || canonical;
            if (!byKey.has(key)) byKey.set(key, name);
            if (dbLayer && dbLayer.ensureAuditory) {
                try { dbLayer.ensureAuditory(name); } catch (_) { }
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

/** Preload / ops для server.js — не тянуть fusionloom напрямую. */
const preloadOps = {
    getTopRequestedEntities: (...args) => loomOps.getTopRequestedEntities(...args),
    upsertPreloadState: (...args) => loomOps.upsertPreloadState(...args),
    getPreloadStateEntities: () => loomOps.getPreloadStateEntities(),
    updateLastPreloaded: (...args) => loomOps.updateLastPreloaded(...args),
    /** В loom аудитории в registry; пересборка legacy normalized_auditories не нужна. */
    rebuildNormalizedAuditories: () => {}
};

const tgbotDb = require('./fusionloom/tgbot');

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
    warmupAllSchedulesForDate,
    preloadOps,
    tgbotDb
};
