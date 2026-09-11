const cheerio = require('cheerio');
const { normalizeSubjectPrefix } = require('./normalizeSubject');
const { kisGet } = require('./kisGet');

const GROUP_REGEX = /^[А-ЯЁ]{2,3}\d-\d{2}\d-[А-ЯЁ]{2,4}$/iu;
const GROUP_REGEX_GLOBAL = /[А-ЯЁ]{2,3}\d-\d{2}\d-[А-ЯЁ]{2,4}/giu;
const TEACHER_REGEX = /^[А-ЯЁ][а-яё]*\s[А-ЯЁ]\.[А-ЯЁ]\.?$/;

const { kisAuditoryQueryName } = require('./normalizeAuditory');

async function parseTeacher(date, teacher, opts = null) {
    if (!teacher) {
        throw new Error('Параметр "teacher" обязателен');
    }

    if (!date) {
        throw new Error('Не удалось определить дату');
    }

    const url = `https://kis.vgltu.ru/schedule?teacher=${encodeURIComponent(teacher)}&date=${date}`;
    const response = await kisGet(url, opts);
    const $ = cheerio.load(response.data);

    const result = {};

    $('div.table > div[style*="margin-bottom: 25px"]').each((i, block) => {
        const $block = $(block);
        const dateDiv = $block.find('> div').first();
        const dayDiv = dateDiv.next('div');

        const dateText = dateDiv.find('strong').text().trim();
        const dayOfWeek = dayDiv.text().trim();

        const [day, monthStr, year] = dateText.split(' ');
        const months = {
            'января': '01', 'февраля': '02', 'марта': '03', 'апреля': '04',
            'мая': '05', 'июня': '06', 'июля': '07', 'августа': '08',
            'сентября': '09', 'октября': '10', 'ноября': '11', 'декабря': '12'
        };
        const month = months[monthStr];
        const dateKey = `${year}-${month}-${day.padStart(2, '0')}`;

        result[dateKey] = {
            date: dateText,
            dayOfWeek: dayOfWeek,
            lessons: []
        };

        const rows = $block.find('table tbody tr').length
            ? $block.find('table tbody tr')
            : $block.find('table tr');

        rows.each((j, row) => {
            const cells = $(row).find('td');

            if (cells.length === 1) {
                const text = $(cells[0]).text().trim();
                if (text.toLowerCase() === 'нет пар') {
                    result[dateKey].lessons.push({ status: 'Нет пар' });
                }
            } else if (cells.length === 2) {
                const time = $(cells[0]).text().trim().replace(/\s+/g, ' ');

                const cellContent = $(cells[1]);
                const htmlContent = cellContent.html().split(/<br\s*\/?>/i).map(s => s.trim()).filter(Boolean);

                let subject = '';
                const groups = [];
                let subgroup = '';
                let room = '';

                htmlContent.forEach((line, index) => {
                    const s = $('<div>').html(line).text().trim();
                    if (s === '') return;

                    if (index === 0) {
                        subject = normalizeSubjectPrefix(s);
                        return;
                    }
                    if (s.includes('п.г.')) {
                        subgroup = s;
                        return;
                    }
                    if (TEACHER_REGEX.test(s)) {
                        return;
                    }
                    if (GROUP_REGEX.test(s) && !groups.includes(s)) {
                        groups.push(s);
                        return;
                    }
                    const matched = s.match(GROUP_REGEX_GLOBAL);
                    if (matched) {
                        matched.forEach((g) => {
                            if (!groups.includes(g)) groups.push(g);
                        });
                    }
                });

                const link = cellContent.find('a').text().trim();
                if (link) {
                    room = kisAuditoryQueryName(link);
                }

                const group = groups.length > 0 ? groups.join(', ') : (subgroup || '');

                result[dateKey].lessons.push({
                    time,
                    subject,
                    group,
                    groups: groups.length > 0 ? groups : undefined,
                    auditory: room,
                    room,
                    subgroup: subgroup || null
                });
            }
        });
    });

    return result;
}

module.exports = { parseTeacher };
