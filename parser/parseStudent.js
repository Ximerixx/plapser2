const cheerio = require('cheerio');
const { normalizeSubjectPrefix } = require('./normalizeSubject');
const { kisGet } = require('./kisGet');

const VALID_LESSON_TYPES = new Set(['лек.', 'пр.', 'лаб.']);
// 2–3 буквы в префиксе (ИС2-244-ОБ и ОИС1-242-ОП)
const GROUP_REGEX = /^[А-ЯЁ]{2,3}\d-\d{2}\d-[А-ЯЁ]{2,4}$/iu;
const GROUP_REGEX_GLOBAL = /[А-ЯЁ]{2,3}\d-\d{2}\d-[А-ЯЁ]{2,4}/giu;
const TEACHER_REGEX = /^[А-ЯЁ][а-яё]*\s[А-ЯЁ]\.[А-ЯЁ]\.?$/;

const { formatAuditoryName, formatAuditoryDisplayName } = require('./normalizeAuditory');
const { formatTeacherDisplayName } = require('./parseGroupName');

async function parseStudent(date, group, subgroup = null, opts = null) {
    try {
        const url = `https://kis.vgltu.ru/schedule?date=${date}&group=${encodeURIComponent(group)}`;
        const { data } = await kisGet(url, opts);
        const $ = cheerio.load(data);

        const result = {};

        $('div.table > div[style*="margin-bottom: 25px"]').each((_, dayBlock) => {
            const $day = $(dayBlock);
            const dateText = $day.find('> div > strong').first().text().trim();
            const dayOfWeek = $day.find('> div').eq(1).text().trim();

            const [day, month, year] = dateText.split(' ');
            const months = {
                'января': '01', 'февраля': '02', 'марта': '03', 'апреля': '04',
                'мая': '05', 'июня': '06', 'июля': '07', 'августа': '08',
                'сентября': '09', 'октября': '10', 'ноября': '11', 'декабря': '12'
            };
            const dateKey = `${year}-${months[month]}-${day.padStart(2, '0')}`;

            result[dateKey] = {
                date: dateText,
                dayOfWeek: dayOfWeek,
                lessons: []
            };

            const $table = $day.find('table');
            const noLessons = $table.find('td:contains("Нет пар")').length > 0;

            if (noLessons) {
                result[dateKey].lessons.push({ status: 'Нет пар' });
                return;
            }

            let currentTime = null;
            let isSubgroupBlock = false;
            let subgroupLinesLeft = 0;

            $table.find('tr').each((_, row) => {
                const $row = $(row);
                const $cells = $row.find('td');

                const timeCell = $cells.filter('[style="width:75px"]');
                const hasTime = timeCell.length > 0;

                if (hasTime) {
                    currentTime = timeCell.text().trim().replace(/\s+/g, ' ');

                    const rowspanAttr = timeCell.attr('rowspan');
                    const rowspan = rowspanAttr ? parseInt(rowspanAttr, 10) : 1;

                    if (rowspan === 2) {
                        isSubgroupBlock = true;
                        subgroupLinesLeft = 2;
                    } else {
                        isSubgroupBlock = false;
                    }
                }

                if (!currentTime) return;

                if (isSubgroupBlock) {
                    subgroupLinesLeft--;
                    if (subgroupLinesLeft <= 0) {
                        isSubgroupBlock = false;
                    }
                }

                const $content = $cells.filter('[style="width:auto"]');
                if (!$content.length) return;

                const lesson = {
                    time: currentTime,
                    type: '',
                    name: '',
                    subgroup: '',
                    groups: [group],
                    auditory: '',
                    room: '',
                    teacher: ''
                };

                const elements = [];
                let buffer = '';

                $content.contents().each((_, el) => {
                    if (el.type === 'text') {
                        buffer += $(el).text();
                    } else if (el.name === 'br') {
                        const s = buffer.trim();
                        if (s) elements.push(s);
                        buffer = '';
                    } else if (el.name === 'a') {
                        const s = buffer.trim();
                        if (s) elements.push(s);
                        elements.push({ type: 'auditory', value: formatAuditoryName($(el).text()) });
                        buffer = '';
                    }
                });
                const tail = buffer.trim();
                if (tail) elements.push(tail);

                let hasType = false;
                elements.forEach((element) => {
                    if (typeof element === 'object') {
                        lesson.auditory = formatAuditoryDisplayName(element.value);
                        lesson.room = lesson.auditory;
                        return;
                    }

                    if (!hasType) {
                        const parts = element.split('.');
                        if (parts.length > 1 && VALID_LESSON_TYPES.has(parts[0].toLowerCase() + '.')) {
                            const fullNormalized = normalizeSubjectPrefix(element);
                            lesson.type = fullNormalized.split(/\s/)[0];
                            lesson.name = fullNormalized;
                            hasType = true;
                        } else {
                            lesson.name = element;
                            hasType = true;
                        }
                        return;
                    }

                    if (element.includes('п.г.')) {
                        lesson.subgroup = element.replace('п.г.', '').trim();
                        return;
                    }

                    const s = element.trim();
                    if (GROUP_REGEX.test(s) && !lesson.groups.includes(s)) {
                        lesson.groups.push(s);
                        return;
                    }

                    const matched = s.match(GROUP_REGEX_GLOBAL);
                    if (matched) {
                        matched.forEach((g) => {
                            if (!lesson.groups.includes(g)) lesson.groups.push(g);
                        });
                        return;
                    }

                    if (TEACHER_REGEX.test(s)) {
                        lesson.teacher = formatTeacherDisplayName(s.replace(/\.$/, ''));
                    }
                });

                if (subgroup !== undefined && subgroup !== null) {
                    const subgroupStr = String(subgroup);
                    if (lesson.subgroup && lesson.subgroup !== subgroupStr) return;
                }

                lesson.name = lesson.name ?? '';
                lesson.type = lesson.type ?? '';
                lesson.auditory = lesson.auditory ?? '';
                lesson.room = lesson.room ?? '';
                lesson.teacher = lesson.teacher ?? '';
                lesson.subgroup = lesson.subgroup ?? '';

                result[dateKey].lessons.push(lesson);
            });
        });

        return result;

    } catch (error) {
        console.error('parser error:', error.message);
        return null;
    }
}

module.exports = { parseStudent };
