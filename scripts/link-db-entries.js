#!/usr/bin/env node
'use strict';

/**
 * Verify and repair foreign-key links in the database.
 * Use after importing or if data was added before FK enforcement was enabled.
 * Run from project root: node scripts/link-db-entries.js
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'db', 'plapser.db');

function main() {
    const db = new Database(DB_PATH);
    db.pragma('foreign_keys = OFF');

    let fixed = 0;
    let deleted = 0;

    // 1. Fix nullable FKs: set to NULL if referenced row is missing
    const nullTeacher = db.prepare(`
        UPDATE schedule_slots SET teacher_id = NULL
        WHERE teacher_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM teachers WHERE id = schedule_slots.teacher_id)
    `).run();
    fixed += nullTeacher.changes;

    const nullSubject = db.prepare(`
        UPDATE schedule_slots SET subject_id = NULL
        WHERE subject_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM subjects WHERE id = schedule_slots.subject_id)
    `).run();
    fixed += nullSubject.changes;

    const nullAuditory = db.prepare(`
        UPDATE schedule_slots SET auditory_id = NULL
        WHERE auditory_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM auditories WHERE id = schedule_slots.auditory_id)
    `).run();
    fixed += nullAuditory.changes;

    // 2. Orphaned group_id: cannot fix (we don't have group name in slot), must delete
    const badGroup = db.prepare(`
        SELECT id FROM schedule_slots s
        WHERE NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = s.group_id)
    `).all();
    if (badGroup.length > 0) {
        const ids = badGroup.map(r => r.id);
        const del = db.prepare('DELETE FROM schedule_slots WHERE id = ?');
        const runDel = db.transaction((list) => {
            for (const id of list) del.run(id);
        });
        runDel(ids);
        deleted += ids.length;
    }

    db.pragma('foreign_keys = ON');
    const fkCheck = db.prepare('PRAGMA foreign_key_check(schedule_slots)').all();
    db.close();

    if (fixed > 0 || deleted > 0) {
        console.log('Link repair:');
        if (fixed > 0) console.log(`  Set ${fixed} broken nullable FK(s) to NULL (teacher/subject/auditory).`);
        if (deleted > 0) console.log(`  Deleted ${deleted} slot(s) with invalid group_id.`);
    } else {
        console.log('All links valid: every schedule_slot references existing groups, teachers, subjects, and auditories.');
    }
    if (fkCheck.length > 0) {
        console.error('PRAGMA foreign_key_check still reports:', fkCheck);
        process.exit(1);
    }
    console.log('Done.');
}

main();
