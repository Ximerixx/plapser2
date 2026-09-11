'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { subjectDisplayName, subjectCanonicalKey, normalizeSubjectPrefix } = require('../fusionloom/normalize/subjects');
const { parseGroupName, groupDisplayName, groupCanonicalKey } = require('../fusionloom/normalize/groups');

describe('subjects without prefix', () => {
    it('keeps plain subject name as-is', () => {
        assert.equal(normalizeSubjectPrefix('Физика'), 'Физика');
        assert.equal(subjectDisplayName('Физика'), 'Физика');
        assert.equal(subjectCanonicalKey('Физика'), 'физика');
    });

    it('still normalizes prefixed subjects', () => {
        assert.equal(subjectDisplayName('лек.Физика'), 'лек. Физика');
        assert.equal(subjectDisplayName('пр Физика'), 'пр. Физика');
    });
});

describe('group name casing', () => {
    it('preserves display casing', () => {
        assert.equal(groupDisplayName('ис2-244-об'), 'ис2-244-об');
        assert.equal(groupDisplayName('ИС2-244-ОБ'), 'ИС2-244-ОБ');
    });

    it('maps different casings to same canonical key', () => {
        assert.equal(groupCanonicalKey('ис2-244-об'), groupCanonicalKey('ИС2-244-ОБ'));
    });

    it('parses lowercase group names', () => {
        const parsed = parseGroupName('им2-241-об');
        assert.ok(parsed);
        assert.equal(parsed.rawName, 'им2-241-об');
        assert.equal(parsed.form, 'об');
    });
});
