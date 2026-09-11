#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');

const REPORT_DIR = process.argv[2]
    || path.join(__dirname, '../fusionloom/reports/eye-2026-09-08-1789145701208');
const BASE_DATE = '2026-09-08';
const LOOM_DB = path.join(REPORT_DIR, 'loom-live.db');

if (!fs.existsSync(LOOM_DB)) {
    console.error('Нет loom-live.db в', REPORT_DIR);
    process.exit(1);
}

process.env.FUSIONLOOM_DB_PATH = LOOM_DB;

const loomRead = require('../fusionloom/read');
const jsapiLoom = require('../jsapi_loom');
const { formatAuditoryName } = require('../parser/normalizeAuditory');

const ENTITIES = [
    { type: 'group', key: 'ДЗ1-242-ОТ' },
    { type: 'group', key: 'ПП2-261-ОБ' },
    { type: 'group', key: 'ИС2-241-ОБ' },
    { type: 'group', key: 'ЮГП2-251-ОБ' },
    { type: 'group', key: 'ТД1-241-ОТ' },
    { type: 'teacher', key: 'Ткачев В.В.' },
    { type: 'teacher', key: 'Шмарина Д.А.' },
    { type: 'teacher', key: 'Гудкова Н.А.' },
    { type: 'teacher', key: 'Кувшинова О.В.' },
    { type: 'teacher', key: 'Мандрикина О.И.' },
    { type: 'auditory', key: '26Пр/Гл' },
    { type: 'auditory', key: '348Л/Гл' },
    { type: 'auditory', key: '116Л/7к' },
    { type: 'auditory', key: '3Комп/АГор' },
    { type: 'auditory', key: '27общ/10к' }
];

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

function slotKey(l) {
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

function slotSet(data) {
    const s = new Set();
    for (const day of Object.values(data || {})) {
        for (const l of day.lessons || []) {
            if (l.time && l.time.includes('-')) s.add(slotKey(l));
        }
    }
    return s;
}

function countLessons(data) {
    return slotSet(data).size;
}

function diffSlots(a, b) {
    const sa = slotSet(a);
    const sb = slotSet(b);
    return {
        onlyReport: [...sa].filter((k) => !sb.has(k)).slice(0, 3),
        onlyJsapi: [...sb].filter((k) => !sa.has(k)).slice(0, 3)
    };
}

async function readReport(type, key) {
    if (type === 'group') return loomRead.getStudentScheduleWeek(key, BASE_DATE);
    if (type === 'teacher') return loomRead.getTeacherScheduleWeek(key, BASE_DATE);
    return loomRead.getAuditoryScheduleWeek(formatAuditoryName(key), BASE_DATE);
}

async function readJsapi(type, key) {
    if (type === 'group') return (await jsapiLoom.getScheduleGroup(key, BASE_DATE)).data;
    if (type === 'teacher') return (await jsapiLoom.getScheduleTeacher(key, BASE_DATE)).data;
    return (await jsapiLoom.getScheduleAuditory(key, BASE_DATE)).data;
}

async function main() {
    console.log('Отчёт (fusionloom/read) vs jsapi_loom');
    console.log('БД:', LOOM_DB);
    console.log('Неделя с', BASE_DATE, '\n');

    let ok = 0;
    for (const { type, key } of ENTITIES) {
        const reportWeek = sliceWeek(await readReport(type, key), BASE_DATE);
        let jsapiWeek;
        let source;
        if (type === 'group') {
            const r = await jsapiLoom.getScheduleGroup(key, BASE_DATE);
            jsapiWeek = sliceWeek(r.data, BASE_DATE);
            source = r.source;
        } else if (type === 'teacher') {
            const r = await jsapiLoom.getScheduleTeacher(key, BASE_DATE);
            jsapiWeek = sliceWeek(r.data, BASE_DATE);
            source = r.source;
        } else {
            const r = await jsapiLoom.getScheduleAuditory(key, BASE_DATE);
            jsapiWeek = sliceWeek(r.data, BASE_DATE);
            source = r.source;
        }

        const reportSlots = [...slotSet(reportWeek)].sort();
        const jsapiSlots = [...slotSet(jsapiWeek)].sort();
        const match = JSON.stringify(reportSlots) === JSON.stringify(jsapiSlots);
        if (match) ok++;

        const tag = match ? 'OK' : 'DIFF';
        console.log(`[${tag}] ${type} ${key}`);
        console.log(`  report: ${countLessons(reportWeek)} слотов | jsapi_loom: ${countLessons(jsapiWeek)} слотов | source=${source}`);
        if (!match) {
            const d = diffSlots(reportWeek, jsapiWeek);
            if (d.onlyReport.length) {
                console.log('  только в отчёте:');
                d.onlyReport.forEach((k) => console.log(`    ${k}`));
            }
            if (d.onlyJsapi.length) {
                console.log('  только в jsapi_loom:');
                d.onlyJsapi.forEach((k) => console.log(`    ${k}`));
            }
        }
    }

    console.log(`\nИтого: ${ok}/${ENTITIES.length} совпали`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
