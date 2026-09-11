'use strict';

const groups = require('../fusionloom/normalize/groups');
const teachers = require('../fusionloom/normalize/teachers');

module.exports = {
    GROUP_NAME_REGEX: groups.GROUP_NAME_REGEX,
    parseGroupName: groups.parseGroupName,
    academicYearLabel: groups.academicYearLabel,
    normalizeTeacherName: teachers.normalizeTeacherName,
    formatTeacherDisplayName: teachers.formatTeacherDisplayName,
    teacherCanonicalKey: teachers.teacherCanonicalKey
};
