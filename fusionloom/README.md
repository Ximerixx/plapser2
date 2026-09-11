# fusionloom

Слой домена расписания: registry (canon + aliases), fusion занятий, SQLite (`fusionloom.db`).

**Приложение** (server, tgbot) ходит только через `jsapi.js`. Прямые `require('./fusionloom/...')` — только внутри jsapi, тестах и скриптах обслуживания.

## fusion_key

```
date|time_start|time_end|subject_id|auditory_id|subgroup
```

Подгруппа входит в ключ (`1` = `1 п.г.`). Группы и преподаватели — через junction-таблицы.

## Нормализация

Единый источник: `fusionloom/normalize/*` (группы, преподы, аудитории, предметы, encoding).

Парсеры подключают через тонкие re-export в `parser/normalizeAuditory.js`, `parseGroupName.js`, `normalizeSubject.js`.
Выдача из БД: `fusionloom/read.js` (display names, «Спортзал» и т.д.).

## Env

- `FUSIONLOOM_DB_PATH` — путь к БД (default `fusionloom/data/fusionloom.db`)

## Скрипты

```bash
node fusionloom/test-fuse.js
npm test
node scripts/fusionloom-migrate-legacy.js /root/plapser2/db/plapser.db
node scripts/kis-html-eye-compare.js 2026-09-08 5
```
