'use strict';

const { T, detectLangFromQuery, entityTypeLabel } = require('../strings');

const SCOPES = ['today', 'week', 'tomorrow'];

function article(id, title, messageText, description, url) {
    const r = { type: 'article', id, title, input_message_content: { message_text: messageText } };
    if (description) r.description = description;
    if (url) r.url = url;
    return r;
}

async function buildInlineResults(query, botUsername, getLists, lang, db) {
    const L = T[lang] || T.ru;
    const results = [];
    const q = (query || '').trim().toLowerCase();

    if (!q) {
        results.push(article('hint_ru', L.hint_first, L.hint_first, 'Русский'));
        results.push(article('hint_en', T.en.hint_first, T.en.hint_first, 'English'));
        return results;
    }

    const parts = q.split(/\s+/);
    const first = parts[0];
    let entityType = null;
    if (/группа|group/.test(first)) entityType = 'group';
    else if (/преподаватель|teacher|tch/.test(first)) entityType = 'teacher';
    else if (/аудитория|auditory|aud/.test(first)) entityType = 'auditory';

    if (entityType) {
        const list = await getLists(entityType);
        const filter = parts.length > 1 ? parts.slice(1).join(' ').toLowerCase() : '';
        const filtered = (list || []).filter(item => !filter || String(item).toLowerCase().includes(filter)).slice(0, 20);
        const label = entityTypeLabel(entityType, lang);
        for (const entityKey of filtered) {
            for (const scope of SCOPES) {
                const scopeLabel = scope === 'today' ? L.today : scope === 'week' ? L.week : L.tomorrow;
                const legend = scope === 'today' ? L.legend_today(label, entityKey) : scope === 'week' ? L.legend_week(label, entityKey) : L.legend_tomorrow(label, entityKey);
                const code = db.getOrCreateTgInlineLutId(entityType, entityKey, scope, lang);
                const startParam = code ? `inline_${code}` : null;
                if (!startParam) continue;
                const url = `https://t.me/${botUsername}?start=${encodeURIComponent(startParam)}`;
                const id = `i_${entityType}_${scope}_${results.length}_${entityKey.slice(0, 10)}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
                results.push(article(id, `${label} ${entityKey} — ${scopeLabel}`, legend, legend.slice(0, 100), url));
                if (results.length >= 50) break;
            }
            if (results.length >= 50) break;
        }
    }

    return results;
}

async function registerInlineHandler(bot, { getLists, botUsername, db }) {
    bot.on('inline_query', async (ctx) => {
        try {
            const query = ctx.inlineQuery.query;
            const lang = detectLangFromQuery(query);
            const listGetter = (type) => getLists(type);
            const results = await buildInlineResults(query, botUsername, listGetter, lang, db);
            await ctx.answerInlineQuery(results.slice(0, 50), { cache_time: 10 });
        } catch (e) {
            console.error('[tgbot] inline_query', e);
            try {
                await ctx.answerInlineQuery([], { cache_time: 1 });
            } catch (_) {}
        }
    });
}

module.exports = { registerInlineHandler, buildInlineResults };
