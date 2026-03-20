'use strict';

const { Markup } = require('telegraf');
const { decodePayload } = require('../payload');

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getBaseDate(scope) {
    const d = new Date();
    if (scope === 'tomorrow') d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
}

function getWeekDates(baseDate) {
    const out = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(baseDate + 'T12:00:00');
        d.setDate(d.getDate() + i);
        out.push(d.toISOString().split('T')[0]);
    }
    return out;
}

function normalizeHHMM(text) {
    const s = String(text ?? '').trim();
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
    if (h < 0 || h > 23) return null;
    if (min < 0 || min > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Shared: fetch schedule and return formatted text (header + body). Used by private /start inline and by inline results. */
async function getScheduleText(payload, lang, deps, opts = {}) {
    const { jsapi, formatScheduleBlock, T } = deps;
    const L = T[lang] || T.ru;
    const baseDate = getBaseDate(payload.scope);
    let data = {};
    if (payload.entityType === 'group') {
        const r = await jsapi.getScheduleGroup(payload.entityKey, baseDate, null, opts);
        data = r.data || {};
    } else if (payload.entityType === 'teacher') {
        if (payload.scope === 'week') {
            for (const date of getWeekDates(baseDate)) {
                const r = await jsapi.getScheduleTeacher(payload.entityKey, date, opts);
                if (r && r.data && typeof r.data === 'object') Object.assign(data, r.data);
            }
        } else {
            const r = await jsapi.getScheduleTeacher(payload.entityKey, baseDate, opts);
            data = r.data || {};
        }
    } else {
        if (payload.scope === 'week') {
            for (const date of getWeekDates(baseDate)) {
                const r = await jsapi.getScheduleAuditory(payload.entityKey, date, opts);
                if (r && r.data && typeof r.data === 'object') Object.assign(data, r.data);
            }
        } else {
            const r = await jsapi.getScheduleAuditory(payload.entityKey, baseDate, opts);
            data = r.data || {};
        }
    }
    if (payload.scope === 'today' || payload.scope === 'tomorrow') {
        data = data[baseDate] != null ? { [baseDate]: data[baseDate] } : {};
    }
    const label = payload.entityType === 'group' ? payload.entityKey : (payload.entityType === 'teacher' ? L.teacher + ' ' + payload.entityKey : L.auditory + ' ' + payload.entityKey);
    const scopeLabel = payload.scope === 'week' ? L.week : (payload.scope === 'tomorrow' ? L.tomorrow : L.today);
    const header = `<b><i>${escapeHtml(scopeLabel)}</i></b>: ${escapeHtml(label)}`;
    const body = formatScheduleBlock(data, lang, T);
    return header + '\n\n' + body;
}

async function registerPrivateHandlers(bot, { db, jsapi, buildUserAgent, T, formatScheduleBlock }) {
    bot.start(async (ctx) => {
        try {
            const payloadArg = (ctx.message && ctx.message.text || '').replace(/^\/start\s*/, '').trim();
            if (payloadArg && payloadArg.startsWith('inline_')) {
                const rest = payloadArg.slice(7);
                const payload = (db.getTgInlineLutByCode && db.getTgInlineLutByCode(rest)) || decodePayload(rest);
                if (!payload || !payload.entityKey) {
                    await ctx.reply((T[ctx.from?.language_code === 'en' ? 'en' : 'ru'] || T.ru).link_expired || 'Ссылка устарела или не найдена. Попробуйте снова выбрать расписание в поиске.');
                    return;
                }
                const lang = payload.lang || 'ru';
                const opts = {
                    ip: 'telegram',
                    userAgent: buildUserAgent('inline', ctx.from?.id, ctx.chat?.id, payload.entityType, payload.entityKey, payload.scope),
                    startTime: Date.now(),
                    type: 'json'
                };
                const text = await getScheduleText(payload, lang, { jsapi, formatScheduleBlock, T }, opts);
                await ctx.reply(text, { parse_mode: 'HTML' });
                return;
            }

            const lang = db.getTgUserLang(ctx.from.id);
            if (!lang) {
                await ctx.reply(T.ru.welcome_private, Markup.inlineKeyboard([
                    [Markup.button.callback('Русский', 'lang_ru'), Markup.button.callback('English', 'lang_en')]
                ]));
                return;
            }
            const L = T[lang] || T.ru;
            await ctx.reply(L.welcome_private, Markup.inlineKeyboard([
                [Markup.button.callback(L.add_group, 'pv_add_group'), Markup.button.callback(L.add_teacher, 'pv_add_teacher')],
                [Markup.button.callback(L.add_auditory, 'pv_add_auditory')],
                [Markup.button.callback(L.my_subs, 'pv_my_subs'), Markup.button.callback(L.set_time, 'pv_set_time')],
                [Markup.button.callback(L.change_lang, 'pv_set_lang')]
            ]));
        } catch (e) {
            console.error('[tgbot] start', e);
            ctx.reply(T.ru.error(e.message)).catch(() => {});
        }
    });

    bot.action(/^lang_(ru|en)$/, async (ctx) => {
        try {
            const lang = ctx.match[1];
            db.setTgUserLang(ctx.from.id, lang);
            const L = T[lang] || T.ru;
            await ctx.answerCbQuery();
            await ctx.reply(L.welcome_private, Markup.inlineKeyboard([
                [Markup.button.callback(L.add_group, 'pv_add_group'), Markup.button.callback(L.add_teacher, 'pv_add_teacher')],
                [Markup.button.callback(L.add_auditory, 'pv_add_auditory')],
                [Markup.button.callback(L.my_subs, 'pv_my_subs'), Markup.button.callback(L.set_time, 'pv_set_time')],
                [Markup.button.callback(L.change_lang, 'pv_set_lang')]
            ]));
        } catch (e) {
            ctx.answerCbQuery().catch(() => {});
        }
    });

    bot.action('pv_set_lang', async (ctx) => {
        try {
            const lang = db.getTgUserLang(ctx.from.id) || 'ru';
            const L = T[lang] || T.ru;
            await ctx.answerCbQuery();
            await ctx.reply(L.choose_lang, Markup.inlineKeyboard([
                [Markup.button.callback(L.lang_ru, 'lang_ru'), Markup.button.callback(L.lang_en, 'lang_en')]
            ]));
        } catch (e) {
            ctx.answerCbQuery().catch(() => {});
        }
    });

    bot.action(/^pv_add_(group|teacher|auditory)$/, async (ctx) => {
        try {
            const entityType = ctx.match[1];
            const lang = db.getTgUserLang(ctx.from.id) || 'ru';
            const L = T[lang] || T.ru;
            await ctx.answerCbQuery();
            ctx.session = ctx.session || {};
            ctx.session.pendingEntityType = entityType;
            await ctx.reply(L.enter_entity(L[entityType]));
        } catch (e) {
            ctx.answerCbQuery().catch(() => {});
        }
    });

    bot.on('text', async (ctx, next) => {
        try {
            const session = ctx.session || {};
            const text = (ctx.message && ctx.message.text || '').trim();
            const pending = session.pendingEntityType;
            if (pending && text) {
                db.addTgSubscription(ctx.from.id, pending, text, '07:00');
                const lang = db.getTgUserLang(ctx.from.id) || 'ru';
                const L = T[lang] || T.ru;
                delete session.pendingEntityType;
                await ctx.reply(L.sub_added(`${pending} ${text}`));
                return;
            }
            if (session.pendingSetTime) {
                const normalized = normalizeHHMM(text);
                const lang = db.getTgUserLang(ctx.from.id) || 'ru';
                const L = T[lang] || T.ru;
                if (!normalized) {
                    await ctx.reply(L.set_time_prompt);
                    return;
                }
                db.updateTgUserSendTime(ctx.from.id, normalized);
                delete session.pendingSetTime;
                await ctx.reply(L.time_updated(normalized));
                return;
            }
            next();
        } catch (e) {
            next();
        }
    });

    bot.action('pv_my_subs', async (ctx) => {
        try {
            const subs = db.getTgUserSubscriptions(ctx.from.id);
            const lang = db.getTgUserLang(ctx.from.id) || 'ru';
            const L = T[lang] || T.ru;
            await ctx.answerCbQuery();
            if (!subs || subs.length === 0) return ctx.reply(L.no_subs);
            const keyboard = subs.map(s => [Markup.button.callback(`${s.entity_type} ${s.entity_key}`, `pv_rm_${s.id}`)]);
            keyboard.push([Markup.button.callback(L.remove_all_subs_btn, 'pv_rm_all')]);
            await ctx.reply(L.my_subs, Markup.inlineKeyboard(keyboard));
        } catch (e) {
            ctx.answerCbQuery().catch(() => {});
        }
    });

    bot.action(/^pv_rm_(\d+)$/, async (ctx) => {
        try {
            const id = parseInt(ctx.match[1], 10);
            db.removeTgSubscription(ctx.from.id, id);
            const lang = db.getTgUserLang(ctx.from.id) || 'ru';
            const L = T[lang] || T.ru;
            await ctx.answerCbQuery();
            await ctx.reply(L.sub_removed);
        } catch (e) {
            ctx.answerCbQuery().catch(() => {});
        }
    });

    bot.action('pv_rm_all', async (ctx) => {
        try {
            db.removeTgSubscriptionAll(ctx.from.id);
            const lang = db.getTgUserLang(ctx.from.id) || 'ru';
            const L = T[lang] || T.ru;
            await ctx.answerCbQuery();
            await ctx.reply(L.all_removed);
        } catch (e) {
            ctx.answerCbQuery().catch(() => {});
        }
    });

    bot.action('pv_set_time', async (ctx) => {
        try {
            const lang = db.getTgUserLang(ctx.from.id) || 'ru';
            const L = T[lang] || T.ru;
            await ctx.answerCbQuery();
            await ctx.reply(L.set_time_prompt);
            ctx.session = ctx.session || {};
            ctx.session.pendingSetTime = true;
        } catch (e) {
            ctx.answerCbQuery().catch(() => {});
        }
    });
}

module.exports = { registerPrivateHandlers, getScheduleText };
