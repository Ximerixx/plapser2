#!/usr/bin/env node
'use strict';

const path = require('path');

process.env.FUSIONLOOM_DB_PATH = process.env.FUSIONLOOM_DB_PATH
    || path.join(__dirname, '../fusionloom/data/migrate-test.db');

const { parseStudent } = require('../parser/parseStudent');
const { parseTeacher } = require('../parser/parseTeacher');
const { parseAuditory } = require('../parser/parseAuditory');
const loomRead = require('../fusionloom/read');

const BASE_DATE = process.argv[2] || '2026-09-08';

const SAMPLES = {
    groups: ['ЛХ1-263-ОТ', 'ИС4-261-ОМ', 'ТУА2-262-ОБ', 'МО2-241-ОБ', 'ЮР1-251-ОТ'],
    teachers: ['Иванникова М.В.', 'Баева Ю.А.', 'Ходырев А.В.', 'Новиков А.П.', 'Гнусов М.А.'],
    auditoriums: ['1412/11К ФИЗ', '120Пр/7К', '308Л/ГЛ', '214Лаб/ГЛ', '1аДис']
};

function lessonKey(l) {
    if (!l || l.status === 'Нет пар') return 'no_lessons';
    return [
        l.time,
        l.type || '',
        l.name || l.subject || '',
        l.subgroup || '',
        l.teacher || '',
        l.auditory || l.room || '',
        Array.isArray(l.groups) ? l.groups.join(',') : (l.group || '')
    ].join('|');
}

function summarizeDay(day) {
    if (!day?.lessons) return { kind: 'empty' };
    if (day.lessons.length === 1 && day.lessons[0].status === 'Нет пар') return { kind: 'no_lessons' };
    const lessons = day.lessons.filter((l) => l.time && l.time.includes('-'));
    return { kind: 'lessons', count: lessons.length, keys: lessons.map(lessonKey).sort() };
}

function compareWeek(kis, loom) {
    const dates = [...new Set([...Object.keys(kis || {}), ...Object.keys(loom || {})])].sort();
    const diffs = [];
    for (const date of dates) {
        const a = summarizeDay(kis?.[date]);
        const b = summarizeDay(loom?.[date]);
        if (JSON.stringify(a) === JSON.stringify(b)) continue;
        const onlyKis = a.keys?.filter((k) => !b.keys?.includes(k)) || [];
        const onlyLoom = b.keys?.filter((k) => !a.keys?.includes(k)) || [];
        diffs.push({
            date,
            kis: a,
            loom: b,
            onlyKis: onlyKis.slice(0, 5),
            onlyLoom: onlyLoom.slice(0, 5)
        });
    }
    return { match: diffs.length === 0, diffs };
}

function weekLessonCount(data) {
    let n = 0;
    for (const day of Object.values(data || {})) {
        if (!day?.lessons) continue;
        n += day.lessons.filter((l) => l.time && l.time.includes('-')).length;
    }
    return n;
}

async function compareEntity(type, key, fetchKis, fetchLoom) {
    const kis = await fetchKis();
    const loom = fetchLoom();
    const cmp = compareWeek(kis, loom);
    return {
        type,
        key,
        baseDate: BASE_DATE,
        kisLessons: weekLessonCount(kis),
        loomLessons: weekLessonCount(loom),
        ...cmp
    };
}

async function main() {
    const results = [];
    for (const group of SAMPLES.groups) {
        results.push(await compareEntity(
            'group',
            group,
            () => parseStudent(BASE_DATE, group),
            () => loomRead.getStudentScheduleWeek(group, BASE_DATE)
        ));
    }
    for (const teacher of SAMPLES.teachers) {
        results.push(await compareEntity(
            'teacher',
            teacher,
            () => parseTeacher(BASE_DATE, teacher),
            () => loomRead.getTeacherScheduleWeek(teacher, BASE_DATE)
        ));
    }
    for (const auditory of SAMPLES.auditoriums) {
        results.push(await compareEntity(
            'auditory',
            auditory,
            () => parseAuditory(BASE_DATE, auditory),
            () => loomRead.getAuditoryScheduleWeek(auditory, BASE_DATE)
        ));
    }

    const matched = results.filter((r) => r.match).length;
    console.log(`Сравнение KIS HTML (live parse) vs fusionloom DB, неделя с ${BASE_DATE}`);
    console.log(`Совпало: ${matched}/${results.length}\n`);
    for (const r of results) {
        const status = r.match ? 'OK' : 'DIFF';
        console.log(`[${status}] ${r.type} ${r.key}`);
        console.log(`  занятий: KIS=${r.kisLessons}, loom=${r.loomLessons}`);
        if (!r.match) {
            for (const d of r.diffs) {
                console.log(`  ${d.date}: KIS ${d.kis.count ?? d.kis.kind} vs loom ${d.loom.count ?? d.loom.kind}`);
                if (d.onlyKis.length) console.log(`    только KIS: ${d.onlyKis.join(' || ')}`);
                if (d.onlyLoom.length) console.log(`    только loom: ${d.onlyLoom.join(' || ')}`);
            }
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
