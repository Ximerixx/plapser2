'use strict';

const { Markup } = require('telegraf');

function subscriptionEntityLabel(sub) {
    return `${sub.entity_type} ${sub.entity_key}`;
}

function buildGroupSubsKeyboard(subs, L) {
    const keyboard = subs.map(s => {
        const entity = subscriptionEntityLabel(s);
        return [
            Markup.button.callback(s.silent ? L.make_loud_btn(entity) : L.make_silent_btn(entity), `tg_silent_${s.id}`),
            Markup.button.callback(L.remove_sub_btn(entity), `tg_rm_${s.id}`)
        ];
    });
    keyboard.push([Markup.button.callback(L.remove_all_subs_btn, 'tg_rm_all')]);
    return keyboard;
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

function ensureSession(ctx) {
    if (!ctx.session) ctx.session = {};
    return ctx.session;
}

function clearPendingGroupAdd(session) {
    delete session.pendingGroupEntityType;
    delete session.pendingGroupChatId;
    delete session.pendingNotifyEntityType;
    delete session.pendingNotifyEntityKey;
    delete session.pendingNotifyChatId;
}

function parseSettimeArg(messageText) {
    const raw = String(messageText ?? '').trim();
    const m = raw.match(/^\/settime(?:@\w+)?\s*(.*)$/i);
    return m ? m[1].trim() : '';
}

function isAdmin(ctx) {
    const chat = ctx.chat;
    if (!chat || chat.type === 'private') return true;
    const from = ctx.from;
    if (!from) return false;
    try {
        const member = ctx.telegram.callApi ? null : null;
        return true; // simplified: allow all in group; can later use getChatAdministrators
    } catch (_) {
        return false;
    }
}

async function registerGroupHandlers(bot, { db, apiBaseUrl, getLists, T, buildUserAgent }) {
    async function applyChatSendTime(ctx, timeText) {
        const chatId = ctx.chat?.id;
        if (!chatId) return false;
        const lang = db.getTgChatLang(chatId) || 'ru';
        const L = T[lang] || T.ru;
        const normalized = normalizeHHMM(timeText);
        if (!normalized) {
            await ctx.reply(L.set_time_prompt);
            return false;
        }
        db.updateTgChatSendTime(chatId, normalized);
        const session = ensureSession(ctx);
        delete session.pendingGroupSetTime;
        clearPendingGroupAdd(session);
        await ctx.reply(L.time_updated(normalized));
        return true;
    }

    bot.command('settime', async (ctx, next) => {
        try {
            if (ctx.chat.type === 'private') return next();
            if (!isAdmin(ctx)) return ctx.reply('Только администраторы.');
            const chatId = ctx.chat.id;
            const lang = db.getTgChatLang(chatId) || 'ru';
            const L = T[lang] || T.ru;
            const arg = parseSettimeArg(ctx.message && ctx.message.text);
            if (!arg) {
                const session = ensureSession(ctx);
                clearPendingGroupAdd(session);
                session.pendingGroupSetTime = true;
                await ctx.reply(L.set_time_prompt);
                return;
            }
            await applyChatSendTime(ctx, arg);
        } catch (e) {
            console.error('[tgbot] settime group', e);
            ctx.reply(T.ru.error(e.message)).catch(() => {});
        }
    });

    bot.command('setgroup', async (ctx) => {
        try {
            if (ctx.chat.type === 'private') return ctx.reply('Команда для группового чата.');
            if (!isAdmin(ctx)) return ctx.reply('Только администраторы могут добавлять подписки.');
            const lang = db.getTgChatLang(ctx.chat.id) || 'ru';
            const L = T[lang] || T.ru;
            await ctx.reply(L.choose_entity_type, Markup.inlineKeyboard([
                [Markup.button.callback(L.group, 'tg_type_group')],
                [Markup.button.callback(L.teacher, 'tg_type_teacher')],
                [Markup.button.callback(L.auditory, 'tg_type_auditory')]
            ]));
        } catch (e) {
            console.error('[tgbot] setgroup', e);
            ctx.reply(T.ru.error(e.message)).catch(() => { });
        }
    });

    async function finishGroupSubscription(ctx, silent) {
        const session = ctx.session || {};
        const entityType = session.pendingNotifyEntityType;
        const entityKey = session.pendingNotifyEntityKey;
        const chatId = session.pendingNotifyChatId;
        if (!entityType || !entityKey || !chatId) {
            await ctx.answerCbQuery();
            return;
        }
        const lang = db.getTgChatLang(chatId) || 'ru';
        const L = T[lang] || T.ru;
        const entity = `${entityType} ${entityKey}`;
        db.addTgGroupSub(chatId, entityType, entityKey, '07:00', silent);
        delete session.pendingNotifyEntityType;
        delete session.pendingNotifyEntityKey;
        delete session.pendingNotifyChatId;
        delete session.pendingGroupEntityType;
        delete session.pendingGroupChatId;
        await ctx.answerCbQuery();
        await ctx.reply(L.sub_added(entity, silent));
    }

    bot.action('tg_notify_silent', async (ctx) => {
        try {
            if (!isAdmin(ctx)) return ctx.answerCbQuery();
            await finishGroupSubscription(ctx, true);
        } catch (e) {
            ctx.answerCbQuery().catch(() => { });
        }
    });

    bot.action('tg_notify_loud', async (ctx) => {
        try {
            if (!isAdmin(ctx)) return ctx.answerCbQuery();
            await finishGroupSubscription(ctx, false);
        } catch (e) {
            ctx.answerCbQuery().catch(() => { });
        }
    });

    bot.action(/^tg_type_(group|teacher|auditory)$/, async (ctx) => {
        try {
            const entityType = ctx.match[1];
            const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
            const lang = db.getTgChatLang(chatId) || 'ru';
            const L = T[lang] || T.ru;
            await ctx.answerCbQuery();
            await ctx.reply(L.enter_entity(L[entityType]) + '\n(Отправьте название следующим сообщением)');
            const session = ensureSession(ctx);
            delete session.pendingGroupSetTime;
            clearPendingGroupAdd(session);
            session.pendingGroupEntityType = entityType;
            session.pendingGroupChatId = chatId;
        } catch (e) {
            console.error('[tgbot] group type action', e);
            ctx.answerCbQuery().catch(() => { });
        }
    });

    bot.command('removesubs', async (ctx) => {
        try {
            if (ctx.chat.type === 'private') return;
            if (!isAdmin(ctx)) return ctx.reply('Только администраторы.');
            const chatId = ctx.chat.id;
            const subs = db.getTgSubsByChatId(chatId);
            const lang = db.getTgChatLang(chatId) || 'ru';
            const L = T[lang] || T.ru;
            if (!subs || subs.length === 0) return ctx.reply(L.no_subs);
            await ctx.reply(L.remove_subs, Markup.inlineKeyboard(buildGroupSubsKeyboard(subs, L)));
        } catch (e) {
            console.error('[tgbot] removesubs', e);
            ctx.reply(T.ru.error(e.message)).catch(() => { });
        }
    });

    bot.action(/^tg_silent_(\d+)$/, async (ctx) => {
        try {
            if (!isAdmin(ctx)) return ctx.answerCbQuery();
            const id = parseInt(ctx.match[1], 10);
            const chatId = ctx.callbackQuery?.message?.chat?.id;
            if (!chatId) return ctx.answerCbQuery();
            const subs = db.getTgSubsByChatId(chatId);
            const sub = subs.find(s => s.id === id);
            if (!sub) {
                await ctx.answerCbQuery();
                return;
            }
            const lang = db.getTgChatLang(chatId) || 'ru';
            const L = T[lang] || T.ru;
            const next = db.toggleTgSubscriptionSilent(id, { chatId });
            if (next === null) {
                await ctx.answerCbQuery();
                return;
            }
            const entity = subscriptionEntityLabel(sub);
            await ctx.answerCbQuery(next ? L.silent_enabled(entity) : L.silent_disabled(entity));
            const updated = db.getTgSubsByChatId(chatId);
            if (updated.length > 0) {
                await ctx.editMessageReplyMarkup(Markup.inlineKeyboard(buildGroupSubsKeyboard(updated, L)).reply_markup).catch(() => { });
            }
        } catch (e) {
            ctx.answerCbQuery().catch(() => { });
        }
    });

    bot.action(/^tg_rm_(\d+)$/, async (ctx) => {
        try {
            const id = parseInt(ctx.match[1], 10);
            const chatId = ctx.callbackQuery?.message?.chat?.id;
            if (!chatId) return ctx.answerCbQuery();
            const subs = db.getTgSubsByChatId(chatId);
            const sub = subs.find(s => s.id === id);
            if (sub) {
                db.removeTgGroupSub(chatId, sub.entity_type, sub.entity_key);
            }
            await ctx.answerCbQuery();
            await ctx.reply(T.ru.sub_removed);
        } catch (e) {
            ctx.answerCbQuery().catch(() => { });
        }
    });

    bot.action('tg_rm_all', async (ctx) => {
        try {
            const chatId = ctx.callbackQuery?.message?.chat?.id;
            if (!chatId) return ctx.answerCbQuery();
            db.removeTgGroupSubAll(chatId);
            const lang = db.getTgChatLang(chatId) || 'ru';
            const L = T[lang] || T.ru;
            await ctx.answerCbQuery();
            await ctx.reply(L.all_removed);
        } catch (e) {
            ctx.answerCbQuery().catch(() => { });
        }
    });

    bot.on('text', async (ctx, next) => {
        try {
            if (ctx.chat.type === 'private') return next();
            const text = (ctx.message && ctx.message.text || '').trim();
            if (/^\/settime(?:@\w+)?/i.test(text)) return next();

            const session = ensureSession(ctx);

            if (session.pendingGroupSetTime) {
                if (!isAdmin(ctx)) {
                    delete session.pendingGroupSetTime;
                    return next();
                }
                await applyChatSendTime(ctx, text);
                return;
            }

            const pending = session.pendingGroupEntityType;
            if (!pending) return next();
            const entityKey = text;
            if (!entityKey) return next();
            const chatId = ctx.chat.id;
            const lang = db.getTgChatLang(chatId) || 'ru';
            const L = T[lang] || T.ru;
            const entity = `${pending} ${entityKey}`;
            session.pendingNotifyEntityType = pending;
            session.pendingNotifyEntityKey = entityKey;
            session.pendingNotifyChatId = chatId;
            delete session.pendingGroupEntityType;
            delete session.pendingGroupChatId;
            await ctx.reply(L.choose_notify_prompt(entity), Markup.inlineKeyboard([
                [Markup.button.callback(L.notify_silent_btn, 'tg_notify_silent'), Markup.button.callback(L.notify_loud_btn, 'tg_notify_loud')]
            ]));
        } catch (e) {
            next();
        }
    });
}

module.exports = { registerGroupHandlers };
