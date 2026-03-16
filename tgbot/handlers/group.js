'use strict';

const { Markup } = require('telegraf');

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
            ctx.reply(T.ru.error(e.message)).catch(() => {});
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
            ctx.session = ctx.session || {};
            ctx.session.pendingGroupEntityType = entityType;
            ctx.session.pendingGroupChatId = chatId;
        } catch (e) {
            console.error('[tgbot] group type action', e);
            ctx.answerCbQuery().catch(() => {});
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
            const keyboard = subs.map(s => [Markup.button.callback(`${s.entity_type} ${s.entity_key}`, `tg_rm_${s.id}`)]);
            keyboard.push([Markup.button.callback(L.all_removed, 'tg_rm_all')]);
            await ctx.reply(L.remove_subs, Markup.inlineKeyboard(keyboard));
        } catch (e) {
            console.error('[tgbot] removesubs', e);
            ctx.reply(T.ru.error(e.message)).catch(() => {});
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
            ctx.answerCbQuery().catch(() => {});
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
            ctx.answerCbQuery().catch(() => {});
        }
    });

    bot.on('text', async (ctx, next) => {
        try {
            if (ctx.chat.type === 'private') return next();
            const session = ctx.session || {};
            const pending = session.pendingGroupEntityType;
            if (!pending) return next();
            const entityKey = (ctx.message && ctx.message.text || '').trim();
            if (!entityKey) return next();
            const chatId = ctx.chat.id;
            db.addTgGroupSub(chatId, pending, entityKey, '07:00');
            delete session.pendingGroupEntityType;
            delete session.pendingGroupChatId;
            const lang = db.getTgChatLang(chatId) || 'ru';
            const L = T[lang] || T.ru;
            await ctx.reply(L.sub_added(`${pending} ${entityKey}`));
        } catch (e) {
            next();
        }
    });
}

module.exports = { registerGroupHandlers };
