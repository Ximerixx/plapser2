#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const { parseStudent } = require('../parser/parseStudent');
const { parseTeacher } = require('../parser/parseTeacher');
const { parseAuditory } = require('../parser/parseAuditory');

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

function weekDates(baseDate) {
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(baseDate + 'T12:00:00');
        d.setDate(d.getDate() + i);
        dates.push(d.toISOString().split('T')[0]);
    }
    return dates;
}

function sliceWeek(data, baseDate) {
    const out = {};
    for (const date of weekDates(baseDate)) {
        if (data?.[date]) out[date] = data[date];
    }
    return out;
}

function countLessons(data) {
    let n = 0;
    for (const day of Object.values(data || {})) {
        n += (day.lessons || []).filter((l) => l.time && l.time.includes('-')).length;
    }
    return n;
}

function semanticKey(l) {
    return [
        l.time,
        l.type || '',
        l.name || l.subject || '',
        l.subgroup || '',
        l.teacher || '',
        l.auditory || l.room || ''
    ].join('|');
}

function slotSet(data) {
    const s = new Set();
    for (const day of Object.values(data || {})) {
        for (const l of day.lessons || []) {
            if (l.time && l.time.includes('-')) s.add(semanticKey(l));
        }
    }
    return s;
}

function firstSemanticDiff(kis, loom) {
    const a = slotSet(kis);
    const b = slotSet(loom);
    const onlyKis = [...a].filter((k) => !b.has(k)).slice(0, 2);
    const onlyLoom = [...b].filter((k) => !a.has(k)).slice(0, 2);
    if (!onlyKis.length && !onlyLoom.length) return null;
    return { onlyKis, onlyLoom };
}

function resetLoomModules(dbPath) {
    process.env.FUSIONLOOM_DB_PATH = dbPath;
    for (const mod of Object.keys(require.cache)) {
        if (mod.includes(`${path.sep}fusionloom${path.sep}`)) delete require.cache[mod];
    }
}

async function run(type, key, parseFn, readFn, viewType) {
    const tmpDb = path.join(os.tmpdir(), `loom-roundtrip-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    resetLoomModules(tmpDb);
    const ingest = require('../fusionloom/ingest').ingestWeek;
    const read = require('../fusionloom/read');
    const kisFull = await parseFn();
    const kis = sliceWeek(kisFull, BASE_DATE);
    ingest({ viewType, viewKey: key, anchorDate: BASE_DATE, parsedWeek: kisFull });
    const loom = readFn(read);
    const semanticMatch = JSON.stringify([...slotSet(kis)].sort()) === JSON.stringify([...slotSet(loom)].sort());
    const exactMatch = JSON.stringify(kis) === JSON.stringify(loom);
    return {
        type,
        key,
        kisLessons: countLessons(kis),
        loomLessons: countLessons(loom),
        exactMatch,
        semanticMatch,
        diff: semanticMatch ? null : firstSemanticDiff(kis, loom)
    };
}

async function main() {
    const results = [];
    for (const group of SAMPLES.groups) {
        results.push(await run('group', group,
            () => parseStudent(BASE_DATE, group),
            (read) => read.getStudentScheduleWeek(group, BASE_DATE),
            'group'));
    }
    for (const teacher of SAMPLES.teachers) {
        results.push(await run('teacher', teacher,
            () => parseTeacher(BASE_DATE, teacher),
            (read) => read.getTeacherScheduleWeek(teacher, BASE_DATE),
            'teacher'));
    }
    for (const auditory of SAMPLES.auditoriums) {
        results.push(await run('auditory', auditory,
            () => parseAuditory(BASE_DATE, auditory),
            (read) => read.getAuditoryScheduleWeek(auditory, BASE_DATE),
            'auditory'));
    }

    console.log(`Roundtrip: KIS HTML parse → ingest → loom read, неделя с ${BASE_DATE}`);
    console.log(`Семантическое совпадение (без groups[]): ${results.filter((r) => r.semanticMatch).length}/${results.length}`);
    console.log(`Точное JSON: ${results.filter((r) => r.exactMatch).length}/${results.length}\n`);
    for (const r of results) {
        const tag = r.semanticMatch ? 'OK' : 'DIFF';
        console.log(`[${tag}] ${r.type} ${r.key} — KIS=${r.kisLessons}, loom=${r.loomLessons}`);
        if (r.diff) {
            for (const k of r.diff.onlyKis) console.log(`    KIS:  ${k}`);
            for (const k of r.diff.onlyLoom) console.log(`    loom: ${k}`);
        }
    }

}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
