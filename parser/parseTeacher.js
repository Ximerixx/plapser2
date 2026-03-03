const axios = require('axios');
const cheerio = require('cheerio');

const GROUP_REGEX = /^[А-ЯЁ]{2}\d-\d{3}-[А-ЯЁ]{2}$/;
const GROUP_REGEX_GLOBAL = /[А-ЯЁ]{2}\d-\d{3}-[А-ЯЁ]{2}/g;

async function parseTeacher(date, teacher) {
    if (!teacher) {
        throw new Error('Параметр "teacher" обязателен');
    }

    if (!date) {
        throw new Error('Не удалось определить дату');
    }

    const url = `https://kis.vgltu.ru/schedule?teacher=${encodeURIComponent(teacher)}&date=${date}`;
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);

    const result = {};

    // KIS отдает и "margin-bottom: 25px;" и "margin-bottom: 25px" без точки с запятой — ловим оба варианта
    $('div.table > div[style*="margin-bottom: 25px"]').each((i, block) => {
        const $block = $(block);
        const dateDiv = $block.find('> div').first();
        const dayDiv = dateDiv.next('div');

        const dateText = dateDiv.find('strong').text().trim();
        const dayOfWeek = dayDiv.text().trim();

        // Преобразуем дату в формат YYYY-MM-DD для ключа
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

        const rows = $block.find('table tbody tr');

        rows.each((j, row) => {
            const cells = $(row).find('td');

            if (cells.length === 1) {
                const text = $(cells[0]).text().trim();
                if (text.toLowerCase() === 'нет пар') {
                    result[dateKey].lessons.push({ status: 'Нет пар' });
                }
            } else if (cells.length === 2) {
                const time = $(cells[0]).text().trim();
                
                // Get all text content split by <br>
                const cellContent = $(cells[1]);
                const htmlContent = cellContent.html().split(/<br\s*\/?>/i).map(s => s.trim()).filter(Boolean);

                let subject = '';
                const groups = [];
                let subgroup = '';
                let room = '';

                // Parse each line of content (trim, skip empty; groups may have trailing space)
                htmlContent.forEach((line, index) => {
                    const s = $('<div>').html(line).text().trim();
                    if (s === '') return;

                    if (index === 0) {
                        subject = s;
                        return;
                    }
                    if (s.includes('п.г.')) {
                        subgroup = s;
                        return;
                    }
                    // One group (whole line)
                    if (GROUP_REGEX.test(s) && !groups.includes(s)) {
                        groups.push(s);
                        return;
                    }
                    // Several groups in one line
                    const matched = s.match(GROUP_REGEX_GLOBAL);
                    if (matched) {
                        matched.forEach((g) => {
                            if (!groups.includes(g)) groups.push(g);
                        });
                    }
                });

                // Extract room from link
                const link = cellContent.find('a').text().trim();
                if (link) {
                    room = link;
                }

                // Backward compatibility: group = first or joined; also expose groups array
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


// // usdap

// const fs = require('fs');
// async function main() {
//     const schedule = await parseTeacher('2025-04-28', 'Бордюжа О.Л.');
//     if (schedule) {
//         fs.writeFileSync('schedule.json', JSON.stringify(schedule, null, 2));
//         console.log(schedule);
//     }
// }

// main();



module.exports = { parseTeacher };
