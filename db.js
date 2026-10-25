const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');

const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, 'gym.db'));
const SCHEMA_VERSION = 6;

const version = db.prepare('PRAGMA user_version').get().user_version;
if (version !== SCHEMA_VERSION && db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'members'").get()) {
  // ponytail: no migrations while this is a demo; add real migrations before the first real member is saved
  throw new Error('gym.db is from an older version. Delete gym.db (and gym.db-wal / gym.db-shm), then run "npm run seed".');
}

db.exec(`
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA user_version = ${SCHEMA_VERSION};

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'reception', 'trainer', 'cleaner')),
  fingerprint_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT (date('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('iron', 'kickboxing')),
  months INTEGER NOT NULL CHECK (months > 0),
  price REAL NOT NULL CHECK (price >= 0),
  active INTEGER NOT NULL DEFAULT 1
);

-- Ready-made workout plans (from the gym's Excel tables), editable by admin, reception and trainers
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  national_id TEXT NOT NULL UNIQUE CHECK (length(national_id) = 10),
  birth_date TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  trainer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  last_day_no INTEGER,
  password_hash TEXT,
  fingerprint_id INTEGER UNIQUE,
  goal_type TEXT NOT NULL DEFAULT '',
  goal_weight REAL,
  goal_pbf REAL,
  goal_date TEXT,
  target_days INTEGER NOT NULL DEFAULT 4,
  kcal INTEGER, protein INTEGER, carbs INTEGER, fat INTEGER, water REAL,
  notify_hours INTEGER NOT NULL DEFAULT 1,
  notify_absence INTEGER NOT NULL DEFAULT 1,
  notify_offers INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (date('now', 'localtime'))
);

-- plan name/category/price are copied so editing a plan never rewrites history
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  plan_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('iron', 'kickboxing')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL CHECK (end_date >= start_date),
  price REAL NOT NULL CHECK (price >= 0),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  amount REAL NOT NULL CHECK (amount > 0),
  note TEXT NOT NULL DEFAULT '',
  paid_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- One row per visit, opened by a fingerprint and closed by the next one.
-- gym_day: the 06:00→06:00 business day (see dates.gymDay)
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('iron', 'kickboxing')),
  gym_day TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  checked_out_at TEXT CHECK (checked_out_at >= checked_at),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
-- Iron: in and out as many times as they like. Kickboxing: one class a day.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_class_visit ON attendance(member_id, gym_day) WHERE category = 'kickboxing';
CREATE INDEX IF NOT EXISTS idx_att_member ON attendance(member_id, gym_day);

CREATE TABLE IF NOT EXISTS hours (
  category TEXT NOT NULL CHECK (category IN ('iron', 'kickboxing')),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  open TEXT NOT NULL,
  close TEXT NOT NULL,
  PRIMARY KEY (category, weekday)
);

-- category NULL = whole gym
CREATE TABLE IF NOT EXISTS closures (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  category TEXT CHECK (category IN ('iron', 'kickboxing')),
  closed INTEGER NOT NULL DEFAULT 1,
  open TEXT, close TEXT,
  note TEXT NOT NULL DEFAULT ''
);

-- A day of a program. Belongs to a template OR to one member (the member's own copy, edited by them and their trainer).
CREATE TABLE IF NOT EXISTS program_days (
  id INTEGER PRIMARY KEY,
  template_id INTEGER REFERENCES templates(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
  day_no INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  CHECK ((template_id IS NULL) != (member_id IS NULL))
);

CREATE TABLE IF NOT EXISTS program_exercises (
  id INTEGER PRIMARY KEY,
  day_id INTEGER NOT NULL REFERENCES program_days(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL,
  muscle TEXT NOT NULL DEFAULT '',
  exercise TEXT NOT NULL,
  sets INTEGER NOT NULL CHECK (sets BETWEEN 1 AND 10),
  reps TEXT NOT NULL DEFAULT '8-12'
);

CREATE TABLE IF NOT EXISTS otps (
  phone TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL
);

-- dedupe_key makes every reminder idempotent: the job can run as often as it likes
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT UNIQUE,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('supplement', 'accessory', 'drink')),
  price REAL NOT NULL CHECK (price >= 0),
  cost REAL NOT NULL CHECK (cost >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  low_stock INTEGER NOT NULL DEFAULT 3,
  expiry_date TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  total REAL NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash', 'account')),
  gym_day TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  price REAL NOT NULL,
  cost REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS inbody (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  weight REAL NOT NULL,
  smm REAL, bfm REAL, pbf REAL, bmi REAL, visceral INTEGER, bmr INTEGER, tbw REAL, score INTEGER,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS daily_logs (
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  nutrition TEXT CHECK (nutrition IN ('yes', 'partial', 'no')),
  water INTEGER,
  weight REAL,
  PRIMARY KEY (member_id, day)
);

-- Each set's weight. Reps only on the last set (the failure set). is_pr: heavier than anything before.
CREATE TABLE IF NOT EXISTS workout_sets (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  exercise TEXT NOT NULL,
  set_no INTEGER NOT NULL CHECK (set_no > 0),
  weight REAL NOT NULL CHECK (weight >= 0),
  reps INTEGER CHECK (reps > 0),
  is_pr INTEGER NOT NULL DEFAULT 0
);

-- Staff clock in/out by fingerprint (same device as members)
CREATE TABLE IF NOT EXISTS staff_shifts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clock_in TEXT NOT NULL,
  clock_out TEXT CHECK (clock_out >= clock_in)
);

CREATE TABLE IF NOT EXISTS cleaning_tasks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

-- one tick per task per gym day
CREATE TABLE IF NOT EXISTS cleaning_done (
  task_id INTEGER NOT NULL REFERENCES cleaning_tasks(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  done_at TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (task_id, day)
);

CREATE INDEX IF NOT EXISTS idx_days_template ON program_days(template_id, day_no);
CREATE INDEX IF NOT EXISTS idx_days_member ON program_days(member_id, day_no);
CREATE INDEX IF NOT EXISTS idx_ex_day ON program_exercises(day_id, sort);
CREATE INDEX IF NOT EXISTS idx_shifts_user ON staff_shifts(user_id, clock_in);
CREATE INDEX IF NOT EXISTS idx_subs_member ON subscriptions(member_id, category, end_date);
CREATE INDEX IF NOT EXISTS idx_pay_member ON payments(member_id);
CREATE INDEX IF NOT EXISTS idx_att_day ON attendance(gym_day);
CREATE INDEX IF NOT EXISTS idx_sales_member ON sales(member_id, method);
CREATE INDEX IF NOT EXISTS idx_notif_member ON notifications(member_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_inbody_member ON inbody(member_id, day);
CREATE INDEX IF NOT EXISTS idx_sets_member ON workout_sets(member_id, exercise, day);
`);

if (!db.prepare('SELECT 1 FROM plans LIMIT 1').get()) {
  const add = db.prepare('INSERT INTO plans (name, category, months, price) VALUES (?, ?, ?, ?)');
  add.run('حديد - شهر', 'iron', 1, 30);
  add.run('حديد - 3 أشهر', 'iron', 3, 55);
  add.run('كيك بوكسينج - شهر', 'kickboxing', 1, 25);
  add.run('كيك بوكسينج - 3 أشهر', 'kickboxing', 3, 50);
}

// IRON MAN hours. weekday: 0 = Sunday ... 6 = Saturday
if (!db.prepare('SELECT 1 FROM hours LIMIT 1').get()) {
  const add = db.prepare('INSERT INTO hours (category, weekday, open, close) VALUES (?, ?, ?, ?)');
  for (const wd of [0, 1, 2, 3, 6]) add.run('iron', wd, '15:30', '06:00');
  add.run('iron', 4, '15:30', '01:00');
  add.run('iron', 5, '18:00', '21:00');
  for (const wd of [0, 2, 4]) add.run('kickboxing', wd, '19:30', '21:00');
}

if (!db.prepare('SELECT 1 FROM cleaning_tasks LIMIT 1').get()) {
  const add = db.prepare('INSERT INTO cleaning_tasks (name, sort) VALUES (?, ?)');
  ['تنظيف الحمامات', 'غرف تبديل الملابس', 'مسح أرضية صالة الحديد', 'تعقيم الأجهزة والمقاعد', 'تنظيف المرايا', 'صالة الكيك بوكسينج والأكياس', 'تفريغ سلال النفايات', 'تعبئة الماء والمناديل']
    .forEach((name, i) => add.run(name, i));
}

// The gym's 8 Excel workout tables, converted once into data/templates.json
if (!db.prepare('SELECT 1 FROM templates LIMIT 1').get()) {
  const addT = db.prepare('INSERT INTO templates (name, note) VALUES (?, ?)');
  const addD = db.prepare('INSERT INTO program_days (template_id, day_no, title, note) VALUES (?, ?, ?, ?)');
  const addE = db.prepare('INSERT INTO program_exercises (day_id, sort, muscle, exercise, sets, reps) VALUES (?, ?, ?, ?, ?, ?)');
  for (const t of require('./data/templates.json')) {
    const tid = addT.run(t.name, t.note).lastInsertRowid;
    t.days.forEach((d, i) => {
      const did = addD.run(tid, i + 1, d.title, d.note).lastInsertRowid;
      d.exercises.forEach((e, k) => addE.run(did, k + 1, e.muscle, e.exercise, e.sets, e.reps));
    });
  }
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}

function checkPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const got = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

function tx(fn) {
  if (db.isTransaction) return fn(); // already inside one (e.g. seed): join it
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

const scheduleData = () => ({
  hours: db.prepare('SELECT * FROM hours').all(),
  closures: db.prepare("SELECT * FROM closures WHERE day >= date('now', 'localtime', '-2 days') ORDER BY id").all(),
});

module.exports = { db, hashPassword, checkPassword, tx, scheduleData };
