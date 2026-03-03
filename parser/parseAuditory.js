const axios = require('axios');
const cheerio = require('cheerio');

// Auditory page uses 2-3 letter prefixes (ОИС1-242-ОП, ИС2-242-ОБ, ТО1-234-ОТ)
const GROUP_REGEX = /^[А-ЯЁ]{2,3}\d-\d{3}-[А-ЯЁ]{2}$/;
const GROUP_REGEX_GLOBAL = /[А-ЯЁ]{2,3}\d-\d{3}-[А-ЯЁ]{2}/g;
const VALID_LESSON_TYPES = new Set(['лек.', 'пр.', 'лаб.']);
const TEACHER_REGEX = /^[А-ЯЁ][а-яё]*\s[А-ЯЁ]\.[А-ЯЁ]\.?$/;

async function parseAuditory(date, auditory) {
    if (!auditory) {
        throw new Error('Параметр "auditory" обязателен');
    }

    if (!date) {
        throw new Error('Не удалось определить дату');
    }

    const url = `https://kis.vgltu.ru/schedule?auditory=${encodeURIComponent(auditory)}&date=${date}`;
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);

    const result = {};

    // Match both "margin-bottom: 25px;" and "margin-bottom: 25px" (no semicolon)
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

        const $rows = $block.find('table tbody tr').length ? $block.find('table tbody tr') : $block.find('table tr');

        $rows.each((j, row) => {
            const cells = $(row).find('td');

            if (cells.length === 1) {
                const text = $(cells[0]).text().trim();
                if (text.toLowerCase() === 'нет пар') {
                    result[dateKey].lessons.push({ status: 'Нет пар' });
                }
            } else if (cells.length === 2) {
                const time = $(cells[0]).text().trim();

                const cellContent = $(cells[1]);
                const htmlContent = cellContent.html().split(/<br\s*\/?>/i).map(s => s.trim()).filter(Boolean);

                let subjectLine = '';
                const groups = [];
                let subgroup = '';
                let room = '';
                let teacher = '';

                htmlContent.forEach((line, index) => {
                    const s = $('<div>').html(line).text().trim();
                    if (s === '') return;

                    if (index === 0) {
                        subjectLine = s;
                        return;
                    }
                    if (TEACHER_REGEX.test(s)) {
                        teacher = s.replace(/\.$/, '');
                        return;
                    }
                    if (s.includes('п.г.')) {
                        subgroup = s;
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
                    room = link;
                }

                let type = '';
                let name = subjectLine;
                const parts = subjectLine.split('.');
                if (parts.length > 1 && VALID_LESSON_TYPES.has(parts[0].trim().toLowerCase() + '.')) {
                    type = parts[0].trim() + '.';
                    name = parts.slice(1).join('.').trim();
                }

                result[dateKey].lessons.push({
                    time,
                    type,
                    name,
                    subject: name,
                    subgroup: subgroup || '',
                    groups: groups.length > 0 ? groups : [auditory],
                    group: groups.length > 0 ? groups.join(', ') : '',
                    classroom: room || auditory,
                    room: room || auditory,
                    teacher
                });
            }
        });
    });

    return result;
}

module.exports = { parseAuditory };
