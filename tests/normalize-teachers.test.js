'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatTeacherDisplayName } = require('../fusionloom/normalize/teachers');
const anomalies = require('../samples/data/anomalies.json');

describe('formatTeacherDisplayName', () => {
    for (const case_ of anomalies.teachers) {
        it(`${case_.raw} → ${case_.expected}`, () => {
            assert.equal(formatTeacherDisplayName(case_.raw), case_.expected);
        });
    }
});
