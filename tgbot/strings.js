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
        choose_notify_prompt: (entity) => `Подписка на ${entity}. Как доставлять ежедневную рассылку в 07:00 МСК?`,
        notify_silent_btn: 'Без звука',
        notify_loud_btn: 'Со звуком',
        sub_added: (entity, silent) => silent
            ? `Подписка на ${entity} добавлена. Рассылка без звука в 07:00 МСК. Время можно изменить в меню.`
            : `Подписка на ${entity} добавлена. Рассылка со звуком в 07:00 МСК. Время можно изменить в меню.`,
        sub_removed: 'Подписка удалена.',
        all_removed: 'Все подписки удалены.',
        remove_all_subs_btn: 'Удалить все подписки',
        no_subs: 'Нет подписок.',
        change_lang: 'Сменить язык',
        set_time_prompt: 'Отправьте время в формате ЧЧ:ММ (например 07:00), по МСК.',
        time_updated: (t) => `Время рассылки обновлено: ${t} МСК.`,
        error: (msg) => `Ошибка: ${msg}`,
        no_lessons: 'Нет пар',
        link_expired: 'Ссылка устарела или не найдена. Выберите расписание снова в поиске.',
        choose_lang: 'Выберите язык:',
        lang_ru: 'Русский',
        lang_en: 'English',
        make_silent_btn: (entity) => `Сделать рассылку ${entity} безшумной`,
        make_loud_btn: (entity) => `Сделать рассылку ${entity} со звуком`,
        silent_enabled: (entity) => `Рассылка без звука: ${entity}`,
        silent_disabled: (entity) => `Рассылка со звуком: ${entity}`,
        remove_sub_btn: (entity) => `Удалить подписку ${entity}`
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
        choose_notify_prompt: (entity) => `Subscription to ${entity}. How should daily delivery at 07:00 MSK notify you?`,
        notify_silent_btn: 'Silent',
        notify_loud_btn: 'With sound',
        sub_added: (entity, silent) => silent
            ? `Subscribed to ${entity}. Silent delivery at 07:00 MSK. Change time in the menu.`
            : `Subscribed to ${entity}. Delivery with sound at 07:00 MSK. Change time in the menu.`,
        sub_removed: 'Subscription removed.',
        all_removed: 'All subscriptions removed.',
        remove_all_subs_btn: 'Remove all subscriptions',
        no_subs: 'No subscriptions.',
        change_lang: 'Change language',
        set_time_prompt: 'Send time as HH:MM (e.g. 07:00), MSK.',
        time_updated: (t) => `Delivery time updated: ${t} MSK.`,
        error: (msg) => `Error: ${msg}`,
        no_lessons: 'No lessons',
        link_expired: 'Link expired or not found. Try choosing the schedule again from search.',
        choose_lang: 'Choose language:',
        lang_ru: 'Russian',
        lang_en: 'English',
        make_silent_btn: (entity) => `Make ${entity} delivery silent`,
        make_loud_btn: (entity) => `Make ${entity} delivery with sound`,
        silent_enabled: (entity) => `Silent delivery: ${entity}`,
        silent_disabled: (entity) => `Delivery with sound: ${entity}`,
        remove_sub_btn: (entity) => `Remove subscription ${entity}`
    }
};

/** Inline: detect language from query (русские слова → ru, English → en). */
function detectLangFromQuery(query) {
    if (!query || typeof query !== 'string') return 'ru';
    const q = query.trim().toLowerCase();
    if (/\b(группа|група|грп|г|преподаватель|препадователь|препадаватель|припод|препод|п|прпд|учитель|училка|преп|аудитория|кабинет|каб|ауд|место|сегодня|неделю|завтра)\b/.test(q)) return 'ru';
    if (/\b(group|teacher|tch|auditory|aud|today|week|tomorrow)\b/.test(q)) return 'en';
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
