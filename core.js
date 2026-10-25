// Business rules shared by staff pages, the member app, the fingerprint device, and the reminder job.
const { db, tx, scheduleData } = require('./db');
const D = require('./dates');
const S = require('./schedule');

// Labels are Arabic keys; views get them translated (see app.js).
const CATS = { iron: 'حديد', kickboxing: 'كيك بوكسينج' };
const STATUS = { active: 'فعّال', expiring: 'ينتهي قريباً', expired: 'منتهٍ', upcoming: 'يبدأ قريباً', none: 'بلا اشتراك' };
const ROLES = { admin: 'مدير', reception: 'استقبال', trainer: 'مدرّب', cleaner: 'عامل نظافة', member: 'مشترك' };
const PRODUCT_TYPES = { supplement: 'مكمّلات', accessory: 'إكسسوارات', drink: 'مشروبات' };
const GOALS = { fat_loss: 'خسارة الدهون', muscle: 'بناء العضلات', fitness: 'لياقة عامة', competition: 'التحضير لبطولة', weight_gain: 'زيادة الوزن' };
const round2 = (n) => Math.round((n || 0) * 100) / 100;
const money = (n) => ['{n} د.أ', { n: round2(n) }];
const maskId = (nid) => `******${String(nid).slice(-4)}`;

// ---- Text typed on phones ----
// Phone keyboards type Arabic-Indic digits (٠٧٩...), slip invisible direction marks into fields on an RTL page,
// and turn "-" into look-alike dashes. Normalise all of that before comparing.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩', PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const latinDigits = (s) => String(s ?? '').replace(/[٠-٩۰-۹]/g, (d) => String(ARABIC_DIGITS.includes(d) ? ARABIC_DIGITS.indexOf(d) : PERSIAN_DIGITS.indexOf(d)));
const cleanInput = (s) => latinDigits(String(s ?? '').normalize('NFKC').replace(INVISIBLE, '')).trim();
const normPhone = (p) => cleanInput(p).replace(/[\s-]/g, '').replace(/^(\+|00)?962/, '0').replace(/^7\d{8}$/, (x) => '0' + x);
// A second chance for a password a keyboard mangled. The password as typed is always tried first.
const forgivingPassword = (s) => String(s ?? '').normalize('NFKC').replace(INVISIBLE, '').replace(/[\u2010-\u2015\u2212]/g, '-').trim();

// Status per category for many members. Renewals are contiguous (see D.renewalStart),
// so "covering today" + latest end_date gives the effective period.
function statusMap(memberIds) {
  const t = D.today();
  const ids = new Set(memberIds);
  const rows = db.prepare(`
    SELECT s.member_id, s.category, s.start_date, MAX(s.end_date) AS end_date,
      EXISTS(SELECT 1 FROM subscriptions c WHERE c.member_id = s.member_id AND c.category = s.category
             AND c.start_date <= ? AND c.end_date >= ?) AS covering
    FROM subscriptions s GROUP BY s.member_id, s.category`).all(t, t);
  const map = new Map(memberIds.map((id) => [id, {}]));
  for (const r of rows) {
    if (!ids.has(r.member_id)) continue;
    const status = D.status({ start_date: r.covering ? t : r.start_date, end_date: r.end_date }, t);
    map.get(r.member_id)[r.category] = { status, end_date: r.end_date, days: D.daysBetween(t, r.end_date) };
  }
  for (const s of map.values()) {
    Object.defineProperty(s, 'overall', { enumerable: false, value: ['active', 'expiring', 'upcoming', 'expired'].find((st) => Object.values(s).some((c) => c.status === st)) || 'none' });
  }
  return map;
}
const isValid = (c) => c && (c.status === 'active' || c.status === 'expiring');

// Owed = subscriptions + shop purchases on account - payments
const balanceSql = `ROUND(COALESCE((SELECT SUM(price) FROM subscriptions WHERE member_id = m.id), 0)
  + COALESCE((SELECT SUM(total) FROM sales WHERE member_id = m.id AND method = 'account'), 0)
  - COALESCE((SELECT SUM(amount) FROM payments WHERE member_id = m.id), 0), 2)`;

const parseAmount = (v) => { const n = Math.round(Number(v) * 100) / 100; return Number.isFinite(n) && n > 0 ? n : null; };
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

function addSubscription(memberId, planId, paid, userId) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND active = 1').get(Number(planId));
  if (!plan) return { error: 'اختر باقة صحيحة.' };
  const { end } = db.prepare('SELECT MAX(end_date) AS end FROM subscriptions WHERE member_id = ? AND category = ?').get(memberId, plan.category);
  const start = D.renewalStart(end);
  tx(() => {
    db.prepare(`INSERT INTO subscriptions (member_id, plan_name, category, start_date, end_date, price, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(memberId, plan.name, plan.category, start, D.endDate(start, plan.months), plan.price, userId);
    if (paid) db.prepare('INSERT INTO payments (member_id, amount, note, paid_at, created_by) VALUES (?, ?, ?, ?, ?)').run(memberId, paid, plan.name, D.today(), userId);
  });
  return { plan, start };
}

// ---- Fingerprint: first punch = check in, next punch = check out ----

// ponytail: a visit nobody punched out of stops counting after 5 hours and gets no duration; a real device auto-checkout could replace this
const OPEN_MAX_H = 5;
const minutes = (from, to) => Math.max(0, Math.round((new Date(to.replace(' ', 'T')) - new Date(from.replace(' ', 'T'))) / 60000));
const fmtDur = (min) => (min >= 60 ? ['{h} س {m} د', { h: Math.floor(min / 60), m: min % 60 }] : ['{m} د', { m: min }]);

const openVisit = (memberId, now = new Date()) => db.prepare(`SELECT * FROM attendance WHERE member_id = ? AND checked_out_at IS NULL
  AND checked_at >= ? ORDER BY id DESC LIMIT 1`).get(memberId, D.stamp(new Date(now - OPEN_MAX_H * 3600000)));

// Returns { type: 'ok' | 'out' | 'warn' | 'deny', text, detail?, member? } — text/detail are i18n messages
function punch(memberId, { by = null, now = new Date() } = {}) {
  const m = db.prepare('SELECT id, name, fingerprint_id FROM members WHERE id = ?').get(memberId);
  if (!m) return { type: 'deny', text: 'البصمة غير معروفة' };
  if (!m.fingerprint_id) return { type: 'deny', member: m.id, text: ['{name}: لا توجد له بصمة مسجّلة', { name: m.name }], detail: 'سجّل رقم بصمته من ملفه أولاً' };
  const open = openVisit(m.id, now);
  if (open) {
    const out = D.stamp(now);
    db.prepare('UPDATE attendance SET checked_out_at = ? WHERE id = ?').run(out, open.id);
    return { type: 'out', member: m.id, text: ['مع السلامة {name} 👋', { name: m.name }], detail: [[CATS[open.category]], ['مدة التمرين {d}', { d: fmtDur(minutes(open.checked_at, out)) }]] };
  }
  return checkIn(m, { by, now });
}

function checkIn(m, { by = null, now = new Date() } = {}) {
  const s = statusMap([m.id]).get(m.id);
  const valid = Object.keys(CATS).filter((c) => isValid(s[c]));
  const sched = scheduleData();
  const base = { member: m.id };
  if (!valid.length) return { ...base, type: 'deny', text: ['{name}: لا يوجد اشتراك فعّال', { name: m.name }], detail: 'يجب التجديد عند الاستقبال' };

  const openNow = valid.filter((c) => S.current(sched, c, now));
  if (!openNow.length) {
    const why = valid.map((c) => ['{cat}: {state}', { cat: CATS[c], state: S.label(sched, c, now).text }]);
    return { ...base, type: 'deny', text: [valid.length === 1 && valid[0] === 'kickboxing' ? '{name}: لا توجد حصة كيك بوكسينج الآن' : '{name}: النادي مغلق الآن', { name: m.name }], detail: why };
  }
  const day = D.gymDay(now);
  const visitsToday = db.prepare("SELECT COUNT(*) AS n FROM attendance WHERE member_id = ? AND gym_day = ? AND category = 'iron'").get(m.id, day).n;
  const done = db.prepare('SELECT category FROM attendance WHERE member_id = ? AND gym_day = ?').all(m.id, day).map((x) => x.category);
  const cats = openNow.filter((c) => c === 'iron' || !done.includes(c));
  if (!cats.length) return { ...base, type: 'warn', text: ['{name} حضر حصة الكيك بوكسينج اليوم', { name: m.name }], detail: 'الحصة مرة واحدة في اليوم' };
  // Both sections open: the class wins during class time.
  const cat = cats.includes('kickboxing') ? 'kickboxing' : cats[0];
  db.prepare('INSERT INTO attendance (member_id, category, gym_day, checked_at, created_by) VALUES (?, ?, ?, ?, ?)').run(m.id, cat, day, D.stamp(now), by);
  const c = s[cat];
  return { ...base, type: 'ok', text: ['أهلاً {name}', { name: m.name }], detail: [
    [CATS[cat]], ['متبقٍّ {n} يوم', { n: c.days }],
    cat === 'iron' && visitsToday ? ['الدخول رقم {n} اليوم', { n: visitsToday + 1 }] : null,
    c.status === 'expiring' ? ['⚠️ ينتهي قريباً'] : null,
  ] };
}

// ---- Staff clock in/out (any staff with a fingerprint) ----
// ponytail: a shift nobody clocked out of stays open for 16 hours, then the next punch starts a new one
const SHIFT_MAX_H = 16;
const openShift = (userId, now = new Date()) => db.prepare(`SELECT * FROM staff_shifts WHERE user_id = ? AND clock_out IS NULL AND clock_in >= ?
  ORDER BY id DESC LIMIT 1`).get(userId, D.stamp(new Date(now - SHIFT_MAX_H * 3600000)));

function punchStaff(userId, { now = new Date() } = {}) {
  const u = db.prepare('SELECT id, name, fingerprint_id FROM users WHERE id = ?').get(userId);
  if (!u || !u.fingerprint_id) return { type: 'deny', text: 'البصمة غير مرتبطة بأي موظف' };
  const open = openShift(u.id, now);
  if (open) {
    const out = D.stamp(now);
    db.prepare('UPDATE staff_shifts SET clock_out = ? WHERE id = ?').run(out, open.id);
    return { type: 'out', text: ['{name}: نهاية الدوام 👋', { name: u.name }], detail: ['مدة العمل {d}', { d: fmtDur(minutes(open.clock_in, out)) }] };
  }
  db.prepare('INSERT INTO staff_shifts (user_id, clock_in) VALUES (?, ?)').run(u.id, D.stamp(now));
  return { type: 'ok', text: ['{name}: بداية الدوام', { name: u.name }], detail: ['الساعة {t}', { t: D.stamp(now).slice(11, 16) }] };
}

// One fingerprint number = one person, across members and staff (they share the device).
function fingerprintOwner(fid, { memberId = 0, userId = 0 } = {}) {
  if (fid == null) return null;
  const m = db.prepare('SELECT name FROM members WHERE fingerprint_id = ? AND id != ?').get(fid, memberId);
  const u = db.prepare('SELECT name FROM users WHERE fingerprint_id = ? AND id != ?').get(fid, userId);
  return (m || u || {}).name || null;
}

// ---- Workout log: weight for every set, reps only on the last (failure) set ----

const cleanExercise = (x) => String(x || '').trim().replace(/\s+/g, ' ').slice(0, 80);

// Previous session of this exercise (before `day`), for "last time" hints and comparison.
function lastSession(memberId, exercise, day = D.today()) {
  const prev = db.prepare('SELECT MAX(day) AS d FROM workout_sets WHERE member_id = ? AND exercise = ? AND day < ?').get(memberId, exercise, day).d;
  return prev ? db.prepare('SELECT * FROM workout_sets WHERE member_id = ? AND exercise = ? AND day = ? ORDER BY set_no').all(memberId, exercise, prev) : [];
}

function saveExercise(memberId, exercise, weights, lastReps, day = D.today()) {
  const prevMax = db.prepare('SELECT MAX(weight) AS w FROM workout_sets WHERE member_id = ? AND exercise = ?').get(memberId, exercise).w;
  const prev = lastSession(memberId, exercise, day);
  const prevLast = prev[prev.length - 1];
  const startNo = db.prepare('SELECT COALESCE(MAX(set_no), 0) AS n FROM workout_sets WHERE member_id = ? AND exercise = ? AND day = ?').get(memberId, exercise, day).n;
  let best = prevMax;
  const ins = db.prepare('INSERT INTO workout_sets (member_id, day, exercise, set_no, weight, reps, is_pr) VALUES (?, ?, ?, ?, ?, ?, ?)');
  tx(() => weights.forEach((w, i) => {
    const pr = best != null && w > best;
    if (best == null || w > best) best = w;
    ins.run(memberId, day, exercise, startNo + i + 1, w, i === weights.length - 1 ? lastReps : null, pr ? 1 : 0);
  }));
  const top = Math.max(...weights), last = weights[weights.length - 1];
  return {
    first: prevMax == null,
    pr: prevMax != null && top > prevMax, top, prevMax,
    moreReps: !!prevLast && last === prevLast.weight && lastReps > (prevLast.reps || 0), prevLast,
  };
}

// Weekly adherence over the last 7 gym days, 0-100.
// 40% attendance vs target days, 30% days with a logged workout, 30% nutrition (yes = 1, partial = 0.5).
function adherence(memberId, targetDays = 4, today = D.today()) {
  const from = D.addDays(today, -6);
  const visits = db.prepare('SELECT COUNT(DISTINCT gym_day) AS n FROM attendance WHERE member_id = ? AND gym_day BETWEEN ? AND ?').get(memberId, from, today).n;
  const workouts = db.prepare('SELECT COUNT(DISTINCT day) AS n FROM workout_sets WHERE member_id = ? AND day BETWEEN ? AND ?').get(memberId, from, today).n;
  const logs = db.prepare('SELECT nutrition FROM daily_logs WHERE member_id = ? AND day BETWEEN ? AND ?').all(memberId, from, today);
  return scoreWeek({ visits, workouts, nutrition: logs.map((l) => l.nutrition), targetDays });
}

function scoreWeek({ visits, workouts, nutrition, targetDays }) {
  const target = Math.max(1, targetDays || 4);
  const att = Math.min(1, visits / target);
  const wo = Math.min(1, workouts / target);
  const nut = nutrition.reduce((a, n) => a + (n === 'yes' ? 1 : n === 'partial' ? 0.5 : 0), 0) / 7;
  return { score: Math.round(40 * att + 30 * wo + 30 * nut), visits, workouts, target };
}

module.exports = { cleanInput, normPhone, forgivingPassword, round2, CATS, STATUS, ROLES, PRODUCT_TYPES, GOALS, money, maskId, statusMap, isValid, balanceSql, parseAmount, num, addSubscription, punch, openVisit, minutes, fmtDur, OPEN_MAX_H, cleanExercise, lastSession, saveExercise, punchStaff, openShift, fingerprintOwner, adherence, scoreWeek };
