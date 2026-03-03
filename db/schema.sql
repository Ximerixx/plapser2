-- Plapser SQLite schema: schedule data and request stats (server-only)

-- Reference tables
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS classrooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Schedule slots: one row per lesson occurrence (denormalized per group for simple queries)
CREATE TABLE IF NOT EXISTS schedule_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  time_start TEXT NOT NULL,
  time_end TEXT NOT NULL,
  group_id INTEGER NOT NULL REFERENCES groups(id),
  teacher_id INTEGER REFERENCES teachers(id),
  subject_id INTEGER REFERENCES subjects(id),
  classroom_id INTEGER REFERENCES classrooms(id),
  lesson_type TEXT,
  subgroup TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_schedule_slots_group_date ON schedule_slots(group_id, date);
CREATE INDEX IF NOT EXISTS idx_schedule_slots_teacher_date ON schedule_slots(teacher_id, date);

-- Meta: "we already fetched this entity+date" and "no lessons" marker
CREATE TABLE IF NOT EXISTS schedule_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('group', 'teacher')),
  entity_key TEXT NOT NULL,
  date TEXT NOT NULL,
  no_lessons INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(entity_type, entity_key, date)
);

CREATE INDEX IF NOT EXISTS idx_schedule_meta_lookup ON schedule_meta(entity_type, entity_key, date);

-- Request stats (server-side analytics; not exposed to clients)
CREATE TABLE IF NOT EXISTS request_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT,
  user_agent TEXT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('group', 'teacher')),
  entity_key TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  processing_time_ms INTEGER NOT NULL,
  response_type TEXT
);

CREATE INDEX IF NOT EXISTS idx_request_stats_requested_at ON request_stats(requested_at);
CREATE INDEX IF NOT EXISTS idx_request_stats_entity ON request_stats(entity_type, entity_key);
