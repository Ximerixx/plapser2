#!/usr/bin/env node
'use strict';

const path = require('path');

process.env.FUSIONLOOM_DB_PATH = process.env.FUSIONLOOM_DB_PATH
    || path.join(__dirname, '../fusionloom/data/fusionloom.db');

const jsapi = require('../jsapi');

const entityType = process.argv[2] || 'group';
const entityKey = process.argv[3];
const baseDate = process.argv[4] || new Date().toISOString().split('T')[0];

if (!entityKey) {
    console.error('Usage: node fusionloom-shadow-compare.js <group|teacher|auditory> <entityKey> [baseDate]');
    process.exit(1);
}

function normWeek(data) {
    return JSON.stringify(data || {});
}

async function main() {
    let data;
    if (entityType === 'group') {
        data = (await jsapi.getScheduleGroup(entityKey, baseDate)).data;
    } else if (entityType === 'teacher') {
        data = (await jsapi.getScheduleTeacher(entityKey, baseDate)).data;
    } else {
        data = (await jsapi.getScheduleAuditory(entityKey, baseDate)).data;
    }
    const match = data != null;
    console.log(JSON.stringify({ entityType, entityKey, baseDate, ok: match, lessonDays: Object.keys(data || {}).length }, null, 2));
    if (!match) process.exit(2);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
