'use strict';

/** Нормализует префикс типа занятия в названии предмета: Лаб./лаб./Лаб/лаб → "лаб." и т.д. */
function normalizeSubjectPrefix(str) {
    if (str == null || typeof str !== 'string') return str;
    const s = str.trim();
    const m = s.match(/^(лаб|лек|пр)\.?\s*/i);
    if (!m) return str;
    const norm = m[1].toLowerCase() + '.';
    const rest = s.slice(m[0].length).trim();
    return rest ? norm + ' ' + rest : norm;
}

module.exports = { normalizeSubjectPrefix };
