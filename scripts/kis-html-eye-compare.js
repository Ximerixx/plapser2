#!/usr/bin/env node
'use strict';

/**
 * Live: KIS HTML (как на сайте) ↔ loom (свежий ingest с KIS).
 * Парсер используется только чтобы положить данные в loom, не как эталон сравнения.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const cheerio = require('cheerio');

const { kisGet } = require('../parser/kisGet');
const { parseStudent } = require('../parser/parseStudent');
const { parseTeacher } = require('../parser/parseTeacher');
const { parseAuditory } = require('../parser/parseAuditory');
const { kisAuditoryQueryName } = require('../parser/normalizeAuditory');

const BASE_DATE = process.argv[2] || '2026-09-08';
const SAMPLE_SIZE = Number(process.argv[3]) || 5;
const REPORT_DIR = process.argv[4]
    || path.join(__dirname, '../fusionloom/reports', `eye-${BASE_DATE}-${Date.now()}`);

const LOOM_DB = path.join(REPORT_DIR, 'loom-live.db');
process.env.FUSIONLOOM_DB_PATH = LOOM_DB;

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function slug(s) {
    return String(s).replace(/[^\w\u0400-\u04FF.-]+/gu, '_').slice(0, 80);
}

function extractScheduleHtml(rawHtml) {
    const $ = cheerio.load(rawHtml);
    const table = $('div.table');
    if (!table.length) {
        const body = $('body').html();
        return body ? `<div class="fallback">${body}</div>` : '<p>пустой ответ</p>';
    }
    return table.html() || '<p>div.table пуст</p>';
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderLoomLesson(lesson) {
    if (lesson.status === 'Нет пар') return '<tr><td colspan="2"><em>Нет пар</em></td></tr>';
    const lines = [];
    const subject = [lesson.type, lesson.name || lesson.subject].filter(Boolean).join(' ').trim();
    if (subject) lines.push(escapeHtml(subject));
    if (lesson.subgroup) lines.push(`п.г. ${escapeHtml(lesson.subgroup)}`);
    const groups = lesson.groups?.length
        ? lesson.groups.join(', ')
        : (lesson.group || '');
    if (groups) lines.push(escapeHtml(groups));
    if (lesson.teacher) lines.push(escapeHtml(lesson.teacher));
    const aud = lesson.auditory || lesson.room || '';
    if (aud) lines.push(escapeHtml(aud));
    return `<tr>
        <td style="width:75px;white-space:nowrap">${escapeHtml(lesson.time)}</td>
        <td>${lines.join('<br>')}</td>
    </tr>`;
}

function renderLoomWeek(week) {
    if (!week || !Object.keys(week).length) return '<p><em>loom: нет данных на эту неделю</em></p>';
    const dates = Object.keys(week).sort();
    let html = '';
    for (const date of dates) {
        const day = week[date];
        html += `<div class="day-block">
            <div class="day-title"><strong>${escapeHtml(day.date || date)}</strong></div>
            <div class="day-week">${escapeHtml(day.dayOfWeek || '')}</div>
            <table class="loom-table">${(day.lessons || []).map(renderLoomLesson).join('')}</table>
        </div>`;
    }
    return html;
}

function pageHtml({ title, kisUrl, entityType, entityKey, kisFragment, loomHtml }) {
    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #f4f4f4; }
    header { background: #1a3a5c; color: #fff; padding: 12px 20px; }
    header a { color: #9cf; }
    .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0; min-height: calc(100vh - 56px); }
    .col { padding: 16px; overflow: auto; }
    .col-kis { background: #fff; border-right: 3px solid #1a3a5c; }
    .col-loom { background: #f9fff9; }
    h2 { margin: 0 0 12px; font-size: 1rem; text-transform: uppercase; letter-spacing: .04em; }
    .day-block { margin-bottom: 25px; }
    .day-title { margin-bottom: 4px; }
    .day-week { margin-bottom: 8px; color: #555; }
    table { border-collapse: collapse; width: 100%; }
    td { border: 1px solid #ccc; padding: 6px 8px; vertical-align: top; font-size: 14px; }
    .col-kis table td { font-size: 13px; }
    .loom-table td:first-child { background: #f0f0f0; }
    .note { color: #666; font-size: 13px; margin-top: 8px; }
  </style>
</head>
<body>
  <header>
    <a href="index.html">← все</a>
    &nbsp; ${escapeHtml(entityType)}: <strong>${escapeHtml(entityKey)}</strong>
    &nbsp;· неделя с ${escapeHtml(BASE_DATE)}
    &nbsp;· <a href="${escapeHtml(kisUrl)}" target="_blank">открыть на kis.vgltu.ru</a>
  </header>
  <div class="cols">
    <div class="col col-kis">
      <h2>KIS — сырой HTML (div.table)</h2>
      <div class="kis-raw">${kisFragment}</div>
      <p class="note">Слева — фрагмент страницы KIS без обработки парсером.</p>
    </div>
    <div class="col col-loom">
      <h2>Loom — после live ingest</h2>
      ${loomHtml}
      <p class="note">Справа — выдача fusionloom/read после ingest свежего ответа KIS.</p>
    </div>
  </div>
</body>
</html>`;
}

function indexHtml(entries) {
    const rows = entries.map((e) => `
      <tr>
        <td>${escapeHtml(e.type)}</td>
        <td><a href="${escapeHtml(e.file)}">${escapeHtml(e.key)}</a></td>
        <td>${e.kisUrl ? `<a href="${escapeHtml(e.kisUrl)}" target="_blank">KIS</a>` : ''}</td>
      </tr>`).join('');
    return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>Eye compare ${escapeHtml(BASE_DATE)}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px}
  table{border-collapse:collapse;width:100%} td,th{border:1px solid #ccc;padding:8px;text-align:left}
  th{background:#1a3a5c;color:#fff}
</style></head><body>
<h1>Сравнение KIS HTML ↔ Loom (live)</h1>
<p>Неделя с <strong>${escapeHtml(BASE_DATE)}</strong>. Откройте строку — слева сырой HTML с сайта, справа loom.</p>
<table><thead><tr><th>тип</th><th>сущность</th><th></th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
}

async function fetchList(type) {
    const { data } = await kisGet(`https://kis.vgltu.ru/list?type=${type}`, null);
    return Array.isArray(data) ? data : [];
}

function resetLoomModules() {
    for (const mod of Object.keys(require.cache)) {
        if (mod.includes(`${path.sep}fusionloom${path.sep}`)) delete require.cache[mod];
    }
}

async function processEntity({ type, key, buildUrl, parseFn, readFn, viewType }) {
    const kisUrl = buildUrl(key);
    const { data: rawHtml } = await kisGet(kisUrl, null);
    const kisFragment = extractScheduleHtml(rawHtml);

    const parsed = await parseFn();
    const ingest = require('../fusionloom/ingest').ingestWeek;
    const read = require('../fusionloom/read');
    ingest({ viewType, viewKey: key, anchorDate: BASE_DATE, parsedWeek: parsed });
    const loomWeek = readFn(read);

    const fileName = `${type}-${slug(key)}.html`;
    const outPath = path.join(REPORT_DIR, fileName);
    fs.writeFileSync(outPath, pageHtml({
        title: `${type} ${key}`,
        kisUrl,
        entityType: type,
        entityKey: key,
        kisFragment,
        loomHtml: renderLoomWeek(loomWeek)
    }), 'utf8');

    return { type, key, file: fileName, kisUrl };
}

async function main() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    if (fs.existsSync(LOOM_DB)) fs.unlinkSync(LOOM_DB);
    resetLoomModules();

    console.log('Загрузка списков с KIS…');
    const [groups, teachers, auditoriums] = await Promise.all([
        fetchList('Group'),
        fetchList('Teacher'),
        fetchList('Auditory')
    ]);

    const pick = {
        groups: shuffle(groups).slice(0, SAMPLE_SIZE),
        teachers: shuffle(teachers).slice(0, SAMPLE_SIZE),
        auditoriums: shuffle(auditoriums).slice(0, SAMPLE_SIZE)
    };

    console.log('Группы:', pick.groups.join(', '));
    console.log('Преподы:', pick.teachers.join(', '));
    console.log('Аудитории:', pick.auditoriums.join(', '));

    const entries = [];

    for (const group of pick.groups) {
        entries.push(await processEntity({
            type: 'group',
            key: group,
            buildUrl: (g) => `https://kis.vgltu.ru/schedule?date=${BASE_DATE}&group=${encodeURIComponent(g)}`,
            parseFn: () => parseStudent(BASE_DATE, group),
            readFn: (read) => read.getStudentScheduleWeek(group, BASE_DATE),
            viewType: 'group'
        }));
        console.log('  group OK', group);
    }

    for (const teacher of pick.teachers) {
        entries.push(await processEntity({
            type: 'teacher',
            key: teacher,
            buildUrl: (t) => `https://kis.vgltu.ru/schedule?teacher=${encodeURIComponent(t)}&date=${BASE_DATE}`,
            parseFn: () => parseTeacher(BASE_DATE, teacher),
            readFn: (read) => read.getTeacherScheduleWeek(teacher, BASE_DATE),
            viewType: 'teacher'
        }));
        console.log('  teacher OK', teacher);
    }

    for (const auditory of pick.auditoriums) {
        const kisName = kisAuditoryQueryName(auditory);
        entries.push(await processEntity({
            type: 'auditory',
            key: auditory,
            buildUrl: (a) => `https://kis.vgltu.ru/schedule?auditory=${encodeURIComponent(kisAuditoryQueryName(a))}&date=${BASE_DATE}`,
            parseFn: () => parseAuditory(BASE_DATE, auditory),
            readFn: (read) => read.getAuditoryScheduleWeek(kisName, BASE_DATE),
            viewType: 'auditory'
        }));
        console.log('  auditory OK', auditory);
    }

    fs.writeFileSync(path.join(REPORT_DIR, 'index.html'), indexHtml(entries), 'utf8');
    console.log('\nГотово:', REPORT_DIR);
    console.log('Откройте:', path.join(REPORT_DIR, 'index.html'));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
