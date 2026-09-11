'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    kisGroupQueryName,
    kisTeacherQueryName,
    resolveKisListName
} = require('../fusionloom/normalize/kis_query');
const { groupCanonicalKey } = require('../fusionloom/normalize/groups');
const { teacherCanonicalKey } = require('../fusionloom/normalize/teachers');

describe('kisGroupQueryName', () => {
    const list = ['ИС2-241-ОБ', 'ИМ2-244-ОБ'];

    it('возвращает точное имя из списка KIS', () => {
        assert.equal(kisGroupQueryName('ис2-241-об', list), 'ИС2-241-ОБ');
        assert.equal(kisGroupQueryName('ИС2-241-ОБ', list), 'ИС2-241-ОБ');
    });

    it('без списка — upper case', () => {
        assert.equal(kisGroupQueryName('ис2-241-об'), 'ИС2-241-ОБ');
    });
});

describe('kisTeacherQueryName', () => {
    const list = ['Абрамов В.В.', 'Гудкова А.В.'];

    it('возвращает точное имя из списка KIS', () => {
        assert.equal(kisTeacherQueryName('абрамов в.в.', list), 'Абрамов В.В.');
        assert.equal(kisTeacherQueryName('Абрамов В.В.', list), 'Абрамов В.В.');
    });
});

describe('resolveKisListName', () => {
    it('сопоставляет по canonical key', () => {
        const list = ['ИС2-241-ОБ'];
        assert.equal(resolveKisListName('ис2-241-об', list, groupCanonicalKey), 'ИС2-241-ОБ');
        assert.equal(resolveKisListName('Абрамов В.В.', ['Абрамов В.В.'], teacherCanonicalKey), 'Абрамов В.В.');
    });
});
