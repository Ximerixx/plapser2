'use strict';

/** Общая нормализация названий аудиторий для парсеров, API и БД. */

function cleanAuditoryName(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Единый вид для ссылок: без пробелов вокруг «/», корпус в верхнем регистре. */
function formatAuditoryName(value) {
    const s = cleanAuditoryName(value);
    if (!s) return '';
    const slashIdx = s.indexOf('/');
    if (slashIdx < 0) return s;
    const left = s.slice(0, slashIdx).replace(/\s+$/g, '');
    const right = s.slice(slashIdx + 1).trim().toUpperCase();
    return right ? `${left}/${right}` : left;
}

function normalizeRoomType(rawType) {
    if (!rawType) return null;
    const t = String(rawType).toLowerCase().trim();
    if (!t) return null;
    if (t.includes('комп') || t.includes('информ')) return 'комп';
    if (t.includes('лаб')) return 'лаб';
    if (t.includes('пр')) return 'пр';
    if (t === 'л' || t.includes('лек')) return 'лек';
    if (t.includes('дис')) return 'дис';
    if (t.includes('мастер')) return 'мастер';
    return t;
}

function parseAuditoryParts(rawName) {
    const raw = formatAuditoryName(rawName);
    if (!raw) {
        return { rawName: '', roomNumber: null, roomType: null, building: null, normalizedKey: '' };
    }
    const slashIdx = raw.indexOf('/');
    let left = slashIdx >= 0 ? raw.slice(0, slashIdx).trim() : raw;
    const right = slashIdx >= 0 ? raw.slice(slashIdx + 1).trim() : '';

    // Корпусной префикс перед номером (не часть номера кабинета).
    left = left.replace(/^[АБВГД]\s*/iu, '').trim();
    const hasAngl = /англ/iu.test(left);

    // Номер: цифры + опциональная буква подкабинета сразу после (305а ≠ 305б ≠ 305).
    const digitMatch = left.match(/\d+/u);
    let roomNumber = null;
    let rest = left;
    if (digitMatch) {
        const idx = digitMatch.index;
        const digits = digitMatch[0];
        let consumed = digits.length;
        const suffixMatch = left.slice(idx + consumed).match(/^([абвгд])/iu);
        if (suffixMatch) consumed += 1;
        roomNumber = digits + (suffixMatch ? suffixMatch[1].toLowerCase() : '');
        rest = (left.slice(0, idx) + ' ' + left.slice(idx + consumed)).trim();
    }

    let roomType = normalizeRoomType(rest);
    if (!roomType && hasAngl) roomType = 'англ';

    const building = right ? right.toUpperCase() : null;
    const normalizedKey = `${roomNumber || ''}|${roomType || ''}|${building || ''}`;
    return { rawName: raw, roomNumber: roomNumber || null, roomType, building, normalizedKey };
}

module.exports = {
    cleanAuditoryName,
    formatAuditoryName,
    normalizeRoomType,
    parseAuditoryParts
};
