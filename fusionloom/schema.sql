-- fusionloom SQLite schema (full replacement for plapser.db after cutover)

-- Sources
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

INSERT OR IGNORE INTO sources (code, name) VALUES ('kis', 'KIS VGLTU');

-- Registry: groups
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  canonical_key TEXT NOT NULL UNIQUE,
  specialty TEXT,
  admission_year INTEGER,
  group_index INTEGER,
  form TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS group_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id),
  raw_name TEXT NOT NULL UNIQUE,
  source_code TEXT NOT NULL DEFAULT 'kis',
  first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_group_aliases_group ON group_aliases(group_id);
CREATE INDEX IF NOT EXISTS idx_group_aliases_raw ON group_aliases(raw_name);

-- Registry: teachers
CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  canonical_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS teacher_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  raw_name TEXT NOT NULL UNIQUE,
  source_code TEXT NOT NULL DEFAULT 'kis',
  first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_teacher_aliases_teacher ON teacher_aliases(teacher_id);
CREATE INDEX IF NOT EXISTS idx_teacher_aliases_raw ON teacher_aliases(raw_name);

-- Registry: subjects
CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  canonical_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS subject_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  raw_name TEXT NOT NULL UNIQUE,
  source_code TEXT NOT NULL DEFAULT 'kis',
  first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_subject_aliases_subject ON subject_aliases(subject_id);
CREATE INDEX IF NOT EXISTS idx_subject_aliases_raw ON subject_aliases(raw_name);

-- Registry: auditories
CREATE TABLE IF NOT EXISTS auditories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  canonical_key TEXT NOT NULL UNIQUE,
  room_number TEXT,
  room_type TEXT,
  building TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS auditory_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auditory_id INTEGER NOT NULL REFERENCES auditories(id),
  raw_name TEXT NOT NULL UNIQUE,
  source_code TEXT NOT NULL DEFAULT 'kis',
  first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_auditory_aliases_auditory ON auditory_aliases(auditory_id);
CREATE INDEX IF NOT EXISTS idx_auditory_aliases_raw ON auditory_aliases(raw_name);
CREATE INDEX IF NOT EXISTS idx_auditories_building ON auditories(building);
CREATE INDEX IF NOT EXISTS idx_auditories_room_type ON auditories(room_type);

-- Canonical lessons
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  time_start TEXT NOT NULL,
  time_end TEXT NOT NULL,
  subject_id INTEGER REFERENCES subjects(id),
  lesson_type TEXT,
  subgroup TEXT,
  fusion_key TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(date, time_start, time_end, fusion_key)
);

CREATE INDEX IF NOT EXISTS idx_lessons_date ON lessons(date, time_start, time_end);

CREATE TABLE IF NOT EXISTS lesson_groups (
  lesson_id INTEGER NOT NULL REFERENCES lessons(id),
  group_id INTEGER NOT NULL REFERENCES groups(id),
  PRIMARY KEY (lesson_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_lesson_groups_group ON lesson_groups(group_id, lesson_id);

CREATE TABLE IF NOT EXISTS lesson_teachers (
  lesson_id INTEGER NOT NULL REFERENCES lessons(id),
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  PRIMARY KEY (lesson_id, teacher_id)
);

CREATE INDEX IF NOT EXISTS idx_lesson_teachers_teacher ON lesson_teachers(teacher_id, lesson_id);

CREATE TABLE IF NOT EXISTS lesson_auditories (
  lesson_id INTEGER NOT NULL REFERENCES lessons(id),
  auditory_id INTEGER NOT NULL REFERENCES auditories(id),
  PRIMARY KEY (lesson_id, auditory_id)
);

CREATE INDEX IF NOT EXISTS idx_lesson_auditories_auditory ON lesson_auditories(auditory_id, lesson_id);

-- Provenance
CREATE TABLE IF NOT EXISTS ingest_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  view_type TEXT NOT NULL CHECK (view_type IN ('group', 'teacher', 'auditory')),
  view_key TEXT NOT NULL,
  anchor_date TEXT NOT NULL,
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
  request_stats_id INTEGER,
  status TEXT NOT NULL DEFAULT 'ok',
  lessons_seen INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ingest_batches_view ON ingest_batches(view_type, view_key, anchor_date);

CREATE TABLE IF NOT EXISTS lesson_ingest (
  lesson_id INTEGER NOT NULL REFERENCES lessons(id),
  batch_id INTEGER NOT NULL REFERENCES ingest_batches(id),
  PRIMARY KEY (lesson_id, batch_id)
);

-- Schedule coverage meta
CREATE TABLE IF NOT EXISTS schedule_meta (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('group', 'teacher', 'auditory')),
  entity_key TEXT NOT NULL,
  date TEXT NOT NULL,
  no_lessons INTEGER NOT NULL DEFAULT 0,
  last_batch_id INTEGER REFERENCES ingest_batches(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (entity_type, entity_key, date)
);

CREATE INDEX IF NOT EXISTS idx_schedule_meta_lookup ON schedule_meta(entity_type, entity_key, date);

-- Ops (legacy-compatible)
CREATE TABLE IF NOT EXISTS request_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT,
  user_agent TEXT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('group', 'teacher', 'auditory')),
  entity_key TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  processing_time_ms INTEGER NOT NULL,
  response_type TEXT,
  source TEXT NOT NULL DEFAULT 'cache' CHECK (source IN ('cache', 'db', 'source', 'source_asked'))
);

CREATE INDEX IF NOT EXISTS idx_request_stats_requested_at ON request_stats(requested_at);
CREATE INDEX IF NOT EXISTS idx_request_stats_entity ON request_stats(entity_type, entity_key);

CREATE TABLE IF NOT EXISTS preload_state (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('group', 'teacher', 'auditory')),
  entity_key TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  last_preloaded_at INTEGER,
  PRIMARY KEY (entity_type, entity_key)
);

-- Telegram bot tables
CREATE TABLE IF NOT EXISTS tgbot_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('group', 'private')),
  chat_id TEXT,
  user_id TEXT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('group', 'teacher', 'auditory')),
  entity_key TEXT NOT NULL,
  to_send_time TEXT NOT NULL DEFAULT '07:00',
  silent INTEGER NOT NULL DEFAULT 0,
  requested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tgbot_subs_chat ON tgbot_subscriptions(chat_id);
CREATE INDEX IF NOT EXISTS idx_tgbot_subs_user ON tgbot_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_tgbot_subs_due ON tgbot_subscriptions(to_send_time);

CREATE TABLE IF NOT EXISTS tgbot_prefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  chat_id TEXT,
  lang TEXT NOT NULL CHECK (lang IN ('ru', 'en')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id),
  UNIQUE(chat_id)
);

CREATE TABLE IF NOT EXISTS tgbot_inline_lut (
  code TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('group', 'teacher', 'auditory')),
  entity_key TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('today', 'week', 'tomorrow')),
  lang TEXT NOT NULL CHECK (lang IN ('ru', 'en')),
  UNIQUE(entity_type, entity_key, scope, lang)
);
