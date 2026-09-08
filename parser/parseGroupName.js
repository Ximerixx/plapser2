'use strict';

const GROUP_NAME_REGEX = /^([А-ЯЁ]{2,3}\d)-(\d{2})(\d)-([А-ЯЁ]{2,4})/iu;

function parseGroupName(rawName) {
    const raw = String(rawName ?? '').trim();
    if (!raw) return null;
    const m = raw.match(GROUP_NAME_REGEX);
    if (!m) return null;
    const yy = Number(m[2]);
    return {
        rawName: raw,
        specialty: m[1],
        admissionYear: 2000 + yy,
        groupIndex: Number(m[3]),
        form: m[4].toUpperCase()
    };
}

/** Учебный год для даты: сентябрь–август, label «2025-2026». */
function academicYearLabel(dateStr) {
    const s = String(dateStr ?? '').trim();
    const m = s.match(/^(\d{4})-(\d{2})-\d{2}$/);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (!year || month < 1 || month > 12) return null;
    const start = month >= 9 ? year : year - 1;
    return `${start}-${start + 1}`;
}

/** Нормализация ФИО преподавателя для дедупликации (единая точка после инициалов). */
function normalizeTeacherName(name) {
    let s = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!s) return '';
    s = s.replace(/\.+$/u, '');
    if (/[А-ЯЁ]\.[А-ЯЁ]$/u.test(s)) s += '.';
    return s;
}

module.exports = {
    GROUP_NAME_REGEX,
    parseGroupName,
    academicYearLabel,
    normalizeTeacherName
};
