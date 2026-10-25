// Workout programs. A program is a list of days; each day a list of exercises (muscle, name, sets, target reps).
// Templates are shared; when a member gets a template, they get their own copy that they and their trainer edit.
const { db, tx } = require('./db');
const D = require('./dates');

const owner = (o) => (o.templateId ? ['template_id', o.templateId] : ['member_id', o.memberId]);

function load(o) {
  const [col, id] = owner(o);
  const days = db.prepare(`SELECT * FROM program_days WHERE ${col} = ? ORDER BY day_no`).all(id);
  const ex = db.prepare('SELECT * FROM program_exercises WHERE day_id = ? ORDER BY sort');
  return days.map((d) => ({ ...d, exercises: ex.all(d.id) }));
}

function copyDays(from, to) {
  const [toCol, toId] = owner(to);
  const addD = db.prepare(`INSERT INTO program_days (${toCol}, day_no, title, note) VALUES (?, ?, ?, ?)`);
  const addE = db.prepare('INSERT INTO program_exercises (day_id, sort, muscle, exercise, sets, reps) VALUES (?, ?, ?, ?, ?, ?)');
  for (const d of load(from)) {
    const did = addD.run(toId, d.day_no, d.title, d.note).lastInsertRowid;
    for (const e of d.exercises) addE.run(did, e.sort, e.muscle, e.exercise, e.sets, e.reps);
  }
}

// Replaces the member's program with a fresh copy of the template.
function assign(memberId, templateId) {
  tx(() => {
    db.prepare('DELETE FROM program_days WHERE member_id = ?').run(memberId);
    copyDays({ templateId }, { memberId });
    db.prepare('UPDATE members SET template_id = ?, last_day_no = NULL WHERE id = ?').run(templateId, memberId);
  });
}

function duplicate(templateId, name) {
  return tx(() => {
    const t = db.prepare('SELECT note FROM templates WHERE id = ?').get(templateId);
    const id = Number(db.prepare('INSERT INTO templates (name, note) VALUES (?, ?)').run(name, t ? t.note : '').lastInsertRowid);
    if (t) copyDays({ templateId }, { templateId: id });
    return id;
  });
}

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// rows: parallel arrays from the day form. A row with no exercise name is dropped (that's how you delete one).
function saveDay(dayId, body) {
  const arr = (k) => [].concat(body[k] ?? []);
  const names = arr('exercise');
  const rows = names.map((n, i) => ({
    exercise: clean(n, 80), muscle: clean(arr('muscle')[i], 60),
    sets: Math.min(10, Math.max(1, parseInt(arr('sets')[i], 10) || 3)), reps: clean(arr('reps')[i], 20) || '8-12',
  })).filter((r) => r.exercise);
  tx(() => {
    db.prepare('UPDATE program_days SET title = ?, note = ? WHERE id = ?').run(clean(body.title, 40), clean(body.note, 120), dayId);
    db.prepare('DELETE FROM program_exercises WHERE day_id = ?').run(dayId);
    const add = db.prepare('INSERT INTO program_exercises (day_id, sort, muscle, exercise, sets, reps) VALUES (?, ?, ?, ?, ?, ?)');
    rows.forEach((r, i) => add.run(dayId, i + 1, r.muscle, r.exercise, r.sets, r.reps));
  });
  touch(dayId);
  return rows.length;
}

function addDay(o) {
  const [col, id] = owner(o);
  const n = db.prepare(`SELECT COALESCE(MAX(day_no), 0) + 1 AS n FROM program_days WHERE ${col} = ?`).get(id).n;
  return Number(db.prepare(`INSERT INTO program_days (${col}, day_no) VALUES (?, ?)`).run(id, n).lastInsertRowid);
}

function deleteDay(dayId) {
  const d = db.prepare('SELECT * FROM program_days WHERE id = ?').get(dayId);
  if (!d) return;
  const [col, id] = d.template_id ? ['template_id', d.template_id] : ['member_id', d.member_id];
  tx(() => {
    db.prepare('DELETE FROM program_days WHERE id = ?').run(dayId);
    db.prepare(`UPDATE program_days SET day_no = day_no - 1 WHERE ${col} = ? AND day_no > ?`).run(id, d.day_no);
  });
  touch(null, d.template_id);
}

function touch(dayId, templateId = null) {
  const t = templateId || (dayId && db.prepare('SELECT template_id FROM program_days WHERE id = ?').get(dayId)?.template_id);
  if (t) db.prepare("UPDATE templates SET updated_at = datetime('now', 'localtime') WHERE id = ?").run(t);
}

// Who may edit a day: templates → admin/reception/trainer; a member's program → admin, their trainer, themselves.
function canEdit(user, day) {
  if (!user || !day) return false;
  if (day.template_id) return ['admin', 'reception', 'trainer'].includes(user.role);
  if (user.role === 'member') return user.id === day.member_id;
  if (user.role === 'admin') return true;
  if (user.role === 'trainer') return !!db.prepare('SELECT 1 FROM members WHERE id = ? AND trainer_id = ?').get(day.member_id, user.id);
  return false;
}

// Today's day: the one already being trained today, otherwise the next in rotation.
function todayDayNo(memberId, days) {
  if (!days.length) return null;
  const m = db.prepare('SELECT last_day_no FROM members WHERE id = ?').get(memberId);
  const trainedToday = db.prepare('SELECT 1 FROM workout_sets WHERE member_id = ? AND day = ?').get(memberId, D.today());
  const last = m && m.last_day_no;
  if (!last) return days[0].day_no;
  if (trainedToday) return last;
  return (last % days.length) + 1;
}

// Muscles of a day, short: 'صدر · ظهر' or, in English, 'Chest · Back' (the Excel names carry both languages)
const muscleName = (m, lang) => (lang === 'en' ? (m.match(/[A-Za-z][A-Za-z ]*[A-Za-z]/) || [m.split(' ')[0]])[0] : m.split(' ')[0]);
const summary = (day, lang = 'ar') => [...new Set(day.exercises.map((e) => muscleName(e.muscle, lang)).filter(Boolean))].join(' · ');

module.exports = { load, assign, duplicate, saveDay, addDay, deleteDay, canEdit, todayDayNo, summary };
