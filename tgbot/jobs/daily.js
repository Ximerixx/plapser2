'use strict';

const cron = require('node-cron');
const DEFAULT_SEND_TIME = '07:00';
const TIMEZONE = 'Europe/Moscow';
const DELAY_BETWEEN_SENDS_MS = 300;

function formatScheduleBlock(data, lang, T) {
    const L = T[lang] || T.ru;
    const lines = [];
    for (const date of Object.keys(data).sort()) {
        const day = data[date];
        if (!day || !day.lessons) continue;
        lines.push(`\n${day.date || date} (${day.dayOfWeek || ''})`);
        for (const lesson of day.lessons) {
            if (lesson.status === 'Нет пар' || lesson.status === L.no_lessons) {
                lines.push('  — ' + (lesson.status || L.no_lessons));
            } else {
                lines.push(`  ${lesson.time || ''} ${lesson.name || lesson.subject || ''} ${lesson.teacher || ''} ${lesson.auditory || lesson.room || ''}`);
            }
        }
    }
    return lines.join('\n') || L.no_lessons;
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
                const startTime = Date.now();
                let data;
                if (row.entity_type === 'group') {
                    const r = await jsapi.getScheduleGroup(row.entity_key, getBaseDateForScope('today'), null, {
                        ip: 'telegram',
                        userAgent: buildUserAgent('group', null, chatId, row.entity_type, row.entity_key, 'today'),
                        startTime,
                        type: 'json'
                    });
                    data = r.data;
                } else if (row.entity_type === 'teacher') {
                    const r = await jsapi.getScheduleTeacher(row.entity_key, getBaseDateForScope('today'), {
                        ip: 'telegram',
                        userAgent: buildUserAgent('group', null, chatId, row.entity_type, row.entity_key, 'today'),
                        startTime,
                        type: 'json'
                    });
                    data = r.data;
                } else {
                    const r = await jsapi.getScheduleAuditory(row.entity_key, getBaseDateForScope('today'), {
                        ip: 'telegram',
                        userAgent: buildUserAgent('group', null, chatId, row.entity_type, row.entity_key, 'today'),
                        startTime,
                        type: 'json'
                    });
                    data = r.data;
                }
                const text = formatScheduleBlock(data || {}, lang, T);
                blocks.push(`${row.entity_type} ${row.entity_key}:\n${text}`);
                await new Promise(r => setTimeout(r, DELAY_BETWEEN_SENDS_MS));
            }
            await ctx.telegram.sendMessage(chatId, blocks.join('\n\n———\n\n'));
        } catch (e) {
            console.error('[tgbot] daily group send error', chatId, e.message);
        }
    }

    for (const [userId, rows] of byUser) {
        try {
            const lang = db.getTgUserLang(userId) || 'ru';
            for (const row of rows) {
                const startTime = Date.now();
                let data;
                if (row.entity_type === 'group') {
                    const r = await jsapi.getScheduleGroup(row.entity_key, getBaseDateForScope('today'), null, {
                        ip: 'telegram',
                        userAgent: buildUserAgent('private', userId, null, row.entity_type, row.entity_key, 'today'),
                        startTime,
                        type: 'json'
                    });
                    data = r.data;
                } else if (row.entity_type === 'teacher') {
                    const r = await jsapi.getScheduleTeacher(row.entity_key, getBaseDateForScope('today'), {
                        ip: 'telegram',
                        userAgent: buildUserAgent('private', userId, null, row.entity_type, row.entity_key, 'today'),
                        startTime,
                        type: 'json'
                    });
                    data = r.data;
                } else {
                    const r = await jsapi.getScheduleAuditory(row.entity_key, getBaseDateForScope('today'), {
                        ip: 'telegram',
                        userAgent: buildUserAgent('private', userId, null, row.entity_type, row.entity_key, 'today'),
                        startTime,
                        type: 'json'
                    });
                    data = r.data;
                }
                const text = formatScheduleBlock(data || {}, lang, T);
                await ctx.telegram.sendMessage(userId, `${row.entity_type} ${row.entity_key}:\n${text}`);
                await new Promise(r => setTimeout(r, DELAY_BETWEEN_SENDS_MS));
            }
        } catch (e) {
            console.error('[tgbot] daily private send error', userId, e.message);
        }
    }
}

function startDailyCron(telegram, ctx) {
    cron.schedule('* * * * *', () => runDailyJob({ ...ctx, telegram }), { timezone: TIMEZONE });
}

module.exports = { startDailyCron, runDailyJob, formatScheduleBlock, getBaseDateForScope };
