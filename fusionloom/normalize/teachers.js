'use strict';

/**
 * Канонический вид для API/БД: «Павлов А.Ю.»
 * — пробел после фамилии, инициалы слитно с точками, точка в конце.
 */
function formatTeacherDisplayName(name) {
    let s = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!s) return '';

    const hyphenSurname = /^([А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?)\s+(.+)$/u;
    const m = s.match(hyphenSurname);
    if (!m) return s;

    const surname = m[1];
    const rest = m[2].replace(/\./g, '').replace(/\s+/g, '');
    const initials = [...rest].filter((ch) => /[А-ЯЁ]/u.test(ch));
    if (initials.length < 2) {
        if (initials.length === 1) return `${surname} ${initials[0]}.`;
        return s;
    }
    return `${surname} ${initials[0]}.${initials[1]}.`;
}

/** Для дедупликации: без пробелов/точек, верхний регистр. */
function teacherCanonicalKey(name) {
    const display = formatTeacherDisplayName(name);
    return display.replace(/[\s.]/g, '').toUpperCase();
}

function normalizeTeacherName(name) {
    return formatTeacherDisplayName(name);
}

module.exports = {
    formatTeacherDisplayName,
    normalizeTeacherName,
    teacherCanonicalKey
};
