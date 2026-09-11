'use strict';

/** KIS raw → человекочитаемый вывод. */
const SPECIAL_VENUE_DISPLAY = {
    'сз/гл': 'Спортзал'
};

function cleanAuditoryName(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Без пробелов вокруг «/», регистр как в источнике. */
function cleanAuditoryLayout(value) {
    const s = cleanAuditoryName(value);
    if (!s) return '';
    const slashIdx = s.indexOf('/');
    if (slashIdx < 0) return s;
    const left = s.slice(0, slashIdx).replace(/\s+$/g, '');
    const right = s.slice(slashIdx + 1).trim();
    return right ? `${left}/${right}` : left;
}

/** Имя для запросов к KIS — регистр важен (напр. 116Л/7к, не 116Л/7К). */
function formatAuditoryName(value) {
    return cleanAuditoryLayout(value);
}

/** Канонический вид для кэша, ключей БД и отображения (корпус в верхнем регистре). */
function formatAuditoryCanonical(value) {
    const s = cleanAuditoryLayout(value);
    if (!s) return '';
    const slashIdx = s.indexOf('/');
    if (slashIdx < 0) return s;
    const left = s.slice(0, slashIdx);
    const right = s.slice(slashIdx + 1).trim().toUpperCase();
    return right ? `${left}/${right}` : left;
}

/**
 * KIS на сервере регистрочувствителен: в списке «7к», а не «7К».
 * Если точный alias неизвестен — приводим букву после цифр в корпусе к нижнему регистру.
 */
function kisAuditoryQueryName(value) {
    const s = cleanAuditoryLayout(value);
    if (!s) return '';
    const slashIdx = s.indexOf('/');
    if (slashIdx < 0) return s;
    const left = s.slice(0, slashIdx);
    const right = s.slice(slashIdx + 1).trim();
    const kisRight = right.replace(/^(\d+)([А-ЯЁ])(.*)$/u, (_, digits, letter, rest) => digits + letter.toLowerCase() + rest);
    return kisRight ? `${left}/${kisRight}` : left;
}

function formatAuditoryDisplayName(value) {
    const raw = formatAuditoryCanonical(value);
    if (!raw) return '';
    const special = SPECIAL_VENUE_DISPLAY[raw.toLowerCase()];
    if (special) return special;
    const parts = parseAuditoryParts(raw);
    return parts.displayName || raw;
}

/**
 * Тип помещения. Важно: «преп» проверяется ДО «пр» —
 * иначе «307Преп» ошибочно становится практическим («пр»).
 */
function normalizeRoomType(rawType) {
    if (!rawType) return null;
    const t = String(rawType).toLowerCase().trim();
    if (!t) return null;
    if (t.includes('преп') || t.includes('препод')) return 'преп';
    if (t.includes('комп') || t.includes('информ')) return 'комп';
    if (t.includes('лаб')) return 'лаб';
    if (t === 'пр' || t.startsWith('пр ') || /^пр[^еа-яё]/u.test(t)) return 'пр';
    if (t === 'л' || t.includes('лек')) return 'лек';
    if (t.includes('дис')) return 'дис';
    if (t.includes('мастер')) return 'мастер';
    if (t.includes('англ')) return 'англ';
    if (t.includes('матем')) return 'матем';
    return t;
}

function parseBuildingPart(right) {
    if (!right) return { building: null, roomType: null };
    const tokens = String(right).trim().toUpperCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return { building: null, roomType: null };
    const building = tokens[0];
    const typeHint = tokens.length > 1 ? tokens.slice(1).join(' ') : null;
    return {
        building,
        roomType: typeHint ? normalizeRoomType(typeHint) : null
    };
}

function parseAuditoryParts(rawName) {
    const raw = formatAuditoryCanonical(rawName);
    if (!raw) {
        return { rawName: '', roomNumber: null, roomType: null, building: null, normalizedKey: '', displayName: '' };
    }
    const slashIdx = raw.indexOf('/');
    let left = slashIdx >= 0 ? raw.slice(0, slashIdx).trim() : raw;
    const right = slashIdx >= 0 ? raw.slice(slashIdx + 1).trim() : '';

    const campusPrefix = left.match(/^([АБВГД])\s*/iu);
    const campusLetter = campusPrefix ? campusPrefix[1].toUpperCase() : null;
    left = left.replace(/^[АБВГД]\s*/iu, '').trim();
    const hasAngl = /англ/iu.test(left);

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
    const { building, roomType: buildingRoomType } = parseBuildingPart(right);
    if (!roomType && buildingRoomType) roomType = buildingRoomType;
    if (!roomType && hasAngl) roomType = 'англ';

    const normalizedKey = `${roomNumber || ''}|${roomType || ''}|${building || ''}`;
    const special = SPECIAL_VENUE_DISPLAY[raw.toLowerCase()];
    let displayName = special || (campusLetter ? `${campusLetter} ${raw}` : raw);
    return {
        rawName: raw,
        roomNumber: roomNumber || null,
        roomType,
        building,
        campusPrefix: campusLetter,
        normalizedKey,
        displayName
    };
}

module.exports = {
    cleanAuditoryName,
    cleanAuditoryLayout,
    formatAuditoryName,
    formatAuditoryCanonical,
    kisAuditoryQueryName,
    formatAuditoryDisplayName,
    normalizeRoomType,
    parseBuildingPart,
    parseAuditoryParts,
    SPECIAL_VENUE_DISPLAY
};
