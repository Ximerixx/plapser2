#!/usr/bin/env node
'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'db', 'plapser.db');

function main() {
    const db = new Database(DB_PATH, { readonly: true });

    console.log('=== Table row counts ===\n');
    const tables = ['groups', 'teachers', 'auditories', 'subjects', 'schedule_slots', 'schedule_meta', 'request_stats'];
    let total = 0;
    for (const table of tables) {
        try {
            const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
            const n = row.c;
            total += n;
            console.log(`  ${table}: ${n.toLocaleString()}`);
        } catch (e) {
            console.log(`  ${table}: (table missing or error) ${e.message}`);
        }
    }
    console.log(`  ---\n  total rows: ${total.toLocaleString()}\n`);

    console.log('=== Reference tables: duplicate names (UNIQUE should prevent; expect 0) ===\n');
    for (const table of ['groups', 'teachers', 'auditories', 'subjects']) {
        try {
            const dupes = db.prepare(`
                SELECT name, COUNT(*) AS cnt FROM ${table} GROUP BY name HAVING COUNT(*) > 1
            `).all();
            if (dupes.length) {
                console.log(`  ${table}: ${dupes.length} duplicate name(s):`, dupes);
            } else {
                console.log(`  ${table}: no duplicate names`);
            }
        } catch (e) {
            console.log(`  ${table}: ${e.message}`);
        }
    }

    console.log('\n=== schedule_meta: duplicate (entity_type, entity_key, date) (UNIQUE should prevent) ===\n');
    try {
        const metaDupes = db.prepare(`
            SELECT entity_type, entity_key, date, COUNT(*) AS cnt
            FROM schedule_meta
            GROUP BY entity_type, entity_key, date
            HAVING COUNT(*) > 1
        `).all();
        if (metaDupes.length) {
            console.log('  Found:', metaDupes.length, metaDupes);
        } else {
            console.log('  no duplicates (unique constraint holds)');
        }
    } catch (e) {
        console.log('  ', e.message);
    }

    console.log('\n=== schedule_slots: duplicate lesson rows (same slot inserted multiple times) ===\n');
    try {
        const slotDupes = db.prepare(`
            SELECT group_id, date, time_start, time_end, subject_id, teacher_id, auditory_id, COUNT(*) AS cnt
            FROM schedule_slots
            GROUP BY group_id, date, time_start, time_end, subject_id, teacher_id, auditory_id
            HAVING COUNT(*) > 1
        `).all();
        if (slotDupes.length) {
            const totalDuplicateRows = db.prepare(`
                SELECT SUM(cnt - 1) AS extra FROM (
                    SELECT COUNT(*) AS cnt
                    FROM schedule_slots
                    GROUP BY group_id, date, time_start, time_end, subject_id, teacher_id, auditory_id
                    HAVING COUNT(*) > 1
                )
            `).get();
            console.log(`  Unique slot keys that appear more than once: ${slotDupes.length}`);
            console.log(`  Extra (redundant) rows you could remove: ${(totalDuplicateRows?.extra ?? 0)}`);
            console.log('  Sample (first 10):');
            slotDupes.slice(0, 10).forEach((r, i) => {
                console.log(`    ${i + 1}. group_id=${r.group_id} date=${r.date} ${r.time_start}-${r.time_end} subject_id=${r.subject_id} teacher_id=${r.teacher_id} auditory_id=${r.auditory_id} → ${r.cnt}x`);
            });
        } else {
            console.log('  no duplicate slot rows found');
        }
    } catch (e) {
        console.log('  ', e.message);
    }

    db.close();
}

main();
