# app_manager — Android APK

Модуль загрузки и раздачи Android-сборок. Подключается к основному серверу одной строкой в `server.js`:

```javascript
require('./app_manager').mountAppManager(app);
```

Релизы лежат в `app_manager/data/app/android/` (в git не попадает).

---

## Быстрый старт

### 1. Конфиг на сервере

```bash
cp app_manager/config.example.json app_manager/config.json
```

Положите публичный ключ в `app_manager/keys/upload_public_1.pem` (или укажите другой путь в `UPLOAD_KEYS`).

### 2. Ключи

На CI / машине сборки (приватный ключ **не коммитить**):

```bash
./app_manager/scripts/generate-keys.sh 1 ./app_manager/keys
# upload_private_1.pem — оставить на CI
# upload_public_1.pem — скопировать на сервер
```

### 3. Сборка и загрузка релиза

```bash
# после подписи APK
./app_manager/scripts/pack-release.sh 42 release.zip

ORIGIN=https://your-origin \
PRIVATE_KEY_PATH=./upload_private_1.pem \
ZIP_PATH=release.zip \
node app_manager/scripts/upload-release.js
```

Скрипт загрузки сам подпишет ZIP и будет опрашивать статус до `done` или `error:`.

---

## API

| Метод | Путь | Auth | Ответ |
|-------|------|------|-------|
| GET | `/api/app/current` | нет | `v42` — текущий билд (text/plain) |
| GET | `/api/app/upload/status` | нет | статус upload-пайплайна (text/plain) |
| GET | `/api/app/android/` | нет | список файлов (directory listing) |
| GET | `/api/app/android/latest.apk` | нет | последний APK |
| GET | `/api/app/android/v42.apk` | нет | конкретная версия |
| GET | `/api/app/android/v42.changelog.md` | нет | changelog версии |
| POST | `/api/app/upload/android` | Ed25519 | JSON с метаданными релиза |

### `/api/app/current`

Клиент сравнивает свой билд с ответом сервера. Если не совпадает — есть обновление.

```
GET /api/app/current → v42
```

Если релизов ещё нет: `404` и текст `no releases`.

### `/api/app/upload/status`

Один активный upload за раз. Состояния:

```
idle
verified key 1
Got the ZIP
verified ZIP
installing
done
error: <причина>
```

`done` и `error: ...` висят 5 минут, потом снова `idle`. Параллельный POST во время работы → `409 upload pipeline busy`.

---

## Формат ZIP

Файлы только в корне архива, **без папок**:

```
release.zip
├── app-release.apk
├── changelog.md
└── v42          ← пустой маркер, версия из имени
```

- `v42` → билд `42`, на диске станет `v42.apk` и `v42.changelog.md`
- повторная загрузка того же билда → `409 build v42 already exists`

Переменные для `pack-release.sh`:

- `APK` — путь к APK (по умолчанию `app-release.apk`)
- `CHANGELOG` — путь к changelog (по умолчанию `changelog.md`)

---

## Аутентификация upload

Три обязательных заголовка:

| Заголовок | Значение |
|-----------|----------|
| `X-App-Key-Id` | ID ключа, например `1` |
| `X-App-Timestamp` | Unix time (секунды, UTC) |
| `X-App-Signature` | Base64, Ed25519 |

Подписывается canonical string (UTF-8):

```
{keyId}
{timestamp}
{sha256hex}
```

`sha256hex` — SHA-256 **файла ZIP** (не отдельных файлов внутри).

Тело запроса: `Content-Type: application/zip`, raw bytes архива.

Timestamp должен попадать в окно ±`TIMESTAMP_TOLERANCE_SEC` (по умолчанию 300 с).

---

## Что лежит на диске

```
app_manager/data/app/android/
  v42.apk
  v42.changelog.md
  v43.apk
  v43.changelog.md
  latest.apk              → v43.apk
  latest.changelog.md     → v43.changelog.md
```

---

## Конфиг

`app_manager/config.json` (шаблон — `config.example.json`):

| Поле | Описание |
|------|----------|
| `UPLOAD_KEYS` | Публичные ключи по ID |
| `TIMESTAMP_TOLERANCE_SEC` | Окно допустимого timestamp |
| `UPLOAD_MAX_MB` | Лимит размера ZIP |
| `STATUS_DONE_TTL_MS` | Сколько держать `done`/`error` (мс) |
| `ROUTES` | Пути эндпоинтов (обычно не трогать) |

Переопределение через env: `APP_MANAGER_UPLOAD_KEY_1_PATH`, `APP_MANAGER_UPLOAD_MAX_MB`, и т.д.

---

## nginx

Для upload нужен лимит тела:

```nginx
client_max_body_size 150m;
```

---

## Структура модуля

```
app_manager/
  config.json          # секреты/настройки (gitignored)
  keys/                # публичные ключи
  scripts/             # generate-keys, pack-release, upload-release
  data/                # релизы и temp (gitignored)
  *.js                 # логика модуля
```
