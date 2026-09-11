# Сэмплы для нормализации

Клон `plapser2` (ветка `testing`) для отладки parse/normalize на реальных данных.

## Данные

- `data/groups/` — слоты из legacy `plapser.db` для `ИС2-244-ОБ`, `ИМ2-241-ОБ`
- `data/auditories/building-7.json` — кабинеты 116/117/119 (7 корпус), 307/307а
- `data/anomalies.json` — ручные кейсы (307Преп ≠ пр, формат преподавателей)

Обновить сэмплы из БД:

```bash
node samples/scripts/capture-from-db.js /path/to/plapser.db
```

## Тесты

```bash
npm test
```

## Проверка глазами

```bash
node -e "const {parseAuditoryParts}=require('./fusionloom/normalize/auditories'); console.log(parseAuditoryParts('307Преп/7К'))"
node -e "const {formatTeacherDisplayName}=require('./fusionloom/normalize/teachers'); console.log(formatTeacherDisplayName('Павлов А.Ю.'))"
```
