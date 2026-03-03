#!/usr/bin/env node
'use strict';

/**
 * Seed script: preload schedule data from KIS into the local SQLite DB.
 * Run from project root: node scripts/seed-schedule.js
 * Optional env: SEED_DAYS=14 (default 14), SEED_TEACHERS=1, SEED_AUDITORIES=1 to include teachers/auditories.
 */

const path = require('path');

const dbPath = path.join(__dirname, '..', 'db', 'db.js');
const parseStudent = require(path.join(__dirname, '..', 'parser', 'parseStudent')).parseStudent;
const parseTeacher = require(path.join(__dirname, '..', 'parser', 'parseTeacher')).parseTeacher;
const parseAuditory = require(path.join(__dirname, '..', 'parser', 'parseAuditory')).parseAuditory;
const db = require(dbPath);

const DELAY_MS = 10;
const SEED_DAYS = parseInt(process.env.SEED_DAYS || '14', 10);
const SEED_TEACHERS = process.env.SEED_TEACHERS === '1' || process.env.SEED_TEACHERS === 'true';
const SEED_AUDITORIES = process.env.SEED_AUDITORIES === '1' || process.env.SEED_AUDITORIES === 'true';

function getDateOffset(offsetDays, baseDate = null) {
    const d = baseDate ? new Date(baseDate + 'T12:00:00') : new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().split('T')[0];
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchGroups() {
    const res = await fetch('https://kis.vgltu.ru/list?type=Group');
    const data = await res.json();
    return Array.isArray(data) ? data.filter(g => typeof g === 'string' && g.trim() !== '') : [];
}

async function fetchTeachers() {
    const res = await fetch('https://kis.vgltu.ru/list?type=Teacher');
    const data = await res.json();
    return Array.isArray(data) ? data.filter(t => typeof t === 'string' && t.trim() !== '') : [];
}

async function fetchAuditories() {
    const res = await fetch('https://kis.vgltu.ru/list?type=Auditory');
    const data = await res.json();
    return Array.isArray(data) ? data.filter(a => typeof a === 'string' && a.trim() !== '') : [];
}

async function main() {
    console.log('Seed: fetching group list...');
    const groups = await fetchGroups();
    console.log(`Seed: ${groups.length} groups`);

    let teachers = [];
    if (SEED_TEACHERS) {
        console.log('Seed: fetching teacher list...');
        teachers = await fetchTeachers();
        console.log(`Seed: ${teachers.length} teachers`);
    }

    let auditories = [];
    if (SEED_AUDITORIES) {
        console.log('Seed: fetching auditory list...');
        auditories = await fetchAuditories();
        console.log(`Seed: ${auditories.length} auditories`);
        for (const name of auditories) {
            try { db.ensureAuditory(name); } catch (_) {}
        }
    }

    const today = getDateOffset(0);
    const numWeeks = Math.ceil(SEED_DAYS / 7);

    for (let w = 0; w < numWeeks; w++) {
        const baseDate = getDateOffset(w * 7, today);
        console.log(`\nSeed: week starting ${baseDate}`);

        for (const group of groups) {
            try {
                const data = await parseStudent(baseDate, group, null);
                if (data && Object.keys(data).length > 0) {
                    db.saveStudentScheduleToDb(group, baseDate, data);
                    console.log(`  group ${group} ok`);
                }
            } catch (e) {
                console.warn(`  group ${group} error:`, e.message);
            }
            await sleep(DELAY_MS);
        }

        if (SEED_TEACHERS) {
            for (const teacher of teachers) {
                try {
                    const data = await parseTeacher(baseDate, teacher);
                    if (data && Object.keys(data).length > 0) {
                        db.saveTeacherScheduleToDb(teacher, baseDate, data);
                        console.log(`  teacher ${teacher} ok`);
                    }
                } catch (e) {
                    console.warn(`  teacher ${teacher} error:`, e.message);
                }
                await sleep(DELAY_MS);
            }
        }

        if (SEED_AUDITORIES && auditories.length > 0) {
            for (const auditory of auditories) {
                try {
                    const data = await parseAuditory(baseDate, auditory);
                    if (data && Object.keys(data).length > 0) {
                        db.saveAuditoryScheduleToDb(auditory, baseDate, data);
                        console.log(`  auditory ${auditory} ok`);
                    }
                } catch (e) {
                    console.warn(`  auditory ${auditory} error:`, e.message);
                }
                await sleep(DELAY_MS);
            }
        }
    }

    console.log('\nSeed: done.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
