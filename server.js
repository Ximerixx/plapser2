const express = require("express");
const ical = require("ical-generator").default;
const fs = require('fs');
const path = require('path');
//const { parseTeacher } = require("./parser/parseTeacher");
//const { parseAuditory } = require("./parser/parseAuditory");
const { Worker } = require('worker_threads');

const { loadTgbotConfig } = require('./tgbot/config.loader');
const tgbotConfig = loadTgbotConfig();

let dbLayer = null;
try {
    dbLayer = require("./db/db");
} catch (e) {
    console.warn("DB layer not available:", e.message);
}

const jsapi = require("./jsapi");

const app = express();
const port = 3000;
const TIMEZONE = "Europe/Moscow";

// Статика: max-age в секундах (браузер не перезапросит раньше). Для теста — 1 ч; для прода — 86400 (сутки) или 604800 (неделя).
const STATIC_CACHE_MAX_AGE_SECONDS = 3600;

// Эйджинг: не отдавать из БД данные старше FRESHNESS_HOURS; идти в KIS.
//const FRESHNESS_HOURS = 2;
//const FRESHNESS_SECONDS = FRESHNESS_HOURS * 3600;

// Предзагрузка топа: окно для подсчёта запросов (дней), лимит на тип, интервалы (мс).
const PRELOAD_TOP_DAYS = 7;
const PRELOAD_TOP_LIMIT = 5;
const TOP_RECALC_INTERVAL_MS = 30 * 60 * 1000;  // пересчёт топа в 2 раза чаще предзагрузки
const PRELOAD_INTERVAL_MS = 60 * 60 * 1000;

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

// gzip клиенты без Accept-Encoding: gzip получают ответ без сжатия.
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
            const { data: fullData } = await jsapi.fetchStudentFromSourceAndSave(group, baseDate, subgroup, { ip: getClientIP(req), userAgent: req.headers['user-agent'], startTime, type });
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
            const { data: fullData, cacheInfo } = await jsapi.getScheduleGroup(group, baseDate, subgroup, { ip: getClientIP(req), userAgent: req.headers['user-agent'], startTime, type });
            setCacheHeaders(res, cacheInfo);
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
            const { data: fullData, cacheInfo } = await jsapi.getScheduleGroup(group, baseDate, subgroup, { ip: getClientIP(req), userAgent: req.headers['user-agent'], startTime, type });
            setCacheHeaders(res, cacheInfo);
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
            const { data: fullData, cacheInfo } = await jsapi.getScheduleGroup(group, baseDate, subgroup, { ip: getClientIP(req), userAgent: req.headers['user-agent'], startTime, type });
            setCacheHeaders(res, cacheInfo);
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
            const { data: fullData } = await jsapi.fetchTeacherFromSourceAndSave(teacher, baseDate, { ip: getClientIP(req), userAgent: req.headers['user-agent'], startTime, type });
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
            const { data: fullData, cacheInfo } = await jsapi.getScheduleTeacher(teacher, baseDate, { ip: getClientIP(req), userAgent: req.headers['user-agent'], startTime, type });
            setCacheHeaders(res, cacheInfo);
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
            const { data: fullData, cacheInfo } = await jsapi.getScheduleTeacher(teacher, baseDate, { ip: getClientIP(req), userAgent: req.headers['user-agent'], startTime, type });
            setCacheHeaders(res, cacheInfo);
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
            const { data: fullData, cacheInfo } = await jsapi.getScheduleTeacher(teacher, baseDate, { ip: getClientIP(req), userAgent: req.headers['user-agent'], startTime, type });
            setCacheHeaders(res, cacheInfo);
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
            const { data: fullData } = await jsapi.fetchAuditoryFromSourceAndSave(auditory, baseDate, { ip: getClientIP(req), userAgent: req.headers['user-agent'], startTime, type });
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
            const { data: fullData, cacheInfo } = await jsapi.getScheduleAuditory(auditory, baseDate, { ip: getClientIP(req), userAgent: req.headers['user-agent'], startTime, type });
            setCacheHeaders(res, cacheInfo);
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
            const { data: fullData, cacheInfo } = await jsapi.getScheduleAuditory(auditory, baseDate, { ip: getClientIP(req), userAgent: req.headers['user-agent'], startTime, type });
            setCacheHeaders(res, cacheInfo);
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
            const { data: fullData, cacheInfo } = await jsapi.getScheduleAuditory(auditory, baseDate, { ip: getClientIP(req), userAgent: req.headers['user-agent'], startTime, type });
            setCacheHeaders(res, cacheInfo);
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














function setCacheHeaders(res, cacheInfo) {
    if (cacheInfo && cacheInfo.cacheHit) {
        res.setHeader('X-Cache-Hit', 'true');
        res.setHeader('X-Cache-Age', Math.floor(cacheInfo.cacheAge / 1000));
        res.setHeader('X-Cache-TTL', Math.floor(cacheInfo.cacheTTL / 1000));
    } else {
        res.setHeader('X-Cache-Hit', 'false');
    }
}

function runTopRecalc() {
    if (!dbLayer || !dbLayer.getTopRequestedEntities || !dbLayer.upsertPreloadState) return;
    try {
        const entities = dbLayer.getTopRequestedEntities(PRELOAD_TOP_DAYS, PRELOAD_TOP_LIMIT);
        dbLayer.upsertPreloadState(entities);
    } catch (e) {
        console.warn("runTopRecalc failed:", e.message);
    }
}

async function runSchedulePreload() {
    if (!dbLayer || !dbLayer.getPreloadStateEntities || !dbLayer.updateLastPreloaded) return;
    const today = getDateOffset(0);
    try {
        const list = dbLayer.getPreloadStateEntities();
        for (const row of list) {
            try {
                if (row.entity_type === 'group') {
                    await jsapi.getScheduleGroup(row.entity_key, today, null);
                } else if (row.entity_type === 'teacher') {
                    await jsapi.getScheduleTeacher(row.entity_key, today);
                } else if (row.entity_type === 'auditory') {
                    await jsapi.getScheduleAuditory(row.entity_key, today);
                }
                dbLayer.updateLastPreloaded(row.entity_type, row.entity_key);
            } catch (_) { }
        }
    } catch (e) {
        console.warn("runSchedulePreload failed:", e.message);
    }
}

app.get('/api/groups', async (req, res) => {
    try {
        const data = await jsapi.getGroupsList();
        res.json(data);
    } catch (error) {
        console.error('Ошибка при получении групп:', error);
        res.status(500).json({ error: 'Не удалось получить список групп' });
    }
});

app.get('/api/teachers', async (req, res) => {
    try {
        const data = await jsapi.getTeachersList();
        res.json(data);
    } catch (error) {
        console.error('Ошибка при получении преподавателей:', error);
        res.status(500).json({ error: 'Не удалось получить список преподавателей' });
    }
});

app.get('/api/auditories', async (req, res) => {
    try {
        const data = await jsapi.getAuditoriesList();
        res.json(data);
    } catch (error) {
        console.error('Ошибка при получении аудиторий:', error);
        res.status(500).json({ error: 'Не удалось получить список аудиторий' });
    }
});

app.get('/api/free-auditories/slots', (req, res) => {
    const { date, today, tomorrow, building } = req.query;
    const baseDate = jsapi.resolveBaseDate({ date, today, tomorrow });
    if (!baseDate) {
        return res.status(400).json({ error: 'Bad date format. Use YYYY-MM-DD' });
    }
    try {
        const slots = jsapi.getFreeAuditorySlots(baseDate, building || null);
        return res.json({ date: baseDate, building: building ? String(building).trim().toUpperCase() : null, slots });
    } catch (e) {
        console.error('free-auditories/slots failed:', e);
        return res.status(500).json({ error: 'Failed to load slots' });
    }
});

app.get('/api/free-auditories/by-slot', (req, res) => {
    const { date, today, tomorrow, building, slot, auditory_type: auditoryType } = req.query;
    const baseDate = jsapi.resolveBaseDate({ date, today, tomorrow });
    if (!baseDate) {
        return res.status(400).json({ error: 'Bad date format. Use YYYY-MM-DD' });
    }
    if (!building) {
        return res.status(400).json({ error: 'building is required' });
    }
    if (!slot || !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(String(slot))) {
        return res.status(400).json({ error: 'slot is required in HH:MM-HH:MM format' });
    }
    try {
        const freeAuditories = jsapi.getFreeAuditoriesBySlot(baseDate, String(slot), String(building), auditoryType || null);
        return res.json({
            date: baseDate,
            building: String(building).trim().toUpperCase(),
            slot: String(slot),
            auditoryType: auditoryType || null,
            count: freeAuditories.length,
            freeAuditories
        });
    } catch (e) {
        console.error('free-auditories/by-slot failed:', e);
        return res.status(500).json({ error: 'Failed to load free auditories by slot' });
    }
});

app.get('/api/free-auditories/by-room', (req, res) => {
    const { date, today, tomorrow, building, auditory } = req.query;
    const baseDate = jsapi.resolveBaseDate({ date, today, tomorrow });
    if (!baseDate) {
        return res.status(400).json({ error: 'Bad date format. Use YYYY-MM-DD' });
    }
    if (!auditory) {
        return res.status(400).json({ error: 'auditory is required' });
    }
    try {
        const result = jsapi.getFreeSlotsByAuditory(baseDate, String(auditory), building || null);
        if (!result) return res.status(404).json({ error: 'Auditory not found in normalized storage' });
        return res.json({
            date: baseDate,
            auditoryQuery: String(auditory),
            auditory: result.auditory,
            freeSlots: result.freeSlots,
            occupiedSlots: result.occupiedSlots
        });
    } catch (e) {
        console.error('free-auditories/by-room failed:', e);
        return res.status(500).json({ error: 'Failed to load free slots by auditory' });
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
        const { data: teacherSchedule } = await jsapi.getScheduleTeacher(teacher, today);

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
    console.log(`server ok! prealoading top...`);
    setImmediate(runTopRecalc);
    setInterval(runTopRecalc, TOP_RECALC_INTERVAL_MS);
    setTimeout(runSchedulePreload, 2 * 60 * 1000);
    setInterval(runSchedulePreload, PRELOAD_INTERVAL_MS);
    console.log('preloading is complete, functioning as normal');

    const token = tgbotConfig.token;
    if (token) {
        const workerPath = path.join(__dirname, 'tgbot', 'worker.js');
        const apiBaseUrl = tgbotConfig.apiBaseUrl || `http://127.0.0.1:${port}`;
        try {
            const tgbotWorker = new Worker(workerPath, {
                workerData: {
                    token,
                    apiBaseUrl,
                    botUsername: tgbotConfig.botUsername ?? null,
                    proxyUrl: tgbotConfig.proxyUrl ?? null
                }
            });
            tgbotWorker.on('error', (err) => console.error('[tgbot] worker error', err));
            tgbotWorker.on('exit', (code) => { if (code !== 0) console.error('[tgbot] worker exit', code); });
        } catch (e) {
            console.error('[tgbot] worker spawn failed', e.message);
        }
    }
});
