'use strict';

/** Шаблоны сообщений для двух языков (ru, en). */
const T = {
    ru: {
        hint_first: 'Введите: группа, преподаватель или аудитория',
        group: 'Группа',
        teacher: 'Преподаватель',
        auditory: 'Аудитория',
        today: 'На сегодня',
        week: 'На неделю',
        tomorrow: 'На завтра',
        legend_today: (entityType, entityKey) => `Будет показано расписание на сегодня: ${entityType} ${entityKey}`,
        legend_week: (entityType, entityKey) => `Будет показано расписание на неделю: ${entityType} ${entityKey}`,
        legend_tomorrow: (entityType, entityKey) => `Будет показано расписание на завтра: ${entityType} ${entityKey}`,
        welcome_private: 'Привет! Выберите язык / Choose language:',
        welcome_group: 'Бот для расписания. Сделано Ximerixx. Выберите язык:',
        add_group: 'Добавить группу',
        add_teacher: 'Добавить преподавателя',
        add_auditory: 'Добавить аудиторию',
        my_subs: 'Мои подписки',
        set_time: 'Время рассылки',
        remove_subs: 'Удалить подписки',
        choose_entity_type: 'Выберите тип:',
        enter_entity: (type) => `Введите или выберите ${type}:`,
        sub_added: (entity) => `Подписка на ${entity} добавлена. Рассылка по умолчанию в 07:00 МСК.`,
        sub_removed: 'Подписка удалена.',
        all_removed: 'Все подписки удалены.',
        no_subs: 'Нет подписок.',
        set_time_prompt: 'Отправьте время в формате ЧЧ:ММ (например 07:00), по МСК.',
        time_updated: (t) => `Время рассылки обновлено: ${t} МСК.`,
        error: (msg) => `Ошибка: ${msg}`,
        no_lessons: 'Нет пар',
        link_expired: 'Ссылка устарела или не найдена. Выберите расписание снова в поиске.',
        choose_lang: 'Выберите язык:',
        lang_ru: 'Русский',
        lang_en: 'English'
    },
    en: {
        hint_first: 'Enter: group, teacher or auditory',
        group: 'Group',
        teacher: 'Teacher',
        auditory: 'Auditory',
        today: 'Today',
        week: 'Week',
        tomorrow: 'Tomorrow',
        legend_today: (entityType, entityKey) => `Will show today's schedule: ${entityType} ${entityKey}`,
        legend_week: (entityType, entityKey) => `Will show week schedule: ${entityType} ${entityKey}`,
        legend_tomorrow: (entityType, entityKey) => `Will show tomorrow's schedule: ${entityType} ${entityKey}`,
        welcome_private: 'Hi! Choose language:',
        welcome_group: 'VGLTU Schedule bot. Made by Ximerixx. Choose language:',
        add_group: 'Add group',
        add_teacher: 'Add teacher',
        add_auditory: 'Add auditory',
        my_subs: 'My subscriptions',
        set_time: 'Delivery time',
        remove_subs: 'Remove subscriptions',
        choose_entity_type: 'Choose type:',
        enter_entity: (type) => `Enter or select ${type}:`,
        sub_added: (entity) => `Subscribed to ${entity}. Delivery by default at 07:00 MSK.`,
        sub_removed: 'Subscription removed.',
        all_removed: 'All subscriptions removed.',
        no_subs: 'No subscriptions.',
        set_time_prompt: 'Send time as HH:MM (e.g. 07:00), MSK.',
        time_updated: (t) => `Delivery time updated: ${t} MSK.`,
        error: (msg) => `Error: ${msg}`,
        no_lessons: 'No lessons',
        link_expired: 'Link expired or not found. Try choosing the schedule again from search.',
        choose_lang: 'Choose language:',
        lang_ru: 'Russian',
        lang_en: 'English'
    }
};

/** Inline: detect language from query (русские слова → ru, English → en). */
function detectLangFromQuery(query) {
    if (!query || typeof query !== 'string') return 'ru';
    const q = query.trim().toLowerCase();
    if (/группа|преподаватель|аудитория|сегодня|неделю|завтра/.test(q)) return 'ru';
    if (/group|teacher|auditory|today|week|tomorrow/.test(q)) return 'en';
    return 'ru';
}

/** Entity type label for display (by lang). */
function entityTypeLabel(entityType, lang) {
    const L = T[lang] || T.ru;
    if (entityType === 'group') return L.group;
    if (entityType === 'teacher') return L.teacher;
    if (entityType === 'auditory') return L.auditory;
    return entityType;
}

module.exports = { T, detectLangFromQuery, entityTypeLabel };
