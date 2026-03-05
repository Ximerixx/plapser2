#!/usr/bin/env node
'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'db', 'plapser.db');

function main() {
    const db = new Database(DB_PATH);

    const before = db.prepare('SELECT COUNT(*) AS c FROM schedule_slots').get().c;

    // Delete duplicate rows, keeping the one with the smallest id per (group_id, date, time_start, time_end, subject_id, teacher_id, auditory_id)
    const run = db.prepare(`
        DELETE FROM schedule_slots
        WHERE id NOT IN (
            SELECT MIN(id) FROM schedule_slots
            GROUP BY group_id, date, time_start, time_end, subject_id, teacher_id, auditory_id
        )
    `);
    const info = run.run();
    const after = db.prepare('SELECT COUNT(*) AS c FROM schedule_slots').get().c;

    console.log('Deduplicated schedule_slots:');
    console.log('  Before:', before.toLocaleString());
    console.log('  After:', after.toLocaleString());
    console.log('  Removed:', (before - after).toLocaleString());
    db.close();
}

main();
