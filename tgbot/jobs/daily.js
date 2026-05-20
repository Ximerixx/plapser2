'use strict';

const DEFAULT_SEND_TIME = '07:00';
const TIMEZONE = 'Europe/Moscow';
const DELAY_BETWEEN_SENDS_MS = 300;

// function formatScheduleBlock(data, lang, T) {
//     const L = T[lang] || T.ru;
//     const lines = [];
//     for (const date of Object.keys(data).sort()) {
//         const day = data[date];
//         if (!day || !day.lessons) continue;
//         lines.push(`\n${day.date || date} (${day.dayOfWeek || ''})`);
//         for (const lesson of day.lessons) {
//             if (lesson.status === 'Нет пар' || lesson.status === L.no_lessons) {
//                 lines.push('  — ' + (lesson.status || L.no_lessons));
//             } else {
//                 const sub = lesson.subgroup ? ` П/г: ${lesson.subgroup}` : '';
//                 lines.push(`  ${lesson.time || ''} ${lesson.name || lesson.subject || ''} ${lesson.teacher || ''} ${lesson.auditory || lesson.room || ''}${sub}`);
//             }
//         }
//     }
//     return lines.join('\n') || L.no_lessons;
// }


function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isNoLessons(lesson, L) {
    return lesson && (lesson.status === 'Нет пар' || lesson.status === L.no_lessons);
}

function formatLessonDescriptor(lesson) {
    // Делаем каждый "кусок" отдельной строкой, чтобы переносы работали
    // и внутри `<blockquote>` (Telegram parse_mode: HTML).
    const lines = [];

    const title = lesson.name || lesson.subject || '';
    if (title) lines.push(escapeHtml(title));

    const subgroup = lesson.subgroup != null ? String(lesson.subgroup).trim() : '';
    if (subgroup) lines.push(`П/г: ${escapeHtml(subgroup)}`);

    // "после каждой группы новая строка":
    // - если есть массив `lesson.groups`, выводим каждый элемент на своей строке
    // - иначе выводим `lesson.group` как одну строку
    if (lesson.group) {
        lines.push(escapeHtml(lesson.group));
    } else if (Array.isArray(lesson.groups) && lesson.groups.length > 0) {
        for (const g of lesson.groups) lines.push(escapeHtml(g));
    }

    const teacher = lesson.teacher || '';
    if (teacher) lines.push(escapeHtml(teacher));

    const room = lesson.auditory || lesson.room || '';
    if (room) lines.push(escapeHtml(room));

    return lines.join('\n');
}

function timeSortKey(timeRange) {
    // timeRange: "HH:MM-HH:MM"
    if (!timeRange || typeof timeRange !== 'string') return 0;
    const start = timeRange.split('-')[0] || '';
    const [h, m] = start.split(':').map(v => parseInt(v, 10));
    const hh = Number.isFinite(h) ? h : 0;
    const mm = Number.isFinite(m) ? m : 0;
    return hh * 60 + mm;
}

function formatScheduleBlock(data, lang, T) {
    const L = T[lang] || T.ru;
    const lines = [];

    for (const date of Object.keys(data).sort()) {
        const day = data[date];
        if (!day || !day.lessons) continue;

        const dateText = day.date || date;
        const dayOfWeek = day.dayOfWeek || '';
        const dayTitle = dayOfWeek ? `${escapeHtml(dateText)} (${escapeHtml(dayOfWeek)})` : escapeHtml(dateText);
        // Дата — курсивом в отдельном блоке цитаты
        lines.push(`<blockquote><i>${dayTitle}</i></blockquote>`);

        const noLesson = day.lessons.length === 1 && isNoLessons(day.lessons[0], L);
        if (noLesson) {
            lines.push(`<blockquote>— ${escapeHtml(day.lessons[0].status || L.no_lessons)}</blockquote>`);
            continue;
        }

        // Группировка по одному и тому же временно́му слоту
        const byTime = new Map(); // time => [descriptorHTML]
        for (const lesson of day.lessons) {
            if (isNoLessons(lesson, L)) continue;
            if (!lesson || !lesson.time) continue;
            const time = lesson.time;
            if (!byTime.has(time)) byTime.set(time, []);
            byTime.get(time).push(formatLessonDescriptor(lesson));
        }

        const times = Array.from(byTime.keys()).sort((a, b) => timeSortKey(a) - timeSortKey(b));
        if (times.length === 0) {
            lines.push(`<blockquote>— ${escapeHtml(L.no_lessons)}</blockquote>`);
            continue;
        }

        for (const time of times) {
            const descriptors = byTime.get(time) || [];
            // Если в одно и то же время есть два занятия, объединяем в один блок цитаты через дефисы.
            const banner = '-----------------------------------';
            const joined = descriptors.join(`\n${banner}\n`);
            // В HTML parse_mode Telegram для inline-вставок не поддерживает `<br>`-теги.
            // Поэтому используем обычный перенос строки внутри quote-блока.
            lines.push(`<blockquote>${escapeHtml(time)}\n${joined}</blockquote>`);
        }
    }

    return lines.join('\n') || `<blockquote>— ${escapeHtml(L.no_lessons)}</blockquote>`;
}


function getBaseDateForScope(scope) {
    const d = new Date();
    const today = d.toISOString().split('T')[0];
    if (scope === 'tomorrow') {
        d.setDate(d.getDate() + 1);
        return d.toISOString().split('T')[0];
    }
    if (scope === 'week') return today;
    return today;
}

function getCurrentHHMMInTimezone(tz) {
    const now = new Date();
    const h = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(now), 10);
    const m = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: tz, minute: '2-digit' }).format(now), 10);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function sendOptsForRow(row) {
    const opts = { parse_mode: 'HTML' };
    if (row.silent) opts.disable_notification = true;
    return opts;
}

function allSameSilent(rows) {
    if (!rows.length) return true;
    const first = !!rows[0].silent;
    return rows.every(r => !!r.silent === first);
}

async function fetchScheduleForRow(row, chatId, userId, jsapi, buildUserAgent) {
    const startTime = Date.now();
    const isGroup = row.type === 'group';
    const uaOpts = {
        ip: 'telegram',
        userAgent: buildUserAgent(
            isGroup ? 'group' : 'private',
            isGroup ? null : userId,
            isGroup ? chatId : null,
            row.entity_type,
            row.entity_key,
            'today'
        ),
        startTime,
        type: 'json'
    };
    const baseDate = getBaseDateForScope('today');
    if (row.entity_type === 'group') {
        const r = await jsapi.getScheduleGroup(row.entity_key, baseDate, null, uaOpts);
        return r.data;
    }
    if (row.entity_type === 'teacher') {
        const r = await jsapi.getScheduleTeacher(row.entity_key, baseDate, uaOpts);
        return r.data;
    }
    const r = await jsapi.getScheduleAuditory(row.entity_key, baseDate, uaOpts);
    return r.data;
}

function formatRowBlock(data, row, lang, T, forGroupChat) {
    const dayOnly = forGroupChat && data && data[getBaseDateForScope('today')]
        ? { [getBaseDateForScope('today')]: data[getBaseDateForScope('today')] }
        : (data || {});
    const text = formatScheduleBlock(dayOnly, lang, T);
    return `${row.entity_type} ${row.entity_key}:\n${text}`;
}

async function runDailyJob(ctx) {
    const { db, jsapi, buildUserAgent, T } = ctx;
    const hhmm = getCurrentHHMMInTimezone(TIMEZONE);

    const due = db.getTgSubscriptionsDueForTime(hhmm);
    if (!due || due.length === 0) return;

    const byChat = new Map();
    const byUser = new Map();
    for (const row of due) {
        if (row.type === 'group') {
            const key = row.chat_id;
            if (!byChat.has(key)) byChat.set(key, []);
            byChat.get(key).push(row);
        } else {
            const key = row.user_id;
            if (!byUser.has(key)) byUser.set(key, []);
            byUser.get(key).push(row);
        }
    }

    for (const [chatId, rows] of byChat) {
        try {
            const lang = db.getTgChatLang(chatId) || 'ru';
            const blocks = [];
            for (const row of rows) {
                const data = await fetchScheduleForRow(row, chatId, null, jsapi, buildUserAgent);
                blocks.push({ row, text: formatRowBlock(data, row, lang, T, true) });
                await new Promise(r => setTimeout(r, DELAY_BETWEEN_SENDS_MS));
            }
            if (allSameSilent(rows)) {
                const silent = !!rows[0].silent;
                const opts = { parse_mode: 'HTML' };
                if (silent) opts.disable_notification = true;
                await ctx.telegram.sendMessage(chatId, blocks.map(b => b.text).join('\n\n———\n\n'), opts);
            } else {
                for (const { row, text } of blocks) {
                    await ctx.telegram.sendMessage(chatId, text, sendOptsForRow(row));
                    await new Promise(r => setTimeout(r, DELAY_BETWEEN_SENDS_MS));
                }
            }
        } catch (e) {
            console.error('[tgbot] daily group send error', chatId, e.message);
        }
    }

    for (const [userId, rows] of byUser) {
        try {
            const lang = db.getTgUserLang(userId) || 'ru';
            for (const row of rows) {
                const data = await fetchScheduleForRow(row, null, userId, jsapi, buildUserAgent);
                const text = formatRowBlock(data, row, lang, T, false);
                await ctx.telegram.sendMessage(userId, text, sendOptsForRow(row));
                await new Promise(r => setTimeout(r, DELAY_BETWEEN_SENDS_MS));
            }
        } catch (e) {
            console.error('[tgbot] daily private send error', userId, e.message);
        }
    }
}

function startDailyCron(telegram, ctx) {
    const cron = require('node-cron');
    cron.schedule('* * * * *', () => runDailyJob({ ...ctx, telegram }), { timezone: TIMEZONE });
}

module.exports = { startDailyCron, runDailyJob, formatScheduleBlock, getBaseDateForScope };
