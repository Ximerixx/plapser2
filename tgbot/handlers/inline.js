'use strict';

const { T, detectLangFromQuery, entityTypeLabel } = require('../strings');

const SCOPES = ['today', 'week', 'tomorrow'];
const TELEGRAM_MESSAGE_MAX_LENGTH = 4096;
/** First N inline results get full schedule as message_text (sent to chat when user selects); rest keep legend + url. */
const MAX_RESULTS_WITH_SCHEDULE = 15;

const TAGS_TO_TRACK = new Set(['b', 'i', 'blockquote']);

function truncateHtmlPreservingTags(html, maxLen) {
    const s = String(html ?? '');
    if (s.length <= maxLen) return s;

    // Резервируем место на суффикс и закрывающие теги.
    // В нашем форматировании это обычно 1-3 тега, но делаем запас на всякий случай.
    const suffix = '...';
    const reserve = suffix.length + 100;
    const maxBodyLen = Math.max(0, maxLen - reserve);

    let out = '';
    const stack = [];

    const len = s.length;
    let pos = 0;
    while (pos < len && out.length < maxBodyLen) {
        const nextTagStart = s.indexOf('<', pos);
        if (nextTagStart === -1) {
            const remaining = s.slice(pos);
            const canTake = maxBodyLen - out.length;
            out += remaining.slice(0, canTake);
            break;
        }

        // Текст до следующего тега
        if (nextTagStart > pos) {
            const textToken = s.slice(pos, nextTagStart);
            const canTake = maxBodyLen - out.length;
            if (textToken.length <= canTake) {
                out += textToken;
            } else {
                out += textToken.slice(0, canTake);
                break;
            }
        }

        // Сам тег
        const tagEnd = s.indexOf('>', nextTagStart);
        if (tagEnd === -1) break; // странный HTML, просто обрежем по лимиту текста

        const tagToken = s.slice(nextTagStart, tagEnd + 1);
        const canTakeTag = maxBodyLen - out.length;
        if (tagToken.length > canTakeTag) break; // не добавляем неполный тег

        out += tagToken;

        // Обновляем стек только для "наших" тегов (Telegram HTML subset)
        const m = tagToken.match(/^<\/?\s*([a-zA-Z0-9]+)(\s[^>]*)?>$/);
        if (m) {
            const tagName = m[1].toLowerCase();
            const isClosing = /^<\//.test(tagToken);
            if (TAGS_TO_TRACK.has(tagName)) {
                if (isClosing) {
                    if (stack.length && stack[stack.length - 1] === tagName) stack.pop();
                } else {
                    stack.push(tagName);
                }
            }
        }

        pos = tagEnd + 1;
    }

    // Дописываем суффикс и закрывающие теги, чтобы Telegram не ругался на незакрытые блоки.
    const closing = stack.reverse().map(t => `</${t}>`).join('');
    let final = out + suffix + closing;
    if (final.length > maxLen) {
        // На случай редких ситуаций (слишком много закрывающих тегов) — подрежем суффиксом.
        final = final.slice(0, Math.max(0, maxLen - suffix.length)) + suffix;
    }
    return final;
}

function article(id, title, messageText, description, url) {
    const r = {
        type: 'article',
        id,
        title,
        input_message_content: { message_text: messageText, parse_mode: 'HTML' }
    };
    if (description) r.description = description;
    if (url) r.url = url;
    return r;
}

async function buildInlineResults(query, botUsername, getLists, lang, db, getScheduleText, deps, buildUserAgent, ctx) {
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
    if (/^(группа|група|грп|г|group)$/.test(first)) entityType = 'group';
    else if (/^(преподаватель|препадователь|препадаватель|припод|препод|п|прпд|учитель|училка|преп|teacher|tch)$/.test(first)) entityType = 'teacher';
    else if (/^(аудитория|кабинет|каб|ауд|место|auditory|aud)$/.test(first)) entityType = 'auditory';

    if (!entityType) return results;

    const list = await getLists(entityType);
    const filter = parts.length > 1 ? parts.slice(1).join(' ').toLowerCase() : '';
    const filtered = (list || []).filter(item => !filter || String(item).toLowerCase().includes(filter)).slice(0, 20);
    const label = entityTypeLabel(entityType, lang);

    const descriptors = [];
    for (const entityKey of filtered) {
        for (const scope of SCOPES) {
            const scopeLabel = scope === 'today' ? L.today : scope === 'week' ? L.week : L.tomorrow;
            const legend = scope === 'today' ? L.legend_today(label, entityKey) : scope === 'week' ? L.legend_week(label, entityKey) : L.legend_tomorrow(label, entityKey);
            const code = db.getOrCreateTgInlineLutId(entityType, entityKey, scope, lang);
            const startParam = code ? `inline_${code}` : null;
            if (!startParam) continue;
            const url = `https://t.me/${botUsername}?start=${encodeURIComponent(startParam)}`;
            const id = `i_${entityType}_${scope}_${descriptors.length}_${entityKey.slice(0, 10)}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
            descriptors.push({ id, title: `${label} ${entityKey} — ${scopeLabel}`, legend, url, entityType, entityKey, scope, lang });
            if (descriptors.length >= 50) break;
        }
        if (descriptors.length >= 50) break;
    }

    const toFetch = descriptors.slice(0, MAX_RESULTS_WITH_SCHEDULE);
    const optsBase = {
        ip: 'telegram',
        startTime: Date.now(),
        type: 'json'
    };
    const scheduleTexts = await Promise.all(
        toFetch.map(d => {
            const opts = {
                ...optsBase,
                userAgent: buildUserAgent('inline', ctx?.from?.id, ctx?.chat?.id, d.entityType, d.entityKey, d.scope)
            };
            return getScheduleText({ entityType: d.entityType, entityKey: d.entityKey, scope: d.scope, lang: d.lang }, d.lang, deps, opts)
                .then(t => (t && t.length > TELEGRAM_MESSAGE_MAX_LENGTH ? truncateHtmlPreservingTags(t, TELEGRAM_MESSAGE_MAX_LENGTH) : t))
                .catch(() => null);
        })
    );

    for (let i = 0; i < descriptors.length; i++) {
        const d = descriptors[i];
        const messageText = i < scheduleTexts.length && scheduleTexts[i] ? scheduleTexts[i] : d.legend;
        results.push(article(d.id, d.title, messageText, d.legend.slice(0, 100), d.url));
    }

    return results;
}

async function registerInlineHandler(bot, { getLists, botUsername, db, getScheduleText, deps, buildUserAgent }) {
    bot.on('inline_query', async (ctx) => {
        try {
            const query = ctx.inlineQuery.query;
            const lang = detectLangFromQuery(query);
            const listGetter = (type) => getLists(type);
            const results = await buildInlineResults(query, botUsername, listGetter, lang, db, getScheduleText, deps, buildUserAgent, ctx);
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
