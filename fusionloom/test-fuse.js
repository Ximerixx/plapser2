'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

process.env.FUSIONLOOM_DB_PATH = path.join(__dirname, 'data', 'test-fusionloom.db');
const dbPath = process.env.FUSIONLOOM_DB_PATH;
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const { ingestWeek } = require('./ingest');
const db = require('./fusionloom_db');

const baseDate = '2025-09-15';
const group = 'ИС2-244-ОБ';
const teacher = 'Иванов И.И.';
const auditory = '104Комп/7к';

const groupWeek = {
    [baseDate]: {
        date: '15 сентября 2025',
        dayOfWeek: 'понедельник',
        lessons: [{
            time: '13:40-15:10',
            type: 'лаб',
            name: 'Прикладные задачи программирования',
            subgroup: '1',
            groups: [group],
            auditory,
            teacher
        }]
    }
};

const teacherWeek = {
    [baseDate]: {
        date: '15 сентября 2025',
        dayOfWeek: 'понедельник',
        lessons: [{
            time: '13:40-15:10',
            subject: 'Прикладные задачи программирования',
            groups: [group],
            auditory,
            subgroup: '1'
        }]
    }
};

const auditoryWeek = {
    [baseDate]: {
        date: '15 сентября 2025',
        dayOfWeek: 'понедельник',
        lessons: [{
            time: '13:40-15:10',
            name: 'Прикладные задачи программирования',
            groups: [group],
            teacher,
            type: 'лаб'
        }]
    }
};

ingestWeek({ viewType: 'group', viewKey: group, anchorDate: baseDate, parsedWeek: groupWeek });
ingestWeek({ viewType: 'teacher', viewKey: teacher, anchorDate: baseDate, parsedWeek: teacherWeek });
ingestWeek({ viewType: 'auditory', viewKey: auditory, anchorDate: baseDate, parsedWeek: auditoryWeek });

const lessonCount = db.getDb().prepare('SELECT COUNT(*) AS c FROM lessons').get().c;
assert.strictEqual(lessonCount, 1, 'three views should fuse into one lesson');

const lg = db.getDb().prepare('SELECT COUNT(*) AS c FROM lesson_groups').get().c;
const lt = db.getDb().prepare('SELECT COUNT(*) AS c FROM lesson_teachers').get().c;
const la = db.getDb().prepare('SELECT COUNT(*) AS c FROM lesson_auditories').get().c;
assert.strictEqual(lg, 1);
assert.strictEqual(lt, 1);
assert.strictEqual(la, 1);

const multiTeacherWeek = {
    [baseDate]: {
        lessons: [{
            time: '10:00-11:30',
            subject: 'Тест',
            groups: ['ГР1-111-ОБ', 'ГР2-222-ОБ'],
            auditory: '201/7К',
            teacher: 'Петров П.П.'
        }]
    }
};
ingestWeek({ viewType: 'teacher', viewKey: 'Петров П.П.', anchorDate: baseDate, parsedWeek: multiTeacherWeek });
const lesson2Groups = db.getDb().prepare(`
    SELECT COUNT(*) AS c FROM lesson_groups lg
    JOIN lessons l ON l.id = lg.lesson_id
    WHERE l.time_start = '10:00'
`).get().c;
assert.strictEqual(lesson2Groups, 2, 'multi-group lesson should have two group links');

// Подгруппы 1 и 2 в одном слоте — разные lessons
const sgWeek = {
    [baseDate]: {
        lessons: [
            { time: '18:40-20:10', name: 'Предмет А', subgroup: '1', groups: [group], auditory: '204Комп/7К', teacher: 'Петров П.П.' },
            { time: '18:40-20:10', name: 'Предмет Б', subgroup: '2', groups: [group], auditory: '205Комп/7К', teacher: 'Сидоров С.С.' }
        ]
    }
};
ingestWeek({ viewType: 'group', viewKey: group, anchorDate: baseDate, parsedWeek: sgWeek });
const sgLessons = db.getDb().prepare(`
    SELECT COUNT(*) AS c FROM lessons WHERE date = ? AND time_start = '18:40'
`).get(baseDate).c;
assert.strictEqual(sgLessons, 2, 'subgroups 1 and 2 must not fuse');

// «1 п.г.» и «1» — один fusion_key
const sgNormWeek = {
    [baseDate]: {
        lessons: [
            { time: '09:00-10:30', name: 'Норм', subgroup: '1 п.г.', groups: [group], auditory: '119Л/7К', teacher: 'Петров П.П.' },
            { time: '09:00-10:30', name: 'Норм', subgroup: '1', groups: [group], auditory: '119Л/7К', teacher: 'Петров П.П.' }
        ]
    }
};
ingestWeek({ viewType: 'group', viewKey: group, anchorDate: baseDate, parsedWeek: sgNormWeek });
const normLessons = db.getDb().prepare(`
    SELECT COUNT(*) AS c FROM lessons WHERE date = ? AND time_start = '09:00'
`).get(baseDate).c;
assert.strictEqual(normLessons, 1, '1 п.г. and 1 should fuse');

console.log('fusionloom test-fuse: OK');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
