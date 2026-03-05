const express = require("express");
const ical = require("ical-generator").default;
const { parseStudent } = require("./parser/parseStudent");
const fs = require('fs');

const path = require('path');
const { parseTeacher } = require("./parser/parseTeacher");
const { parseAuditory } = require("./parser/parseAuditory");

let dbLayer = null;
try {
    dbLayer = require("./db/db");
} catch (e) {
    console.warn("DB layer not available:", e.message);
}

const app = express();
const port = 3000;
const TIMEZONE = "Europe/Moscow";

// Статика: max-age в секундах (браузер не перезапросит раньше). Для теста — 1 ч; для прода — 86400 (сутки) или 604800 (неделя).
const STATIC_CACHE_MAX_AGE_SECONDS = 3600;

// Logging utility
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0].trim() ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress ||
           req.socket?.remoteAddress ||
           req.ip ||
           'unknown';
}

function parseUserAgent(userAgent) {
    if (!userAgent) return { device: 'unknown', browser: 'unknown', os: 'unknown' };
    
    const ua = userAgent.toLowerCase();
    let device = 'desktop';
    let browser = 'unknown';
    let os = 'unknown';
    
    // Device detection
    if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone') || ua.includes('ipad')) {
        device = 'mobile';
    } else if (ua.includes('tablet') || ua.includes('ipad')) {
        device = 'tablet';
    }
    
    // Browser detection
    if (ua.includes('chrome') && !ua.includes('edg')) browser = 'chrome';
    else if (ua.includes('firefox')) browser = 'firefox';
    else if (ua.includes('safari') && !ua.includes('chrome')) browser = 'safari';
    else if (ua.includes('edg')) browser = 'edge';
    else if (ua.includes('opera') || ua.includes('opr')) browser = 'opera';
    
    // OS detection
    if (ua.includes('windows')) os = 'windows';
    else if (ua.includes('mac os') || ua.includes('macos')) os = 'macos';
    else if (ua.includes('linux')) os = 'linux';
    else if (ua.includes('android')) os = 'android';
    else if (ua.includes('ios') || ua.includes('iphone') || ua.includes('ipad')) os = 'ios';
    
    return { device, browser, os };
}

function logRequest(req, res, responseTime, statusCode, resultSize = null) {
    const timestamp = new Date().toISOString();
    const clientIP = getClientIP(req);
    const method = req.method;
    const path = req.path;
    const query = JSON.stringify(req.query);
    const userAgent = req.headers['user-agent'] || 'unknown';
    const referer = req.headers['referer'] || 'direct';
    const uaInfo = parseUserAgent(userAgent);
    
    const logData = {
        timestamp,
        ip: clientIP,
        method,
        path,
        query,
        statusCode,
        responseTime: `${responseTime}ms`,
        userAgent,
        device: uaInfo.device,
        browser: uaInfo.browser,
        os: uaInfo.os,
        referer,
        resultSize: resultSize ? `${resultSize} bytes` : null
    };
    
    console.log(JSON.stringify(logData));
}

// Request logging middleware
app.use((req, res, next) => {
    const startTime = Date.now();
    
    res.on('finish', () => {
        const responseTime = Date.now() - startTime;
        const resultSize = res.get('content-length');
        logRequest(req, res, responseTime, res.statusCode, resultSize);
    });
    
    next();
});

const allowedTypes = new Set(["json", "json-week", "ics", "ics-week"]);

const modernCalFormat = true;

//офсетные дны, генекрат baseDate - опциональный

function getDateOffset(offsetDays = 0, baseDate = null) {
    const d = baseDate ? new Date(baseDate) : new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().split('T')[0]; // YYYY-MM-DD
}
const cors = require('cors');
app.use(cors({
    origin: 'https://durka.su', // or '*' for all origins
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// gzip.  клиенты без Accept-Encoding: gzip получают ответ без сжатия.
const compression = require('compression');
app.use(compression({ threshold: 1024 })); // сжимать только ответы > 1 KB

app.get("/gen", async (req, res) => {
    const { date, group, type: rawType, tomorrow, subgroup = null, refresh } = req.query;


    //проверка на существование "type " в запросе
    if (!group || !rawType) {
        return res.status(400).send("Need: group, type (+ date or tomorrow/ics-week)");
    }

    const type = rawType.toLowerCase();

    if (!allowedTypes.has(type)) {
        return res.status(400).send("Bad type. Allowed: json, json-week, ics, ics-week");
    }

    //танцы с датой
    let baseDate;
    if (tomorrow === "true") { //если в запросе просят завтра отдаем // YYYY-MM-DD // в парсер как baseDate
        baseDate = getDateOffset(1, baseDate);
    } else if (date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { //если регулярка не проверила - нам дали кривую дату
            return res.status(400).send("Bad date format. Use YYYY-MM-DD");
        }
        baseDate = date;
    } else {
        baseDate = getDateOffset(0); // ну, просто потому чтобы не падало, пусть лучше сегодня будет чем 500
    }

    const forceRefresh = refresh === '1' || refresh === 'true';

    try {
        const startTime = Date.now();
        if (forceRefresh) {
            const { data: fullData } = await fetchStudentFromSourceAndSave(group, baseDate, subgroup, req, startTime, type);
            setCacheHeaders(res, null);
            if (type === "json" || type === "json-week") {
                if (type === "json-week") return res.json(fullData || {});
                const result = {};
                if (fullData && fullData[baseDate]) result[baseDate] = fullData[baseDate];
                return res.json(result);
            }
            const calendar = ical({ name: `Расписание для ${group}`, timezone: TIMEZONE });
            if (type === "ics-week") {
                for (const day in (fullData || {})) {
                    const lessons = (fullData[day]?.lessons || []).filter(l => l.time && l.time.includes("-"));
                    for (const lesson of lessons) {
                        const [st, et] = lesson.time.split("-");
                        const [hS, mS] = st.split(":").map(Number);
                        const [hE, mE] = et.split(":").map(Number);
                        const [y, mo, d] = day.split("-").map(Number);
                        calendar.createEvent({
                            start: new Date(y, mo - 1, d, hS, mS),
                            end: new Date(y, mo - 1, d, hE, mE),
                            summary: (lesson.name || '') + (lesson.type ? ` (${lesson.type})` : '') + ((lesson.auditory || lesson.room) || ''),
                            description: (lesson.teacher || '') + (lesson.subgroup ? ` | П/г: ${lesson.subgroup}` : ''),
                            location: (lesson.auditory || lesson.room) || '',
                            timezone: TIMEZONE
                        });
                    }
                }
            } else {
                const lessons = (fullData?.[baseDate]?.lessons || []).filter(l => l.time && l.time.includes("-"));
                for (const lesson of lessons) {
                    const [st, et] = lesson.time.split("-");
                    const [hS, mS] = st.split(":").map(Number);
                    const [hE, mE] = et.split(":").map(Number);
                    const [y, mo, d] = baseDate.split("-").map(Number);
                    calendar.createEvent({
                        start: new Date(y, mo - 1, d, hS, mS),
                        end: new Date(y, mo - 1, d, hE, mE),
                        summary: (lesson.name || '') + (lesson.type ? ` (${lesson.type})` : '') + ((lesson.auditory || lesson.room) || ''),
                        description: (lesson.teacher || '') + (lesson.subgroup ? ` | П/г: ${lesson.subgroup}` : ''),
                        location: (lesson.auditory || lesson.room) || '',
                        timezone: TIMEZONE
                    });
                }
            }
            res.setHeader("Content-Type", "text/calendar");
            res.setHeader("Content-Disposition", `inline; filename=schedule${type === "ics-week" ? "-week" : ""}.ics`);
            res.setHeader("Cache-Control", "no-store");
            return res.send(calendar.toString());
        }

        if (type === "json" || type === "json-week") {
            const { data: fullData, cacheInfo, source } = await getStudentFullData(group, baseDate, subgroup);
            setCacheHeaders(res, cacheInfo);
            if (source === 'source' && dbLayer && fullData) {
                try {
                    const requestStatsId = dbLayer.insertRequestStats({
                        ip: getClientIP(req),
                        userAgent: req.headers['user-agent'] || null,
                        entityType: 'group',
                        entityKey: group,
                        requestedAt: startTime,
                        processingTimeMs: Date.now() - startTime,
                        type,
                        source: 'source'
                    });
                    dbLayer.saveStudentScheduleToDb(group, baseDate, fullData, requestStatsId);
                } catch (e) {
                    console.warn("saveStudentScheduleToDb (source) failed:", e.message);
                }
            } else if (source !== 'source') {
                recordScheduleStats(req, startTime, 'group', group, type, source);
            }
            if (type === "json-week") {
                return res.json(fullData || {});
            } else {
                const result = {};
                if (fullData && fullData[baseDate]) {
                    result[baseDate] = fullData[baseDate];
                }
                return res.json(result);
            }
        }

        //если не json то нам сюда
        const calendar = ical({
            name: `Расписание для ${group}`,
            timezone: TIMEZONE
        });

        if (type === "ics-week") {
            const { data: fullData, cacheInfo, source } = await getStudentFullData(group, baseDate, subgroup);
            setCacheHeaders(res, cacheInfo);
            if (source === 'source' && dbLayer && fullData) {
                try {
                    const requestStatsId = dbLayer.insertRequestStats({
                        ip: getClientIP(req),
                        userAgent: req.headers['user-agent'] || null,
                        entityType: 'group',
                        entityKey: group,
                        requestedAt: startTime,
                        processingTimeMs: Date.now() - startTime,
                        type,
                        source: 'source'
                    });
                    dbLayer.saveStudentScheduleToDb(group, baseDate, fullData, requestStatsId);
                } catch (e) {
                    console.warn("saveStudentScheduleToDb (source) failed:", e.message);
                }
            } else if (source !== 'source') {
                recordScheduleStats(req, startTime, 'group', group, type, source);
            }
            if (fullData) {
                for (const day in fullData) {
                    const lessons = (fullData[day]?.lessons || []).filter(l => l.time && l.time.includes("-"));

                    for (const lesson of lessons) {
                        const [startTime, endTime] = lesson.time.split("-");
                        const [hourStart, minStart] = startTime.split(":").map(Number);
                        const [hourEnd, minEnd] = endTime.split(":").map(Number);
                        const [year, month, dayNum] = day.split("-").map(Number);

                        if (modernCalFormat) {
                            calendar.createEvent({
                                start: new Date(year, month - 1, dayNum, hourStart, minStart),
                                end: new Date(year, month - 1, dayNum, hourEnd, minEnd),
                                summary: lesson.name + (lesson.type ? ` (${lesson.type})` : "") + (lesson.auditory || lesson.room),
                                description: `${lesson.teacher}${lesson.subgroup ? ` | П/г: ${lesson.subgroup}` : ""}`,
                                location: (lesson.auditory || lesson.room),
                                timezone: TIMEZONE
                            });
                        } else if (!modernCalFormat) {
                            calendar.createEvent({
                                start: new Date(year, month - 1, dayNum, hourStart, minStart),
                                end: new Date(year, month - 1, dayNum, hourEnd, minEnd),
                                summary: lesson.name + (lesson.type ? ` (${lesson.type})` : ""),
                                description: `${lesson.teacher}${lesson.subgroup ? ` | П/г: ${lesson.subgroup}` : ""}`,
                                location: (lesson.auditory || lesson.room),
                                timezone: TIMEZONE
                            });
                        }
                    }
                }
            }
        } else {
            const { data: fullData, cacheInfo, source } = await getStudentFullData(group, baseDate, subgroup);
            setCacheHeaders(res, cacheInfo);
            if (source === 'source' && dbLayer && fullData) {
                try {
                    const requestStatsId = dbLayer.insertRequestStats({
                        ip: getClientIP(req),
                        userAgent: req.headers['user-agent'] || null,
                        entityType: 'group',
                        entityKey: group,
                        requestedAt: startTime,
                        processingTimeMs: Date.now() - startTime,
                        type,
                        source: 'source'
                    });
                    dbLayer.saveStudentScheduleToDb(group, baseDate, fullData, requestStatsId);
                } catch (e) {
                    console.warn("saveStudentScheduleToDb (source) failed:", e.message);
                }
            } else if (source !== 'source') {
                recordScheduleStats(req, startTime, 'group', group, type, source);
            }
            const lessons = (fullData?.[baseDate]?.lessons || []).filter(l => l.time && l.time.includes("-"));

            for (const lesson of lessons) {
                const [startTime, endTime] = lesson.time.split("-");
                const [hourStart, minStart] = startTime.split(":").map(Number);
                const [hourEnd, minEnd] = endTime.split(":").map(Number);
                const [year, month, dayNum] = baseDate.split("-").map(Number);

                if (modernCalFormat) {
                    calendar.createEvent({
                        start: new Date(year, month - 1, dayNum, hourStart, minStart),
                        end: new Date(year, month - 1, dayNum, hourEnd, minEnd),
                        summary: lesson.name + (lesson.type ? ` (${lesson.type})` : "") + (lesson.auditory || lesson.room),
                        description: `${lesson.teacher}${lesson.subgroup ? ` | П/г: ${lesson.subgroup}` : ""}`,
                        location: (lesson.auditory || lesson.room),
                        timezone: TIMEZONE
                    });
                } else if (!modernCalFormat) {
                    calendar.createEvent({
                        start: new Date(year, month - 1, dayNum, hourStart, minStart),
                        end: new Date(year, month - 1, dayNum, hourEnd, minEnd),
                        summary: lesson.name + (lesson.type ? ` (${lesson.type})` : ""),
                        description: `${lesson.teacher}${lesson.subgroup ? ` | П/г: ${lesson.subgroup}` : ""}`,
                        location: (lesson.auditory || lesson.room),
                        timezone: TIMEZONE
                    });
                }
            }
        }

        res.setHeader("Content-Type", "text/calendar");
        res.setHeader("Content-Disposition", `inline; filename=schedule${type === "ics-week" ? "-week" : ""}.ics`);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Published-TTL", "PT1H");

        res.send(calendar.toString());
    } catch (err) {
        console.error(err);
        res.status(500).send("damm 500, you must be hard on this, don't you?");
    }
});


app.get("/gen_teach", async (req, res) => {
    const { date, teacher, type: rawType, tomorrow, refresh } = req.query;

    if (!teacher || !rawType) {
        return res.status(400).send("Need: teacher, type (+ date or tomorrow/json-week/ics-week)");
    }

    const type = rawType.toLowerCase();

    if (!allowedTypes.has(type)) {
        return res.status(400).send("Bad type. Allowed: json, json-week, ics, ics-week");
    }

    let baseDate;

    if (tomorrow === "true") {
        baseDate = getDateOffset(1, baseDate);
    } else if (date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).send("Bad date format. Use YYYY-MM-DD");
        }
        baseDate = date;
    } else {
        baseDate = getDateOffset(0, baseDate); // сегодня
    }

    const forceRefresh = refresh === '1' || refresh === 'true';

    try {
        const startTime = Date.now();
        if (forceRefresh) {
            const { data: fullData } = await fetchTeacherFromSourceAndSave(teacher, baseDate, req, startTime, type);
            setCacheHeaders(res, null);
            if (type === "json" || type === "json-week") {
                if (type === "json-week") return res.json(fullData || {});
                const result = {};
                if (fullData && fullData[baseDate]) result[baseDate] = fullData[baseDate];
                return res.json(result);
            }
            const calendar = ical({ name: `Расписание для ${teacher}`, timezone: TIMEZONE });
            if (type === "ics-week") {
                for (const day in (fullData || {})) {
                    const lessons = (fullData[day]?.lessons || []).filter(l => l.time && l.time.includes("-"));
                    for (const lesson of lessons) {
                        const [st, et] = lesson.time.split("-");
                        const [hS, mS] = st.split(":").map(Number);
                        const [hE, mE] = et.split(":").map(Number);
                        const [y, mo, d] = day.split("-").map(Number);
                        calendar.createEvent({
                            start: new Date(y, mo - 1, d, hS, mS),
                            end: new Date(y, mo - 1, d, hE, mE),
                            summary: lesson.subject || "Занятие",
                            description: `${lesson.room || ""} ${lesson.group || ""}`,
                            location: lesson.room || "",
                            timezone: TIMEZONE
                        });
                    }
                }
            } else {
                const lessons = (fullData?.[baseDate]?.lessons || []).filter(l => l.time && l.time.includes("-"));
                for (const lesson of lessons) {
                    const [st, et] = lesson.time.split("-");
                    const [hS, mS] = st.split(":").map(Number);
                    const [hE, mE] = et.split(":").map(Number);
                    const [y, mo, d] = baseDate.split("-").map(Number);
                    calendar.createEvent({
                        start: new Date(y, mo - 1, d, hS, mS),
                        end: new Date(y, mo - 1, d, hE, mE),
                        summary: lesson.subject || "Занятие",
                        description: `${lesson.room || ""} ${lesson.group || ""}`,
                        location: lesson.room || "",
                        timezone: TIMEZONE
                    });
                }
            }
            res.setHeader("Content-Type", "text/calendar");
            res.setHeader("Content-Disposition", `inline; filename=schedule${type === "ics-week" ? "-week" : ""}.ics`);
            res.setHeader("Cache-Control", "no-store");
            return res.send(calendar.toString());
        }

        if (type === "json" || type === "json-week") {
            const { data: fullData, cacheInfo, source } = await getTeacherFullData(teacher, baseDate);
            setCacheHeaders(res, cacheInfo);
            if (source === 'source' && dbLayer && fullData) {
                try {
                    const requestStatsId = dbLayer.insertRequestStats({
                        ip: getClientIP(req),
                        userAgent: req.headers['user-agent'] || null,
                        entityType: 'teacher',
                        entityKey: teacher,
                        requestedAt: startTime,
                        processingTimeMs: Date.now() - startTime,
                        type,
                        source: 'source'
                    });
                    dbLayer.saveTeacherScheduleToDb(teacher, baseDate, fullData, requestStatsId);
                } catch (e) {
                    console.warn("saveTeacherScheduleToDb (source) failed:", e.message);
                }
            } else if (source !== 'source') {
                recordScheduleStats(req, startTime, 'teacher', teacher, type, source);
            }
            if (type === "json-week") {
                return res.json(fullData || {});
            } else {
                const result = {};
                if (fullData && fullData[baseDate]) {
                    result[baseDate] = fullData[baseDate];
                }
                return res.json(result);
            }
        }

        const calendar = ical({
            name: `Расписание для ${teacher}`,
            timezone: TIMEZONE
        });

        if (type === "ics-week") {
            const { data: fullData, cacheInfo, source } = await getTeacherFullData(teacher, baseDate);
            setCacheHeaders(res, cacheInfo);
            if (source === 'source' && dbLayer && fullData) {
                try {
                    const requestStatsId = dbLayer.insertRequestStats({
                        ip: getClientIP(req),
                        userAgent: req.headers['user-agent'] || null,
                        entityType: 'teacher',
                        entityKey: teacher,
                        requestedAt: startTime,
                        processingTimeMs: Date.now() - startTime,
                        type,
                        source: 'source'
                    });
                    dbLayer.saveTeacherScheduleToDb(teacher, baseDate, fullData, requestStatsId);
                } catch (e) {
                    console.warn("saveTeacherScheduleToDb (source) failed:", e.message);
                }
            } else if (source !== 'source') {
                recordScheduleStats(req, startTime, 'teacher', teacher, type, source);
            }
            if (fullData) {
                for (const day in fullData) {
                    const lessons = (fullData[day]?.lessons || []).filter(l => l.time && l.time.includes("-"));

                    for (const lesson of lessons) {
                        const [startTime, endTime] = lesson.time.split("-");
                        const [hourStart, minStart] = startTime.split(":").map(Number);
                        const [hourEnd, minEnd] = endTime.split(":").map(Number);
                        const [year, month, dayNum] = day.split("-").map(Number);

                        if (modernCalFormat) {
                            calendar.createEvent({
                                start: new Date(year, month - 1, dayNum, hourStart, minStart),
                                end: new Date(year, month - 1, dayNum, hourEnd, minEnd),
                                summary: lesson.subject || "Занятие",
                                description: `${lesson.room || ""} ${lesson.group || ""}${lesson.note ? ` | ${lesson.note}` : ""}`,
                                location: lesson.room || "",
                                timezone: TIMEZONE
                            });
                        }
                        else if (!modernCalFormat) {
                            calendar.createEvent({
                                start: new Date(year, month - 1, dayNum, hourStart, minStart),
                                end: new Date(year, month - 1, dayNum, hourEnd, minEnd),
                                summary: lesson.subject || "Занятие",
                                description: `${lesson.group || ""}${lesson.note ? ` | ${lesson.note}` : ""}`,
                                location: lesson.room || "",
                                timezone: TIMEZONE
                            });
                        }
                    }
                }
            }
        } else {
            const { data: fullData, cacheInfo, source } = await getTeacherFullData(teacher, baseDate);
            setCacheHeaders(res, cacheInfo);
            if (source === 'source' && dbLayer && fullData) {
                try {
                    const requestStatsId = dbLayer.insertRequestStats({
                        ip: getClientIP(req),
                        userAgent: req.headers['user-agent'] || null,
                        entityType: 'teacher',
                        entityKey: teacher,
                        requestedAt: startTime,
                        processingTimeMs: Date.now() - startTime,
                        type,
                        source: 'source'
                    });
                    dbLayer.saveTeacherScheduleToDb(teacher, baseDate, fullData, requestStatsId);
                } catch (e) {
                    console.warn("saveTeacherScheduleToDb (source) failed:", e.message);
                }
            } else if (source !== 'source') {
                recordScheduleStats(req, startTime, 'teacher', teacher, type, source);
            }
            const lessons = (fullData?.[baseDate]?.lessons || []).filter(l => l.time && l.time.includes("-"));

            for (const lesson of lessons) {
                const [startTime, endTime] = lesson.time.split("-");
                const [hourStart, minStart] = startTime.split(":").map(Number);
                const [hourEnd, minEnd] = endTime.split(":").map(Number);
                const [year, month, dayNum] = baseDate.split("-").map(Number);

                if (modernCalFormat) {
                    calendar.createEvent({
                        start: new Date(year, month - 1, dayNum, hourStart, minStart),
                        end: new Date(year, month - 1, dayNum, hourEnd, minEnd),
                        summary: lesson.subject || "Занятие",
                        description: `${lesson.room || ""} ${lesson.group || ""}${lesson.note ? ` | ${lesson.note}` : ""}`,
                        location: lesson.room || "",
                        timezone: TIMEZONE
                    });
                }
                else if (!modernCalFormat) {
                    calendar.createEvent({
                        start: new Date(year, month - 1, dayNum, hourStart, minStart),
                        end: new Date(year, month - 1, dayNum, hourEnd, minEnd),
                        summary: lesson.subject || "Занятие",
                        description: `${lesson.group || ""}${lesson.note ? ` | ${lesson.note}` : ""}`,
                        location: lesson.room || "",
                        timezone: TIMEZONE
                    });
                }
            }
        }

        res.setHeader("Content-Type", "text/calendar");
        res.setHeader("Content-Disposition", `inline; filename=schedule${type === "ics-week" ? "-week" : ""}.ics`);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Published-TTL", "PT1H");

        res.send(calendar.toString());
    } catch (err) {
        console.error(err);
        res.status(500).send("damm 500, you must be hard on this, don't you?");
    }
});

app.get("/gen_auditory", async (req, res) => {
    const { date, auditory, type: rawType, tomorrow, refresh } = req.query;

    if (!auditory || !rawType) {
        return res.status(400).send("Need: auditory, type (+ date or tomorrow/json-week/ics-week)");
    }

    const type = rawType.toLowerCase();

    if (!allowedTypes.has(type)) {
        return res.status(400).send("Bad type. Allowed: json, json-week, ics, ics-week");
    }

    let baseDate;

    if (tomorrow === "true") {
        baseDate = getDateOffset(1, baseDate);
    } else if (date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).send("Bad date format. Use YYYY-MM-DD");
        }
        baseDate = date;
    } else {
        baseDate = getDateOffset(0, baseDate);
    }

    const forceRefresh = refresh === '1' || refresh === 'true';

    try {
        const startTime = Date.now();
        if (forceRefresh) {
            const { data: fullData } = await fetchAuditoryFromSourceAndSave(auditory, baseDate, req, startTime, type);
            setCacheHeaders(res, null);
            if (type === "json" || type === "json-week") {
                if (type === "json-week") return res.json(fullData || {});
                const result = {};
                if (fullData && fullData[baseDate]) result[baseDate] = fullData[baseDate];
                return res.json(result);
            }
            const calendar = ical({ name: `Расписание для аудитории ${auditory}`, timezone: TIMEZONE });
            if (type === "ics-week") {
                for (const day in (fullData || {})) {
                    const lessons = (fullData[day]?.lessons || []).filter(l => l.time && l.time.includes("-"));
                    for (const lesson of lessons) {
                        const [st, et] = lesson.time.split("-");
                        const [hS, mS] = st.split(":").map(Number);
                        const [hE, mE] = et.split(":").map(Number);
                        const [y, mo, d] = day.split("-").map(Number);
                        calendar.createEvent({
                            start: new Date(y, mo - 1, d, hS, mS),
                            end: new Date(y, mo - 1, d, hE, mE),
                            summary: lesson.subject || lesson.name || "Занятие",
                            description: `${lesson.room || ""} ${lesson.group || ""}${lesson.teacher ? ` | ${lesson.teacher}` : ""}`,
                            location: lesson.room || "",
                            timezone: TIMEZONE
                        });
                    }
                }
            } else {
                const lessons = (fullData?.[baseDate]?.lessons || []).filter(l => l.time && l.time.includes("-"));
                for (const lesson of lessons) {
                    const [st, et] = lesson.time.split("-");
                    const [hS, mS] = st.split(":").map(Number);
                    const [hE, mE] = et.split(":").map(Number);
                    const [y, mo, d] = baseDate.split("-").map(Number);
                    calendar.createEvent({
                        start: new Date(y, mo - 1, d, hS, mS),
                        end: new Date(y, mo - 1, d, hE, mE),
                        summary: lesson.subject || lesson.name || "Занятие",
                        description: `${lesson.room || ""} ${lesson.group || ""}${lesson.teacher ? ` | ${lesson.teacher}` : ""}`,
                        location: lesson.room || "",
                        timezone: TIMEZONE
                    });
                }
            }
            res.setHeader("Content-Type", "text/calendar");
            res.setHeader("Content-Disposition", `inline; filename=schedule-auditory${type === "ics-week" ? "-week" : ""}.ics`);
            res.setHeader("Cache-Control", "no-store");
            return res.send(calendar.toString());
        }

        if (type === "json" || type === "json-week") {
            const { data: fullData, cacheInfo, source } = await getAuditoryFullData(auditory, baseDate);
            setCacheHeaders(res, cacheInfo);
            if (source === 'source' && dbLayer && fullData) {
                try {
                    const requestStatsId = dbLayer.insertRequestStats({
                        ip: getClientIP(req),
                        userAgent: req.headers['user-agent'] || null,
                        entityType: 'auditory',
                        entityKey: auditory,
                        requestedAt: startTime,
                        processingTimeMs: Date.now() - startTime,
                        type,
                        source: 'source'
                    });
                    dbLayer.saveAuditoryScheduleToDb(auditory, baseDate, fullData, requestStatsId);
                } catch (e) {
                    console.warn("saveAuditoryScheduleToDb (source) failed:", e.message);
                }
            } else if (source !== 'source') {
                recordScheduleStats(req, startTime, 'auditory', auditory, type, source);
            }
            if (type === "json-week") {
                return res.json(fullData || {});
            } else {
                const result = {};
                if (fullData && fullData[baseDate]) {
                    result[baseDate] = fullData[baseDate];
                }
                return res.json(result);
            }
        }

        const calendar = ical({
            name: `Расписание для аудитории ${auditory}`,
            timezone: TIMEZONE
        });

        if (type === "ics-week") {
            const { data: fullData, cacheInfo, source } = await getAuditoryFullData(auditory, baseDate);
            setCacheHeaders(res, cacheInfo);
            if (source === 'source' && dbLayer && fullData) {
                try {
                    const requestStatsId = dbLayer.insertRequestStats({
                        ip: getClientIP(req),
                        userAgent: req.headers['user-agent'] || null,
                        entityType: 'auditory',
                        entityKey: auditory,
                        requestedAt: startTime,
                        processingTimeMs: Date.now() - startTime,
                        type,
                        source: 'source'
                    });
                    dbLayer.saveAuditoryScheduleToDb(auditory, baseDate, fullData, requestStatsId);
                } catch (e) {
                    console.warn("saveAuditoryScheduleToDb (source) failed:", e.message);
                }
            } else if (source !== 'source') {
                recordScheduleStats(req, startTime, 'auditory', auditory, type, source);
            }
            if (fullData) {
                for (const day in fullData) {
                    const lessons = (fullData[day]?.lessons || []).filter(l => l.time && l.time.includes("-"));
                    for (const lesson of lessons) {
                        const [startTime, endTime] = lesson.time.split("-");
                        const [hourStart, minStart] = startTime.split(":").map(Number);
                        const [hourEnd, minEnd] = endTime.split(":").map(Number);
                        const [year, month, dayNum] = day.split("-").map(Number);
                        if (modernCalFormat) {
                            calendar.createEvent({
                                start: new Date(year, month - 1, dayNum, hourStart, minStart),
                                end: new Date(year, month - 1, dayNum, hourEnd, minEnd),
                                summary: lesson.subject || "Занятие",
                                description: `${lesson.room || ""} ${lesson.group || ""}${lesson.teacher ? ` | ${lesson.teacher}` : ""}`,
                                location: lesson.room || "",
                                timezone: TIMEZONE
                            });
                        } else {
                            calendar.createEvent({
                                start: new Date(year, month - 1, dayNum, hourStart, minStart),
                                end: new Date(year, month - 1, dayNum, hourEnd, minEnd),
                                summary: lesson.subject || "Занятие",
                                description: `${lesson.group || ""}${lesson.teacher ? ` | ${lesson.teacher}` : ""}`,
                                location: lesson.room || "",
                                timezone: TIMEZONE
                            });
                        }
                    }
                }
            }
        } else {
            const { data: fullData, cacheInfo, source } = await getAuditoryFullData(auditory, baseDate);
            setCacheHeaders(res, cacheInfo);
            if (source === 'source' && dbLayer && fullData) {
                try {
                    const requestStatsId = dbLayer.insertRequestStats({
                        ip: getClientIP(req),
                        userAgent: req.headers['user-agent'] || null,
                        entityType: 'auditory',
                        entityKey: auditory,
                        requestedAt: startTime,
                        processingTimeMs: Date.now() - startTime,
                        type,
                        source: 'source'
                    });
                    dbLayer.saveAuditoryScheduleToDb(auditory, baseDate, fullData, requestStatsId);
                } catch (e) {
                    console.warn("saveAuditoryScheduleToDb (source) failed:", e.message);
                }
            } else if (source !== 'source') {
                recordScheduleStats(req, startTime, 'auditory', auditory, type, source);
            }
            const lessons = (fullData?.[baseDate]?.lessons || []).filter(l => l.time && l.time.includes("-"));
            for (const lesson of lessons) {
                const [startTime, endTime] = lesson.time.split("-");
                const [hourStart, minStart] = startTime.split(":").map(Number);
                const [hourEnd, minEnd] = endTime.split(":").map(Number);
                const [year, month, dayNum] = baseDate.split("-").map(Number);
                if (modernCalFormat) {
                    calendar.createEvent({
                        start: new Date(year, month - 1, dayNum, hourStart, minStart),
                        end: new Date(year, month - 1, dayNum, hourEnd, minEnd),
                        summary: lesson.subject || "Занятие",
                        description: `${lesson.room || ""} ${lesson.group || ""}${lesson.teacher ? ` | ${lesson.teacher}` : ""}`,
                        location: lesson.room || "",
                        timezone: TIMEZONE
                    });
                } else {
                    calendar.createEvent({
                        start: new Date(year, month - 1, dayNum, hourStart, minStart),
                        end: new Date(year, month - 1, dayNum, hourEnd, minEnd),
                        summary: lesson.subject || "Занятие",
                        description: `${lesson.group || ""}${lesson.teacher ? ` | ${lesson.teacher}` : ""}`,
                        location: lesson.room || "",
                        timezone: TIMEZONE
                    });
                }
            }
        }

        res.setHeader("Content-Type", "text/calendar");
        res.setHeader("Content-Disposition", `inline; filename=schedule-auditory${type === "ics-week" ? "-week" : ""}.ics`);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Published-TTL", "PT1H");

        res.send(calendar.toString());
    } catch (err) {
        console.error(err);
        res.status(500).send("damm 500, you must be hard on this, don't you?");
    }
});














////////КЕШИРОВАНИЕ ДАННЫХ ПРЕПОДОВ И ГРУПП СТУДЕНТОВ

const CACHE_TTL = 3600000; // 1 час в миллисекундах
const SCHEDULE_CACHE_TTL = 7200000; // 2 часа для расписаний
let groupsCache = {
    data: [],
    lastUpdated: 0
};
let teachersCache = {
    data: [],
    lastUpdated: 0
};
let auditoriesCache = {
    data: [],
    lastUpdated: 0
};

// Кэш расписаний: ключ = "student:group:date:subgroup" или "teacher:name:date"
let scheduleCache = new Map();

// Функции для работы с кэшем расписаний
function getScheduleCacheKey(type, entity, date, subgroup = null) {
    if (type === 'student') {
        return `student:${entity}:${date}:${subgroup || 'all'}`;
    }
    if (type === 'teacher') {
        return `teacher:${entity}:${date}`;
    }
    if (type === 'auditory') {
        return `auditory:${entity}:${date}`;
    }
    return `teacher:${entity}:${date}`;
}

function getCachedSchedule(key) {
    const cached = scheduleCache.get(key);
    if (cached && (Date.now() - cached.timestamp < SCHEDULE_CACHE_TTL)) {
        const age = Date.now() - cached.timestamp;
        const ttl = SCHEDULE_CACHE_TTL - age;
        return {
            data: cached.data,
            cacheHit: true,
            cacheAge: age,
            cacheTTL: ttl
        };
    }
    if (cached) {
        scheduleCache.delete(key);
    }
    return null;
}

function setCacheHeaders(res, cacheInfo) {
    if (cacheInfo && cacheInfo.cacheHit) {
        res.setHeader('X-Cache-Hit', 'true');
        res.setHeader('X-Cache-Age', Math.floor(cacheInfo.cacheAge / 1000)); // seconds
        res.setHeader('X-Cache-TTL', Math.floor(cacheInfo.cacheTTL / 1000)); // seconds
    } else {
        res.setHeader('X-Cache-Hit', 'false');
    }
}

function setCachedSchedule(key, data) {
    scheduleCache.set(key, {
        data: data,
        timestamp: Date.now()
    });
    // Очистка старых записей (если кэш больше 1000 записей)
    if (scheduleCache.size > 1000) {
        const now = Date.now();
        for (const [k, v] of scheduleCache.entries()) {
            if (now - v.timestamp > SCHEDULE_CACHE_TTL) {
                scheduleCache.delete(k);
            }
        }
    }
}

function recordScheduleStats(req, startTime, entityType, entityKey, responseType, source) {
    if (dbLayer && dbLayer.insertRequestStats) {
        try {
            dbLayer.insertRequestStats({
                ip: getClientIP(req),
                userAgent: req.headers['user-agent'] || null,
                entityType,
                entityKey,
                requestedAt: startTime,
                processingTimeMs: Date.now() - startTime,
                type: responseType,
                source: source || 'cache'
            });
        } catch (e) {
            console.warn("request_stats insert failed:", e.message);
        }
    }
}

async function getStudentFullData(group, baseDate, subgroup) {
    const cacheKey = getScheduleCacheKey('student', group, baseDate, subgroup);
    const cacheInfo = getCachedSchedule(cacheKey);
    if (cacheInfo) return { data: cacheInfo.data, cacheInfo, source: 'cache' };
    if (dbLayer) {
        const weekData = dbLayer.getStudentScheduleWeek(group, baseDate, subgroup);
        if (weekData) {
            setCachedSchedule(cacheKey, weekData);
            return { data: weekData, cacheInfo: null, source: 'db' };
        }
    }
    const parsed = await parseStudent(baseDate, group, subgroup);
    if (parsed) setCachedSchedule(cacheKey, parsed);
    return { data: parsed || {}, cacheInfo: null, source: 'source' };
}

async function getTeacherFullData(teacher, baseDate) {
    const cacheKey = getScheduleCacheKey('teacher', teacher, baseDate);
    const cacheInfo = getCachedSchedule(cacheKey);
    if (cacheInfo) return { data: cacheInfo.data, cacheInfo, source: 'cache' };
    if (dbLayer) {
        const weekData = dbLayer.getTeacherScheduleWeek(teacher, baseDate);
        if (weekData) {
            setCachedSchedule(cacheKey, weekData);
            return { data: weekData, cacheInfo: null, source: 'db' };
        }
    }
    const parsed = await parseTeacher(baseDate, teacher);
    if (parsed) setCachedSchedule(cacheKey, parsed);
    return { data: parsed || {}, cacheInfo: null, source: 'source' };
}

async function getAuditoryFullData(auditory, baseDate) {
    const cacheKey = getScheduleCacheKey('auditory', auditory, baseDate);
    const cacheInfo = getCachedSchedule(cacheKey);
    if (cacheInfo) return { data: cacheInfo.data, cacheInfo, source: 'cache' };
    if (dbLayer) {
        const weekData = dbLayer.getAuditoryScheduleWeek(auditory, baseDate);
        if (weekData) {
            setCachedSchedule(cacheKey, weekData);
            return { data: weekData, cacheInfo: null, source: 'db' };
        }
    }
    const parsed = await parseAuditory(baseDate, auditory);
    if (parsed) setCachedSchedule(cacheKey, parsed);
    return { data: parsed || {}, cacheInfo: null, source: 'source' };
}

/** When user asked for refresh: fetch from source, update cache and DB, log with source_asked */
async function fetchStudentFromSourceAndSave(group, baseDate, subgroup, req, startTime, type) {
    const fullData = await parseStudent(baseDate, group, subgroup);
    const cacheKey = getScheduleCacheKey('student', group, baseDate, subgroup);
    if (fullData) setCachedSchedule(cacheKey, fullData);
    let requestStatsId = null;
    if (dbLayer && fullData) {
        try {
            requestStatsId = dbLayer.insertRequestStats({
                ip: getClientIP(req),
                userAgent: req.headers['user-agent'] || null,
                entityType: 'group',
                entityKey: group,
                requestedAt: startTime,
                processingTimeMs: Date.now() - startTime,
                type,
                source: 'source_asked'
            });
            dbLayer.saveStudentScheduleToDb(group, baseDate, fullData, requestStatsId);
        } catch (e) {
            console.warn("refresh saveStudentScheduleToDb failed:", e.message);
        }
    }
    return { data: fullData || {} };
}

async function fetchTeacherFromSourceAndSave(teacher, baseDate, req, startTime, type) {
    const fullData = await parseTeacher(baseDate, teacher);
    const cacheKey = getScheduleCacheKey('teacher', teacher, baseDate);
    if (fullData) setCachedSchedule(cacheKey, fullData);
    if (dbLayer && fullData) {
        try {
            const requestStatsId = dbLayer.insertRequestStats({
                ip: getClientIP(req),
                userAgent: req.headers['user-agent'] || null,
                entityType: 'teacher',
                entityKey: teacher,
                requestedAt: startTime,
                processingTimeMs: Date.now() - startTime,
                type,
                source: 'source_asked'
            });
            dbLayer.saveTeacherScheduleToDb(teacher, baseDate, fullData, requestStatsId);
        } catch (e) {
            console.warn("refresh saveTeacherScheduleToDb failed:", e.message);
        }
    }
    return { data: fullData || {} };
}

async function fetchAuditoryFromSourceAndSave(auditory, baseDate, req, startTime, type) {
    const fullData = await parseAuditory(baseDate, auditory);
    const cacheKey = getScheduleCacheKey('auditory', auditory, baseDate);
    if (fullData) setCachedSchedule(cacheKey, fullData);
    if (dbLayer && fullData) {
        try {
            const requestStatsId = dbLayer.insertRequestStats({
                ip: getClientIP(req),
                userAgent: req.headers['user-agent'] || null,
                entityType: 'auditory',
                entityKey: auditory,
                requestedAt: startTime,
                processingTimeMs: Date.now() - startTime,
                type,
                source: 'source_asked'
            });
            dbLayer.saveAuditoryScheduleToDb(auditory, baseDate, fullData, requestStatsId);
        } catch (e) {
            console.warn("refresh saveAuditoryScheduleToDb failed:", e.message);
        }
    }
    return { data: fullData || {} };
}


app.get('/api/groups', async (req, res) => {
    try {
        // Если кэш устарел, обновляем его
        if (Date.now() - groupsCache.lastUpdated > CACHE_TTL) {
            const response = await fetch('https://kis.vgltu.ru/list?type=Group');
            const groups = await response.json();

            groupsCache = {
                data: Array.isArray(groups) ? groups.filter(g => typeof g === 'string' && g.trim() !== '') : [],
                lastUpdated: Date.now()
            };
        }

        res.json(groupsCache.data);
    } catch (error) {
        console.error('Ошибка при получении групп:', error);
        res.status(500).json({ error: 'Не удалось получить список групп' });
    }
});

app.get('/api/teachers', async (req, res) => {
    try {
        // Если кэш устарел, обновляем его
        if (Date.now() - teachersCache.lastUpdated > CACHE_TTL) {
            const response = await fetch('https://kis.vgltu.ru/list?type=Teacher');
            const teachers = await response.json();

            teachersCache = {
                data: Array.isArray(teachers) ? teachers.filter(g => typeof g === 'string' && g.trim() !== '') : [],
                lastUpdated: Date.now()
            };
        }

        res.json(teachersCache.data);
    } catch (error) {
        console.error('Ошибка при получении групп:', error);
        res.status(500).json({ error: 'Не удалось получить список групп' });
    }
});

app.get('/api/auditories', async (req, res) => {
    try {
        if (Date.now() - auditoriesCache.lastUpdated > CACHE_TTL) {
            const response = await fetch('https://kis.vgltu.ru/list?type=Auditory');
            const list = await response.json();
            const auditories = Array.isArray(list) ? list.filter(a => typeof a === 'string' && a.trim() !== '') : [];
            if (dbLayer && dbLayer.ensureAuditory) {
                for (const name of auditories) {
                    try { dbLayer.ensureAuditory(name); } catch (_) {}
                }
            }
            auditoriesCache = { data: auditories, lastUpdated: Date.now() };
        }
        res.json(auditoriesCache.data);
    } catch (error) {
        console.error('Ошибка при получении аудиторий:', error);
        res.status(500).json({ error: 'Не удалось получить список аудиторий' });
    }
});

// Cache-Control для HTML-страниц (то же значение, что и для статики)
app.use((req, res, next) => {
    if (req.method === 'GET' && ['/gui', '/searchStudent', '/searchTeacher', '/searchAuditory'].includes(req.path)) {
        res.setHeader('Cache-Control', `public, max-age=${STATIC_CACHE_MAX_AGE_SECONDS}`);
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res) => {
        res.setHeader('Cache-Control', `public, max-age=${STATIC_CACHE_MAX_AGE_SECONDS}`);
    }
}));


// Роут для /gui
app.get('/gui', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'gui.html'));
});

// Search for teacher location today
app.get('/searchTeach', async (req, res) => {
    const { teacher } = req.query;

    if (!teacher) {
        return res.status(400).json({ error: 'Teacher parameter is required' });
    }

    try {
        const today = getDateOffset(0); // Get today's date
        const teacherSchedule = await parseTeacher(today, teacher);

        if (!teacherSchedule || !teacherSchedule[today]) {
            return res.json({
                teacher: teacher,
                date: today,
                message: 'No lessons found for today',
                lessons: []
            });
        }

        const lessons = teacherSchedule[today].lessons || [];
        const activeLessons = lessons.filter(lesson =>
            lesson.time &&
            lesson.time.includes('-') &&
            lesson.room &&
            lesson.group
        );

        // Format response for easy display
        const formattedLessons = activeLessons.map(lesson => ({
            time: lesson.time,
            subject: lesson.subject || 'Занятие',
            room: lesson.room,
            group: lesson.group,
            note: lesson.note || ''
        }));

        res.json({
            teacher: teacher,
            date: today,
            dayOfWeek: teacherSchedule[today].dayOfWeek,
            lessons: formattedLessons,
            totalLessons: formattedLessons.length
        });

    } catch (error) {
        console.error('Error searching for teacher:', error);
        res.status(500).json({
            error: 'Failed to search for teacher location',
            message: error.message
        });
    }
});

// Роут для поиска преподавателя
app.get('/searchTeacher', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'searchTeacher.html'));
});

// Роут для поиска расписания по аудитории
app.get('/searchAuditory', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'searchAuditory.html'));
});

// Роут для поиска расписания группы
app.get('/searchStudent', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'searchStudent.html'));
});

app.listen(port, () => {
    console.log(`server ok!`);
});
