'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseAuditoryParts, normalizeRoomType, formatAuditoryDisplayName } = require('../fusionloom/normalize/auditories');
const anomalies = require('../samples/data/anomalies.json');

describe('normalizeRoomType', () => {
    it('преподавательская не должна становиться практической', () => {
        assert.equal(normalizeRoomType('Преп'), 'преп');
        assert.equal(normalizeRoomType('преп'), 'преп');
        assert.notEqual(normalizeRoomType('Преп'), 'пр');
    });

    it('практический кабинет остаётся пр', () => {
        assert.equal(normalizeRoomType('Пр'), 'пр');
        assert.equal(normalizeRoomType('пр'), 'пр');
    });
});

describe('formatAuditoryDisplayName', () => {
    it('сз/ГЛ в главном корпусе → Спортзал', () => {
        assert.equal(formatAuditoryDisplayName('сз/ГЛ'), 'Спортзал');
        assert.equal(formatAuditoryDisplayName('сз/гл'), 'Спортзал');
    });

    it('обычные аудитории без изменений', () => {
        assert.equal(formatAuditoryDisplayName('119Л/7к'), '119Л/7К');
    });
});

describe('parseAuditoryParts anomalies', () => {
    for (const case_ of anomalies.auditories) {
        it(case_.id, () => {
            const parts = parseAuditoryParts(case_.raw);
            for (const [key, val] of Object.entries(case_.expected)) {
                assert.equal(parts[key], val, `${case_.id}: ${key}`);
            }
            if (case_.mustNot) {
                for (const [key, val] of Object.entries(case_.mustNot)) {
                    assert.notEqual(parts[key], val, `${case_.id}: must not be ${key}=${val}`);
                }
            }
        });
    }
});
