'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseAuditoryParts } = require('../fusionloom/normalize/auditories');
const { formatTeacherDisplayName } = require('../fusionloom/normalize/teachers');

const groupsDir = path.join(__dirname, '../samples/data/groups');

describe('captured group samples', () => {
    for (const file of fs.readdirSync(groupsDir).filter((f) => f.endsWith('.json'))) {
        it(`normalizes auditories in ${file}`, () => {
            const data = JSON.parse(fs.readFileSync(path.join(groupsDir, file), 'utf8'));
            assert.ok(data.slots?.length, 'slots present');
            for (const slot of data.slots) {
                if (!slot.auditory_raw) continue;
                const parts = parseAuditoryParts(slot.auditory_raw);
                const isSpecialVenue = !/\d/.test(slot.auditory_raw);
                if (!isSpecialVenue) {
                    assert.ok(parts.roomNumber, `roomNumber for ${slot.auditory_raw}`);
                    assert.ok(parts.building, `building for ${slot.auditory_raw}`);
                }
                if (/преп/i.test(slot.auditory_raw)) {
                    assert.equal(parts.roomType, 'преп', slot.auditory_raw);
                }
                if (slot.teacher_raw) {
                    const t = formatTeacherDisplayName(slot.teacher_raw);
                    assert.match(t, /^[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)? [А-ЯЁ]\.[А-ЯЁ]\.$/u, slot.teacher_raw);
                }
                if (/^сз\//iu.test(slot.auditory_raw)) {
                    const { formatAuditoryDisplayName } = require('../fusionloom/normalize/auditories');
                    assert.equal(formatAuditoryDisplayName(slot.auditory_raw), 'Спортзал');
                }
            }
        });
    }
});
