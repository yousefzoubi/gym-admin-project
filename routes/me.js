// The member app (installable PWA). Every query is scoped to req.session.user.id = the member's own id.
const express = require('express');
const { db, hashPassword, checkPassword, scheduleData } = require('../db');
const D = require('../dates');
const S = require('../schedule');
const C = require('../core');
const { flash, allow, DEMO } = require('../mw');
const { workoutHistory, personalBests } = require('./staff');
const P = require('../programs');

const r = express.Router();
r.use('/me', allow('member'));
const { CATS, balanceSql, num } = C;
const me = (req) => db.prepare(`SELECT m.*, ${balanceSql} AS balance, u.name AS trainer_name
  FROM members m LEFT JOIN users u ON u.id = m.trainer_id WHERE m.id = ?`).get(req.session.user.id);

r.get('/me', (req, res) => {
  const m = me(req);
  const s = C.statusMap([m.id]).get(m.id);
  const sched = scheduleData();
  const mine = Object.keys(CATS).filter((c) => s[c]);
  const streak = (() => {
    const days = new Set(db.prepare('SELECT DISTINCT gym_day FROM attendance WHERE member_id = ? ORDER BY gym_day DESC LIMIT 60').all(m.id).map((x) => x.gym_day));
    // a week streak: weeks in a row with at least one visit
    let n = 0;
    for (let w = 0; w < 9; w++) {
      let hit = false;
      for (let d = 0; d < 7; d++) if (days.has(D.addDays(D.today(), -(w * 7 + d)))) hit = true;
      if (!hit) break;
      n++;
    }
    return n;
  })();
  res.render('me/home', {
    m, s,
    hours: (mine.length ? mine : ['iron']).map((c) => ({ c, ...S.label(sched, c) })),
    nextClass: s.kickboxing ? S.state(sched, 'kickboxing').next : null,
    adh: C.adherence(m.id, m.target_days),
    log: db.prepare('SELECT * FROM daily_logs WHERE member_id = ? AND day = ?').get(m.id, D.today()) || {},
    visit: C.openVisit(m.id),
    month: db.prepare(`SELECT COUNT(*) AS n, SUM((julianday(checked_out_at) - julianday(checked_at)) * 1440) AS mins FROM attendance
      WHERE member_id = ? AND checked_out_at IS NOT NULL AND substr(gym_day, 1, 7) = ?`).get(m.id, D.today().slice(0, 7)),
    setsToday: db.prepare('SELECT COUNT(DISTINCT exercise) AS n FROM workout_sets WHERE member_id = ? AND day = ?').get(m.id, D.today()).n,
    visitsMonth: db.prepare('SELECT COUNT(DISTINCT gym_day) AS n FROM attendance WHERE member_id = ? AND substr(gym_day, 1, 7) = ?').get(m.id, D.today().slice(0, 7)).n,
    streak,
    latestNews: db.prepare('SELECT * FROM notifications WHERE member_id = ? ORDER BY id DESC LIMIT 3').all(m.id),
  });
});

// ---- Today's workout: weight per set, reps on the last (failure) set only ----

r.get('/me/workout', (req, res) => {
  const m = me(req);
  const today = workoutHistory(m.id, 1).filter((w) => w.day === D.today());
  const exercise = C.cleanExercise(req.query.exercise);
  const days = P.load({ memberId: m.id });
  const dayNo = Number(req.query.day) || P.todayDayNo(m.id, days);
  const day = days.find((d) => d.day_no === dayNo) || null;
  res.render('me/workout', {
    m, today, exercise, days, day, summary: (d) => P.summary(d, req.lang),
    plan: day ? day.exercises.map((e) => ({ ...e, last: C.lastSession(m.id, e.exercise), done: today.find((w) => w.exercise === e.exercise) })) : [],
    visit: C.openVisit(m.id),
    last: exercise ? C.lastSession(m.id, exercise) : [],
    known: db.prepare('SELECT exercise, MAX(day) AS d FROM workout_sets WHERE member_id = ? GROUP BY exercise ORDER BY d DESC LIMIT 30').all(m.id).map((x) => x.exercise),
    pr: req.session.pr || null,
  });
  delete req.session.pr;
});

r.post('/me/workout', (req, res) => {
  const exercise = C.cleanExercise(req.body.exercise);
  const weights = [].concat(req.body.weight || []).map((w) => num(w)).filter((w) => w !== null);
  const reps = Math.floor(Number(req.body.reps) || 0);
  if (!exercise) { flash(req, 'error', 'اكتب اسم التمرين.'); return res.redirect('/me/workout'); }
  const again = () => res.redirect(req.body.day_no ? `/me/workout?day=${Number(req.body.day_no)}` : `/me/workout?exercise=${encodeURIComponent(exercise)}`);
  if (!weights.length || weights.length > 10 || weights.some((w) => w < 0 || w > 500)) { flash(req, 'error', 'أدخل وزن كل جولة.'); return again(); }
  if (reps < 1 || reps > 100) { flash(req, 'error', 'أدخل عدد التكرارات في الجولة الأخيرة.'); return again(); }
  const r2 = C.saveExercise(req.session.user.id, exercise, weights, reps);
  req.session.pr = { exercise, ...r2, reps };
  const dayNo = Number(req.body.day_no) || 0;
  if (dayNo) db.prepare('UPDATE members SET last_day_no = ? WHERE id = ?').run(dayNo, req.session.user.id);
  res.redirect(dayNo ? `/me/workout?day=${dayNo}` : '/me/workout');
});

r.post('/me/workout/delete', (req, res) => {
  db.prepare('DELETE FROM workout_sets WHERE member_id = ? AND day = ? AND exercise = ?').run(req.session.user.id, D.today(), C.cleanExercise(req.body.exercise));
  res.redirect(req.body.day_no ? `/me/workout?day=${Number(req.body.day_no)}` : '/me/workout');
});

// Demo only: a button in the member app that acts like putting a finger on the device.
r.post('/me/punch', (req, res) => {
  if (!DEMO) return res.status(404).render('error', { title: 'غير موجود', message: 'هذه الصفحة غير موجودة.' });
  const out = C.punch(req.session.user.id);
  flash(req, ['ok', 'out'].includes(out.type) ? 'success' : 'error', [out.text, out.detail]);
  res.redirect(req.get('referer') || '/me');
});

r.post('/me/log', (req, res) => {
  const b = req.body;
  const nutrition = ['yes', 'partial', 'no'].includes(b.nutrition) ? b.nutrition : null;
  const water = Math.min(20, Math.max(0, Math.floor(Number(b.water) || 0)));
  const weight = num(b.weight);
  if (weight !== null && (weight < 20 || weight > 300)) { flash(req, 'error', 'الوزن غير منطقي.'); return res.redirect('/me'); }
  db.prepare(`INSERT INTO daily_logs (member_id, day, nutrition, water, weight) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(member_id, day) DO UPDATE SET nutrition = excluded.nutrition, water = excluded.water,
      weight = COALESCE(excluded.weight, daily_logs.weight)`)
    .run(req.session.user.id, D.today(), nutrition, water, weight);
  flash(req, 'success', 'تم حفظ يومك 💪');
  res.redirect('/me');
});

r.get('/me/progress', (req, res) => {
  const m = me(req);
  const inbody = db.prepare('SELECT * FROM inbody WHERE member_id = ? ORDER BY day').all(m.id);
  const weights = db.prepare(`SELECT day, weight FROM (
      SELECT day, weight FROM daily_logs WHERE member_id = ? AND weight IS NOT NULL
      UNION SELECT day, weight FROM inbody WHERE member_id = ?) GROUP BY day ORDER BY day`).all(m.id, m.id);
  const logs = db.prepare('SELECT * FROM daily_logs WHERE member_id = ? AND day >= ? ORDER BY day DESC').all(m.id, D.addDays(D.today(), -13));
  res.render('me/progress', {
    m, inbody, weights, logs,
    adh: C.adherence(m.id, m.target_days),
    prs: personalBests(m.id),
    workoutDays: new Set(db.prepare('SELECT DISTINCT day FROM workout_sets WHERE member_id = ? AND day >= ?').all(m.id, D.addDays(D.today(), -13)).map((x) => x.day)),
    history: workoutHistory(m.id, 6),
  });
});

r.get('/me/shop', (req, res) => {
  res.render('me/shop', { products: db.prepare('SELECT id, name, type, price, stock FROM products WHERE active = 1 ORDER BY type, name').all() });
});

r.get('/me/notifications', (req, res) => {
  const list = db.prepare('SELECT * FROM notifications WHERE member_id = ? ORDER BY id DESC LIMIT 100').all(req.session.user.id);
  db.prepare("UPDATE notifications SET read_at = datetime('now', 'localtime') WHERE member_id = ? AND read_at IS NULL").run(req.session.user.id);
  res.render('me/notifications', { list });
});

r.get('/me/account', (req, res) => {
  const m = me(req);
  res.render('me/account', {
    m,
    subs: db.prepare('SELECT * FROM subscriptions WHERE member_id = ? ORDER BY start_date DESC').all(m.id),
    payments: db.prepare('SELECT * FROM payments WHERE member_id = ? ORDER BY paid_at DESC, id DESC').all(m.id),
    purchases: db.prepare(`SELECT s.*, (SELECT group_concat(i.name || ' ×' || i.qty, '، ') FROM sale_items i WHERE i.sale_id = s.id) AS items
      FROM sales s WHERE member_id = ? ORDER BY s.id DESC LIMIT 20`).all(m.id),
    visits: db.prepare('SELECT gym_day, checked_at, checked_out_at, category FROM attendance WHERE member_id = ? ORDER BY checked_at DESC LIMIT 20').all(m.id),
  });
});

r.post('/me/prefs', (req, res) => {
  const b = req.body;
  db.prepare('UPDATE members SET notify_hours = ?, notify_absence = ?, notify_offers = ? WHERE id = ?')
    .run(b.notify_hours ? 1 : 0, b.notify_absence ? 1 : 0, b.notify_offers ? 1 : 0, req.session.user.id);
  flash(req, 'success', 'تم حفظ الإعدادات.');
  res.redirect('/me/account');
});

r.post('/me/password', (req, res) => {
  const m = db.prepare('SELECT password_hash FROM members WHERE id = ?').get(req.session.user.id);
  const pw = String(req.body.password || '');
  if (!checkPassword(String(req.body.current || ''), m.password_hash)) flash(req, 'error', 'كلمة المرور الحالية غير صحيحة.');
  else if (pw.length < 8) flash(req, 'error', 'يجب أن تتكون كلمة المرور الجديدة من 8 أحرف على الأقل.');
  else { db.prepare('UPDATE members SET password_hash = ? WHERE id = ?').run(hashPassword(pw), req.session.user.id); flash(req, 'success', 'تم تغيير كلمة المرور.'); }
  res.redirect('/me/account');
});

module.exports = r;
