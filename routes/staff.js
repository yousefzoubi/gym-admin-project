const express = require('express');
const { db, tx, hashPassword, scheduleData } = require('../db');
const D = require('../dates');
const S = require('../schedule');
const C = require('../core');
const N = require('../notify');
const P = require('../programs');
const { flash, allow, STAFF } = require('../mw');

const r = express.Router();
const { CATS, STATUS, ROLES, statusMap, balanceSql, parseAmount, num, money } = C;
const back = (req, res, fallback) => res.redirect(req.get('referer') || fallback);
const trainers = () => db.prepare("SELECT id, name FROM users WHERE role = 'trainer' ORDER BY name").all();
const activePlans = () => db.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY category, months').all();
const templates = () => db.prepare('SELECT id, name FROM templates ORDER BY id').all();

// Recent workouts grouped as "day · exercise · sets", newest first
function workoutHistory(memberId, sessions = 10) {
  const rows = db.prepare(`SELECT * FROM workout_sets WHERE member_id = ? AND day IN
    (SELECT DISTINCT day FROM workout_sets WHERE member_id = ? ORDER BY day DESC LIMIT ?) ORDER BY day DESC, exercise, set_no`).all(memberId, memberId, sessions);
  const out = [];
  for (const x of rows) {
    const last = out[out.length - 1];
    if (last && last.day === x.day && last.exercise === x.exercise) last.sets.push(x);
    else out.push({ day: x.day, exercise: x.exercise, sets: [x] });
  }
  return out;
}
const personalBests = (memberId) => db.prepare(`SELECT exercise, MAX(weight) AS weight, day FROM workout_sets WHERE member_id = ?
  GROUP BY exercise ORDER BY weight DESC`).all(memberId);

r.get('/', allow('admin', 'reception', 'trainer', 'cleaner', 'member'), (req, res) => {
  res.redirect({ admin: '/dashboard', reception: '/checkin', trainer: '/trainer', cleaner: '/clean', member: '/me' }[req.session.user.role]);
});

// ---------- dashboard ----------

r.get('/dashboard', allow(...STAFF), (req, res) => {
  const t = D.today();
  const members = db.prepare('SELECT id, name, phone FROM members').all();
  const sm = statusMap(members.map((m) => m.id));
  const alerts = [];
  for (const m of members) {
    for (const [cat, s] of Object.entries(sm.get(m.id))) {
      if (s.status === 'expiring' || (s.status === 'expired' && s.days >= -7)) alerts.push({ ...m, cat, ...s });
    }
  }
  alerts.sort((a, b) => a.days - b.days);
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const day = D.addDays(t, -i);
    const rows = db.prepare('SELECT category, COUNT(DISTINCT member_id) AS n FROM attendance WHERE gym_day = ? GROUP BY category').all(day);
    const by = Object.fromEntries(rows.map((x) => [x.category, x.n]));
    week.push({ day, iron: by.iron || 0, kickboxing: by.kickboxing || 0, count: (by.iron || 0) + (by.kickboxing || 0) });
  }
  const isAdmin = req.session.user.role === 'admin';
  const month = t.slice(0, 7);
  const sched = scheduleData();
  res.render('dashboard', {
    active: [...sm.values()].filter((s) => s.overall === 'active' || s.overall === 'expiring').length,
    totalMembers: members.length,
    today: week[6],
    revenue: isAdmin ? db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE substr(paid_at, 1, 7) = ?").get(month).s : null,
    shopProfit: isAdmin ? db.prepare(`SELECT COALESCE(SUM(i.qty * (i.price - i.cost)), 0) AS p, COALESCE(SUM(i.qty * i.price), 0) AS s
      FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE substr(s.gym_day, 1, 7) = ?`).get(month) : null,
    owed: isAdmin ? db.prepare(`SELECT COALESCE(SUM(b), 0) AS s FROM (SELECT ${balanceSql} AS b FROM members m) WHERE b > 0`).get().s : null,
    expiringCount: alerts.filter((a) => a.status === 'expiring').length,
    alerts,
    week,
    weekMax: Math.max(1, ...week.map((w) => w.count)),
    hours: Object.fromEntries(Object.keys(CATS).map((c) => [c, S.label(sched, c)])),
    recent: db.prepare(`SELECT a.*, m.name FROM attendance a JOIN members m ON m.id = a.member_id
      WHERE a.gym_day = ? ORDER BY a.checked_at DESC LIMIT 8`).all(t),
    cleaning: cleaningToday(),
    onShift: db.prepare(`SELECT u.name, s.clock_in FROM staff_shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_out IS NULL AND s.clock_in >= ?`).all(D.stamp(new Date(Date.now() - 16 * 3600000))),
    insideNow: db.prepare('SELECT COUNT(*) AS n FROM attendance WHERE checked_out_at IS NULL AND checked_at >= ?').get(D.stamp(new Date(Date.now() - C.OPEN_MAX_H * 3600000))).n,
    avgMin: Math.round(db.prepare(`SELECT AVG((julianday(checked_out_at) - julianday(checked_at)) * 1440) AS a FROM attendance
      WHERE checked_out_at IS NOT NULL AND gym_day >= ?`).get(D.addDays(t, -30)).a || 0),
  });
});

// ---------- members ----------

function cleanMember(body, id = 0) {
  const name = String(body.name || '').trim().slice(0, 100);
  // Excel drops the leading 0 and people type +962: normalise to 07XXXXXXXX
  const phone = C.normPhone(body.phone);
  const national_id = C.cleanInput(body.national_id);
  const birth_date = C.cleanInput(body.birth_date);
  const notes = String(body.notes || '').trim().slice(0, 1000);
  const trainer_id = Number(body.trainer_id) || null;
  const fingerprint_id = body.fingerprint_id ? Number(C.cleanInput(body.fingerprint_id)) : null;
  if (!name) return { error: 'الاسم مطلوب.' };
  if (!/^07\d{8}$/.test(phone)) return { error: 'يجب أن يتكون رقم الهاتف من 10 أرقام ويبدأ بـ 07.' };
  if (!/^\d{10}$/.test(national_id)) return { error: 'يجب أن يتكون الرقم الوطني من 10 أرقام.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth_date) || isNaN(D.parse(birth_date)) || D.age(birth_date) < 8 || D.age(birth_date) > 90) return { error: 'تاريخ الميلاد غير صحيح.' };
  if (fingerprint_id !== null && !(Number.isInteger(fingerprint_id) && fingerprint_id > 0)) return { error: 'يجب أن يكون رقم البصمة عدداً صحيحاً.' };
  if (trainer_id && !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'trainer'").get(trainer_id)) return { error: 'المدرّب غير موجود.' };
  // One person, one membership: national ID, phone and fingerprint are unique.
  for (const [col, label] of [['national_id', 'الرقم الوطني'], ['phone', 'رقم الهاتف'], ['fingerprint_id', 'رقم البصمة']]) {
    const v = { national_id, phone, fingerprint_id }[col];
    if (v === null) continue;
    const dup = db.prepare(`SELECT id, name FROM members WHERE ${col} = ? AND id != ?`).get(v, id);
    if (dup) return { error: ['{label} مسجّل مسبقاً للعضو {name} (#{id}).', { label, name: dup.name, id: dup.id }], dup: dup.id };
  }
  const staffFp = db.prepare('SELECT name FROM users WHERE fingerprint_id = ?').get(fingerprint_id);
  if (fingerprint_id !== null && staffFp) return { error: ['رقم البصمة مسجّل للموظف {name}.', { name: staffFp.name }] };
  return { name, phone, national_id, birth_date, notes, trainer_id, fingerprint_id };
}

function getMember(req, res) {
  const m = db.prepare(`SELECT m.*, ${balanceSql} AS balance, u.name AS trainer_name
    FROM members m LEFT JOIN users u ON u.id = m.trainer_id WHERE m.id = ?`).get(Number(req.params.id));
  if (!m) { res.status(404).render('error', { title: 'غير موجود', message: 'هذا العضو غير موجود.' }); return null; }
  const u = req.session.user;
  if (u.role === 'trainer' && m.trainer_id !== u.id) { res.status(403).render('error', { title: 'غير مسموح', message: 'هذا العضو ليس من متدرّبيك.' }); return null; }
  return m;
}

r.get('/members', allow(...STAFF), (req, res) => {
  const q = String(req.query.q || '').trim();
  const filter = String(req.query.status || '');
  const like = `%${q}%`;
  let rows = db.prepare(`SELECT m.id, m.name, m.phone, m.national_id, m.password_hash IS NOT NULL AS activated, ${balanceSql} AS balance, u.name AS trainer_name
    FROM members m LEFT JOIN users u ON u.id = m.trainer_id
    WHERE ? = '' OR m.name LIKE ? OR m.phone LIKE ? OR m.national_id = ? OR CAST(m.id AS TEXT) = ?
    ORDER BY m.name`).all(q, like, like, q, q);
  const sm = statusMap(rows.map((m) => m.id));
  rows = rows.map((m) => ({ ...m, s: sm.get(m.id) }));
  if (STATUS[filter]) rows = rows.filter((m) => m.s.overall === filter);
  res.render('members', { rows, q, filter });
});

r.get('/members/new', allow(...STAFF), (req, res) => {
  res.render('member-form', { m: {}, error: null, trainers: trainers(), plans: activePlans(), templates: templates() });
});

r.post('/members', allow(...STAFF), (req, res) => {
  const data = cleanMember(req.body);
  if (data.error) return res.status(400).render('member-form', { m: req.body, error: data.error, dup: data.dup, trainers: trainers(), plans: activePlans(), templates: templates() });
  const id = Number(db.prepare(`INSERT INTO members (name, phone, national_id, birth_date, notes, trainer_id, fingerprint_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(data.name, data.phone, data.national_id, data.birth_date, data.notes, data.trainer_id, data.fingerprint_id, D.today()).lastInsertRowid);
  for (const cat of Object.keys(CATS)) {
    if (req.body[`plan_${cat}`]) C.addSubscription(id, req.body[`plan_${cat}`], parseAmount(req.body[`paid_${cat}`]), req.session.user.id);
  }
  const tpl = db.prepare('SELECT id FROM templates WHERE id = ?').get(Number(req.body.template_id));
  if (tpl) P.assign(id, tpl.id);
  if (data.trainer_id) N.notify({ user: data.trainer_id }, { title: ['متدرّب جديد: {name}', { name: data.name }], link: tpl ? `/members/${id}/program` : `/members/${id}` });
  flash(req, 'success', ['تمت إضافة {name}. يمكنه تفعيل حسابه من صفحة الدخول برقم هاتفه ورقمه الوطني.', { name: data.name }]);
  res.redirect(`/members/${id}`);
});

r.get('/members/:id', allow('admin', 'reception', 'trainer'), (req, res) => {
  const m = getMember(req, res);
  if (!m) return;
  res.render('member', {
    m,
    s: statusMap([m.id]).get(m.id),
    subs: db.prepare('SELECT * FROM subscriptions WHERE member_id = ? ORDER BY start_date DESC').all(m.id),
    payments: db.prepare(`SELECT p.*, u.name AS by_name FROM payments p LEFT JOIN users u ON u.id = p.created_by
      WHERE member_id = ? ORDER BY paid_at DESC, p.id DESC`).all(m.id),
    purchases: db.prepare(`SELECT s.*, (SELECT group_concat(i.name || ' ×' || i.qty, '، ') FROM sale_items i WHERE i.sale_id = s.id) AS items
      FROM sales s WHERE member_id = ? ORDER BY s.id DESC LIMIT 20`).all(m.id),
    visits: db.prepare('SELECT gym_day, checked_at, checked_out_at, category FROM attendance WHERE member_id = ? ORDER BY checked_at DESC LIMIT 30').all(m.id),
    workouts: workoutHistory(m.id, 8),
    inbody: db.prepare('SELECT * FROM inbody WHERE member_id = ? ORDER BY day DESC').all(m.id),
    adh: C.adherence(m.id, m.target_days),
    prs: personalBests(m.id),
    plans: activePlans(),
    program: P.load({ memberId: m.id }),
    templateName: (db.prepare('SELECT name FROM templates WHERE id = ?').get(m.template_id) || {}).name,
    templates: templates(),
    summary: (d) => P.summary(d, req.lang),
  });
});

r.get('/members/:id/edit', allow(...STAFF), (req, res) => {
  const m = getMember(req, res);
  if (m) res.render('member-form', { m, error: null, trainers: trainers(), plans: [] });
});

r.post('/members/:id', allow(...STAFF), (req, res) => {
  const m = getMember(req, res);
  if (!m) return;
  const data = cleanMember(req.body, m.id);
  if (data.error) return res.status(400).render('member-form', { m: { ...req.body, id: m.id }, error: data.error, dup: data.dup, trainers: trainers(), plans: [] });
  db.prepare('UPDATE members SET name = ?, phone = ?, national_id = ?, birth_date = ?, notes = ?, trainer_id = ?, fingerprint_id = ? WHERE id = ?')
    .run(data.name, data.phone, data.national_id, data.birth_date, data.notes, data.trainer_id, data.fingerprint_id, m.id);
  if (data.trainer_id && data.trainer_id !== m.trainer_id) N.notify({ user: data.trainer_id }, { title: ['متدرّب جديد: {name}', { name: data.name }], link: `/members/${m.id}` });
  flash(req, 'success', 'تم حفظ التعديلات.');
  res.redirect(`/members/${m.id}`);
});

r.post('/members/:id/delete', allow('admin'), (req, res) => {
  const m = getMember(req, res);
  if (!m) return;
  db.prepare('DELETE FROM members WHERE id = ?').run(m.id);
  flash(req, 'success', ['تم حذف {name}.', { name: m.name }]);
  res.redirect('/members');
});

r.post('/members/:id/subscriptions', allow(...STAFF), (req, res) => {
  const m = getMember(req, res);
  if (!m) return;
  const paid = parseAmount(req.body.paid);
  const out = C.addSubscription(m.id, req.body.plan_id, paid, req.session.user.id);
  if (!out.error) {
    N.notify({ member: m.id }, { title: ['أُضيف اشتراك {plan}', { plan: out.plan.name }], body: ['يبدأ في {date}', { date: out.start }], link: '/me' });
    if (paid) N.receipt(m.id, paid);
  }
  flash(req, out.error ? 'error' : 'success', out.error || 'تمت إضافة الاشتراك.');
  res.redirect(`/members/${m.id}`);
});

r.post('/subscriptions/:id/delete', allow('admin'), (req, res) => {
  const s = db.prepare('SELECT member_id FROM subscriptions WHERE id = ?').get(Number(req.params.id));
  if (s) db.prepare('DELETE FROM subscriptions WHERE id = ?').run(Number(req.params.id));
  flash(req, 'success', 'تم حذف الاشتراك.');
  res.redirect(s ? `/members/${s.member_id}` : '/members');
});

r.post('/members/:id/payments', allow(...STAFF), (req, res) => {
  const m = getMember(req, res);
  if (!m) return;
  const amount = parseAmount(req.body.amount);
  if (!amount) { flash(req, 'error', 'يجب أن يكون المبلغ رقماً أكبر من صفر.'); return res.redirect(`/members/${m.id}`); }
  db.prepare('INSERT INTO payments (member_id, amount, note, paid_at, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(m.id, amount, String(req.body.note || '').trim().slice(0, 200), D.today(), req.session.user.id);
  N.receipt(m.id, amount);
  flash(req, 'success', ['تم تسجيل دفعة بقيمة {amount}.', { amount: money(amount) }]);
  res.redirect(`/members/${m.id}`);
});

r.post('/payments/:id/delete', allow('admin'), (req, res) => {
  const p = db.prepare('SELECT member_id FROM payments WHERE id = ?').get(Number(req.params.id));
  if (p) db.prepare('DELETE FROM payments WHERE id = ?').run(Number(req.params.id));
  flash(req, 'success', 'تم حذف الدفعة.');
  back(req, res, '/payments');
});

// ---------- coaching: program, goals, InBody ----------

r.post('/members/:id/goals', allow('admin', 'trainer'), (req, res) => {
  const m = getMember(req, res);
  if (!m) return;
  const b = req.body;
  const goal_type = C.GOALS[b.goal_type] ? b.goal_type : '';
  const goal_date = /^\d{4}-\d{2}-\d{2}$/.test(b.goal_date || '') ? b.goal_date : null;
  const days = Math.min(7, Math.max(1, Number(b.target_days) || 4));
  db.prepare(`UPDATE members SET goal_type = ?, goal_weight = ?, goal_pbf = ?, goal_date = ?, target_days = ?,
    kcal = ?, protein = ?, carbs = ?, fat = ?, water = ? WHERE id = ?`)
    .run(goal_type, num(b.goal_weight), num(b.goal_pbf), goal_date, days, num(b.kcal), num(b.protein), num(b.carbs), num(b.fat), num(b.water), m.id);
  N.notify({ member: m.id }, { title: 'حدّث المدرّب هدفك وخطتك الغذائية 🎯', link: '/me/progress' });
  flash(req, 'success', 'تم حفظ الهدف والخطة الغذائية.');
  res.redirect(`/members/${m.id}#coach`);
});

const INBODY = ['weight', 'smm', 'bfm', 'pbf', 'bmi', 'visceral', 'bmr', 'tbw', 'score'];
r.post('/members/:id/inbody', allow('admin', 'reception', 'trainer'), (req, res) => {
  const m = getMember(req, res);
  if (!m) return;
  const v = Object.fromEntries(INBODY.map((k) => [k, num(req.body[k])]));
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.body.day || '') ? req.body.day : D.today();
  if (!v.weight || v.weight < 20 || v.weight > 300) { flash(req, 'error', 'الوزن مطلوب (20 - 300 كغ).'); return res.redirect(`/members/${m.id}#inbody`); }
  db.prepare(`INSERT INTO inbody (member_id, day, ${INBODY.join(', ')}, created_by) VALUES (?, ?, ${INBODY.map(() => '?').join(', ')}, ?)`)
    .run(m.id, day, ...INBODY.map((k) => v[k]), req.session.user.id);
  N.notify({ member: m.id }, { title: 'نتيجة فحص InBody الجديد جاهزة 📊', link: '/me/progress' });
  flash(req, 'success', 'تم حفظ فحص InBody.');
  res.redirect(`/members/${m.id}#inbody`);
});

r.post('/inbody/:id/delete', allow('admin'), (req, res) => {
  const x = db.prepare('SELECT member_id FROM inbody WHERE id = ?').get(Number(req.params.id));
  if (x) db.prepare('DELETE FROM inbody WHERE id = ?').run(Number(req.params.id));
  res.redirect(x ? `/members/${x.member_id}#inbody` : '/members');
});

// ---------- fingerprint (simulated device) ----------
// ponytail: the real device (likely ZKTeco on the LAN) isn't connected yet. When it is, a small poller
// reads new punches {fingerprint_id, time} and calls C.punch(member, { now: time }), exactly like the button here.

const visitRows = (where, ...args) => db.prepare(`SELECT a.*, m.name FROM attendance a JOIN members m ON m.id = a.member_id
  WHERE ${where} ORDER BY a.checked_at DESC`).all(...args);

r.get('/checkin', allow(...STAFF), (req, res) => {
  const q = String(req.query.q || '').trim();
  let results = [];
  if (q) {
    const like = `%${q}%`;
    results = db.prepare(`SELECT id, name, phone, fingerprint_id FROM members WHERE CAST(id AS TEXT) = ? OR CAST(fingerprint_id AS TEXT) = ? OR national_id = ? OR name LIKE ? OR phone LIKE ?
      ORDER BY name LIMIT 10`).all(q, q, q, like, like);
    const sm = statusMap(results.map((x) => x.id));
    results = results.map((x) => ({ ...x, s: sm.get(x.id), open: !!C.openVisit(x.id) }));
  }
  const sched = scheduleData();
  const since = D.stamp(new Date(Date.now() - C.OPEN_MAX_H * 3600000));
  res.render('checkin', {
    q, results,
    hours: Object.fromEntries(Object.keys(CATS).map((c) => [c, S.label(sched, c)])),
    inside: visitRows('a.checked_out_at IS NULL AND a.checked_at >= ?', since),
    todayList: visitRows('a.gym_day = ?', D.today()),
    staff: db.prepare('SELECT id, name, role, fingerprint_id FROM users WHERE fingerprint_id IS NOT NULL ORDER BY name').all().map((u) => ({ ...u, shift: C.openShift(u.id) })),
  });
});

r.post('/punch-staff/:id', allow(...STAFF), (req, res) => {
  const out = C.punchStaff(Number(req.params.id));
  req.session.flash = { ...out, type: `ci-${out.type}` };
  res.redirect('/checkin');
});

r.post('/punch/:id', allow(...STAFF), (req, res) => {
  const out = C.punch(Number(req.params.id), { by: req.session.user.id });
  req.session.flash = { ...out, type: `ci-${out.type}` };
  res.redirect(req.body.back === 'member' ? `/members/${req.params.id}` : '/checkin');
});

// ---------- payments ----------

r.get('/payments', allow('admin'), (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : D.today().slice(0, 7);
  const rows = db.prepare(`SELECT p.*, m.name AS member_name, u.name AS by_name FROM payments p
    JOIN members m ON m.id = p.member_id LEFT JOIN users u ON u.id = p.created_by
    WHERE substr(p.paid_at, 1, 7) = ? ORDER BY p.paid_at DESC, p.id DESC`).all(month);
  const owing = db.prepare(`SELECT * FROM (SELECT m.id, m.name, m.phone, ${balanceSql} AS balance FROM members m)
    WHERE balance > 0 ORDER BY balance DESC`).all();
  res.render('payments', { rows, month, total: rows.reduce((a, x) => a + x.amount, 0), owing });
});

// ---------- plans ----------

r.get('/plans', allow('admin'), (req, res) => {
  res.render('plans', { plans: db.prepare('SELECT * FROM plans ORDER BY active DESC, category, months').all() });
});

function cleanPlan(body) {
  const name = String(body.name || '').trim().slice(0, 100);
  const months = Number(body.months);
  const price = Math.round(Number(body.price) * 100) / 100;
  if (!name || !CATS[body.category] || !Number.isInteger(months) || months < 1 || months > 24 || !(price >= 0)) return null;
  return { name, category: body.category, months, price };
}

r.post('/plans', allow('admin'), (req, res) => {
  const p = cleanPlan(req.body);
  if (!p) flash(req, 'error', 'تأكد من بيانات الباقة.');
  else { db.prepare('INSERT INTO plans (name, category, months, price) VALUES (?, ?, ?, ?)').run(p.name, p.category, p.months, p.price); flash(req, 'success', 'تمت إضافة الباقة.'); }
  res.redirect('/plans');
});

r.post('/plans/:id', allow('admin'), (req, res) => {
  const p = cleanPlan(req.body);
  if (!p) flash(req, 'error', 'تأكد من بيانات الباقة.');
  else {
    db.prepare('UPDATE plans SET name = ?, category = ?, months = ?, price = ?, active = ? WHERE id = ?')
      .run(p.name, p.category, p.months, p.price, req.body.active ? 1 : 0, Number(req.params.id));
    flash(req, 'success', 'تم حفظ الباقة. لا تتأثر الاشتراكات السابقة.');
  }
  res.redirect('/plans');
});

// ---------- hours, closures, announcements ----------

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

r.get('/schedule', allow('admin'), (req, res) => {
  const d = scheduleData();
  res.render('schedule', {
    hours: d.hours,
    closures: db.prepare('SELECT * FROM closures WHERE day >= ? ORDER BY day').all(D.today()),
    labels: Object.fromEntries(Object.keys(CATS).map((c) => [c, S.label(d, c)])),
  });
});

r.post('/schedule', allow('admin'), (req, res) => {
  const rows = [];
  for (const cat of Object.keys(CATS)) {
    for (let wd = 0; wd < 7; wd++) {
      const open = req.body[`${cat}_${wd}_open`], close = req.body[`${cat}_${wd}_close`];
      if (!open && !close) continue;
      if (!HM.test(open || '') || !HM.test(close || '') || open === close) { flash(req, 'error', ['وقت غير صحيح: {cat} {day}', { cat: CATS[cat], day: S.WEEKDAYS[wd] }]); return res.redirect('/schedule'); }
      rows.push([cat, wd, open, close]);
    }
  }
  tx(() => {
    db.exec('DELETE FROM hours');
    const ins = db.prepare('INSERT INTO hours (category, weekday, open, close) VALUES (?, ?, ?, ?)');
    for (const x of rows) ins.run(...x);
  });
  flash(req, 'success', 'تم حفظ الدوام.');
  res.redirect('/schedule');
});

r.post('/closures', allow('admin'), (req, res) => {
  const day = String(req.body.day || '');
  const category = CATS[req.body.category] ? req.body.category : null;
  const closed = req.body.kind !== 'hours';
  const note = String(req.body.note || '').trim().slice(0, 200);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < D.today()) { flash(req, 'error', 'اختر تاريخ اليوم أو تاريخاً لاحقاً.'); return res.redirect('/schedule'); }
  if (!closed && (!HM.test(req.body.open || '') || !HM.test(req.body.close || ''))) { flash(req, 'error', 'أدخل وقت الفتح ووقت الإغلاق.'); return res.redirect('/schedule'); }
  const id = Number(db.prepare('INSERT INTO closures (day, category, closed, open, close, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(day, category, closed ? 1 : 0, closed ? null : req.body.open, closed ? null : req.body.close, note).lastInsertRowid);
  const where = category ? CATS[category] : 'النادي';
  const title = closed ? ['{where} مغلق يوم {day}', { where, day }] : ['تغيير دوام {where} يوم {day}: من {from} إلى {to}', { where, day, from: S.ar(req.body.open), to: S.ar(req.body.close) }];
  const n = N.broadcast({ category, title, body: N.raw(note), link: '/me', key: `closure:${id}`, sms: true });
  flash(req, 'success', ['تم الحفظ وأُرسل إشعار إلى {n} مشتركاً.', { n }]);
  res.redirect('/schedule');
});

r.post('/closures/:id/delete', allow('admin'), (req, res) => {
  db.prepare('DELETE FROM closures WHERE id = ?').run(Number(req.params.id));
  res.redirect('/schedule');
});

r.post('/broadcast', allow('admin'), (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120);
  const body = String(req.body.body || '').trim().slice(0, 500);
  const category = CATS[req.body.category] ? req.body.category : null;
  if (!title) { flash(req, 'error', 'العنوان مطلوب.'); return res.redirect('/schedule'); }
  const n = N.broadcast({ category, title: N.raw(title), body: N.raw(body), onlyOptedIn: req.body.offer ? 'notify_offers' : null });
  flash(req, 'success', ['أُرسل الإعلان إلى {n} مشتركاً.', { n }]);
  res.redirect('/schedule');
});

// ---------- staff accounts ----------

r.get('/users', allow('admin'), (req, res) => {
  const month = D.today().slice(0, 7);
  res.render('users', {
    users: db.prepare(`SELECT u.id, u.name, u.username, u.role, u.fingerprint_id, u.created_at,
      (SELECT SUM((julianday(clock_out) - julianday(clock_in)) * 24) FROM staff_shifts WHERE user_id = u.id AND clock_out IS NOT NULL AND substr(clock_in, 1, 7) = ?) AS hours,
      (SELECT COUNT(DISTINCT substr(clock_in, 1, 10)) FROM staff_shifts WHERE user_id = u.id AND substr(clock_in, 1, 7) = ?) AS days
      FROM users u ORDER BY role, name`).all(month, month),
  });
});

r.post('/users', allow('admin'), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!name || !/^[a-zA-Z][a-zA-Z0-9_.]{2,29}$/.test(username) || password.length < 8 || !['admin', 'reception', 'trainer', 'cleaner'].includes(req.body.role)) {
    flash(req, 'error', 'اسم المستخدم: من 3 إلى 30 حرفاً إنجليزياً ويبدأ بحرف. كلمة المرور: 8 أحرف على الأقل.');
  } else if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    flash(req, 'error', 'اسم المستخدم مستخدم مسبقاً.');
  } else {
    db.prepare('INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)').run(name, username, hashPassword(password), req.body.role);
    flash(req, 'success', ['تمت إضافة {name}.', { name }]);
  }
  res.redirect('/users');
});

r.post('/users/:id/password', allow('admin'), (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 8) flash(req, 'error', 'يجب أن تتكون كلمة المرور من 8 أحرف على الأقل.');
  else { db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), Number(req.params.id)); flash(req, 'success', 'تم تغيير كلمة المرور.'); }
  res.redirect('/users');
});

r.post('/users/:id/fingerprint', allow('admin'), (req, res) => {
  const id = Number(req.params.id);
  const fid = req.body.fingerprint_id ? Number(req.body.fingerprint_id) : null;
  const owner = C.fingerprintOwner(fid, { userId: id });
  if (fid !== null && !(Number.isInteger(fid) && fid > 0)) flash(req, 'error', 'يجب أن يكون رقم البصمة عدداً صحيحاً.');
  else if (owner) flash(req, 'error', ['رقم البصمة مسجّل باسم {name}.', { name: owner }]);
  else { db.prepare('UPDATE users SET fingerprint_id = ? WHERE id = ?').run(fid, id); flash(req, 'success', 'تم حفظ رقم البصمة.'); }
  res.redirect('/users');
});

r.post('/users/:id/delete', allow('admin'), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.user.id) flash(req, 'error', 'لا يمكنك حذف حسابك.');
  else { db.prepare('DELETE FROM users WHERE id = ?').run(id); flash(req, 'success', 'تم حذف الحساب.'); }
  res.redirect('/users');
});

// ---------- trainer ----------

r.get('/trainer', allow('trainer'), (req, res) => {
  const rows = db.prepare(`SELECT id, name, phone, goal_type, target_days, (SELECT name FROM templates WHERE id = members.template_id) AS template_name,
    (SELECT MAX(day) FROM daily_logs WHERE member_id = members.id) AS last_log,
    (SELECT MAX(gym_day) FROM attendance WHERE member_id = members.id) AS last_visit
    FROM members WHERE trainer_id = ? ORDER BY name`).all(req.session.user.id);
  const sm = statusMap(rows.map((x) => x.id));
  const list = rows.map((x) => ({ ...x, s: sm.get(x.id), adh: C.adherence(x.id, x.target_days) })).sort((a, b) => a.adh.score - b.adh.score);
  res.render('trainer', { rows: list });
});

// ---------- cleaning ----------

function cleaningToday() {
  const tasks = db.prepare(`SELECT t.*, d.done_at, u.name AS done_by FROM cleaning_tasks t
    LEFT JOIN cleaning_done d ON d.task_id = t.id AND d.day = ? LEFT JOIN users u ON u.id = d.user_id
    WHERE t.active = 1 ORDER BY t.sort, t.id`).all(D.today());
  return { tasks, done: tasks.filter((t) => t.done_at).length, total: tasks.length };
}

r.get('/clean', allow('admin', 'cleaner'), (req, res) => {
  const u = req.session.user;
  res.render('clean', {
    ...cleaningToday(),
    shift: C.openShift(u.id),
    me: db.prepare('SELECT fingerprint_id FROM users WHERE id = ?').get(u.id),
    week: db.prepare(`SELECT day, COUNT(*) AS n FROM cleaning_done WHERE day >= ? GROUP BY day ORDER BY day`).all(D.addDays(D.today(), -6)),
    shifts: db.prepare(`SELECT s.*, u.name FROM staff_shifts s JOIN users u ON u.id = s.user_id
      WHERE ${u.role === 'admin' ? "u.role = 'cleaner'" : 'u.id = ?'} ORDER BY s.clock_in DESC LIMIT 14`).all(...(u.role === 'admin' ? [] : [u.id])),
  });
});

r.post('/clean/tasks', allow('admin'), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (name) db.prepare('INSERT INTO cleaning_tasks (name, sort) VALUES (?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM cleaning_tasks))').run(name);
  res.redirect('/clean');
});

r.post('/clean/tasks/:id/delete', allow('admin'), (req, res) => {
  db.prepare('UPDATE cleaning_tasks SET active = 0 WHERE id = ?').run(Number(req.params.id));
  res.redirect('/clean');
});

r.post('/clean/:id', allow('admin', 'cleaner'), (req, res) => {
  const id = Number(req.params.id), day = D.today();
  if (!db.prepare('SELECT 1 FROM cleaning_tasks WHERE id = ? AND active = 1').get(id)) return res.redirect('/clean');
  const del = db.prepare('DELETE FROM cleaning_done WHERE task_id = ? AND day = ?').run(id, day);
  if (!del.changes) db.prepare('INSERT INTO cleaning_done (task_id, day, done_at, user_id) VALUES (?, ?, ?, ?)').run(id, day, D.stamp(new Date()), req.session.user.id);
  const c = cleaningToday();
  if (c.done === c.total) {
    for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin'").all()) N.notify({ user: a.id }, { title: 'اكتملت مهام النظافة اليوم ✨', body: ['{n} مهام', { n: c.total }], link: '/clean', key: `clean:${a.id}:${day}` });
  }
  res.redirect('/clean');
});

// ---------- staff notifications ----------

r.get('/notifications', allow('admin', 'reception', 'trainer', 'cleaner'), (req, res) => {
  const list = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.session.user.id);
  db.prepare("UPDATE notifications SET read_at = datetime('now', 'localtime') WHERE user_id = ? AND read_at IS NULL").run(req.session.user.id);
  res.render('notifications', { list, title: 'الإشعارات' });
});

// ---------- CSV import from the old gym program ----------

r.get('/import', allow('admin'), (req, res) => res.render('import', { report: null }));

// Minimal CSV: commas, optional double quotes, "" escapes. Good enough for Excel "Save as CSV".
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((x) => x.some((c) => c.trim()));
}

r.post('/import', allow('admin'), express.urlencoded({ extended: false, limit: '2mb' }), (req, res) => {
  const rows = parseCsv(String(req.body.csv || '').replace(/^﻿/, ''));
  const head = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  const need = ['name', 'phone', 'national_id', 'birth_date'];
  if (!need.every((h) => head.includes(h))) {
    return res.render('import', { report: { ok: 0, errors: [['يجب أن يحتوي السطر الأول على الأعمدة: {cols}', { cols: `${need.join(', ')}, iron_end, kickboxing_end` }]] } });
  }
  const report = { ok: 0, errors: [] };
  rows.forEach((cells, i) => {
    const o = Object.fromEntries(head.map((h, j) => [h, (cells[j] || '').trim()]));
    const data = cleanMember(o);
    if (data.error) return report.errors.push(['السطر {n} ({name}): {err}', { n: i + 2, name: o.name || '?', err: data.error }]);
    tx(() => {
      const id = Number(db.prepare(`INSERT INTO members (name, phone, national_id, birth_date, fingerprint_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(data.name, data.phone, data.national_id, data.birth_date, data.fingerprint_id, D.today()).lastInsertRowid);
      for (const cat of Object.keys(CATS)) {
        const end = o[`${cat}_end`];
        if (/^\d{4}-\d{2}-\d{2}$/.test(end || '')) {
          db.prepare(`INSERT INTO subscriptions (member_id, plan_name, category, start_date, end_date, price, created_by) VALUES (?, ?, ?, ?, ?, 0, ?)`)
            .run(id, `${CATS[cat]} (مستورد)`, cat, D.addDays(D.addMonths(end, -1), 1), end, req.session.user.id);
        }
      }
    });
    report.ok++;
  });
  res.render('import', { report });
});

module.exports = r;
module.exports.parseCsv = parseCsv;
module.exports.workoutHistory = workoutHistory;
module.exports.personalBests = personalBests;
