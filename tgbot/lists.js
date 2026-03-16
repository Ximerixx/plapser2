'use strict';

/**
 * In worker: fetch groups/teachers/auditories from main process API (apiBaseUrl).
 * Short TTL cache (60s) for inline session to avoid hitting main on every step.
 */
const LIST_CACHE_TTL_MS = 60000; // 60 seconds
const cache = { groups: null, groupsTs: 0, teachers: null, teachersTs: 0, auditories: null, auditoriesTs: 0 };

async function fetchList(apiBaseUrl, path) {
    const url = (apiBaseUrl.replace(/\/$/, '') + path).replace(/\/\/api/, '/api');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
    return res.json();
}

async function getGroupsList(apiBaseUrl) {
    if (cache.groups && (Date.now() - cache.groupsTs < LIST_CACHE_TTL_MS)) return cache.groups;
    cache.groups = await fetchList(apiBaseUrl, '/api/groups');
    cache.groupsTs = Date.now();
    return cache.groups;
}

async function getTeachersList(apiBaseUrl) {
    if (cache.teachers && (Date.now() - cache.teachersTs < LIST_CACHE_TTL_MS)) return cache.teachers;
    cache.teachers = await fetchList(apiBaseUrl, '/api/teachers');
    cache.teachersTs = Date.now();
    return cache.teachers;
}

async function getAuditoriesList(apiBaseUrl) {
    if (cache.auditories && (Date.now() - cache.auditoriesTs < LIST_CACHE_TTL_MS)) return cache.auditories;
    cache.auditories = await fetchList(apiBaseUrl, '/api/auditories');
    cache.auditoriesTs = Date.now();
    return cache.auditories;
}

function getListByEntityType(apiBaseUrl, entityType) {
    if (entityType === 'group') return getGroupsList(apiBaseUrl);
    if (entityType === 'teacher') return getTeachersList(apiBaseUrl);
    if (entityType === 'auditory') return getAuditoriesList(apiBaseUrl);
    return Promise.resolve([]);
}

module.exports = { getGroupsList, getTeachersList, getAuditoriesList, getListByEntityType };
