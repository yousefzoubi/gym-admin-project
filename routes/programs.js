const express = require('express');
const { db } = require('../db');
const P = require('../programs');
const N = require('../notify');
const { flash, allow } = require('../mw');

const r = express.Router();
const EDITORS = ['admin', 'reception', 'trainer'];
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// ---------- templates ----------

r.get('/templates', allow(...EDITORS), (req, res) => {
  const list = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM program_days WHERE template_id = t.id) AS days,
    (SELECT COUNT(*) FROM program_exercises e JOIN program_days d ON d.id = e.day_id WHERE d.template_id = t.id) AS exercises,
    (SELECT COUNT(*) FROM members WHERE template_id = t.id) AS members
    FROM templates t ORDER BY t.id`).all();
  res.render('templates', { list, title: 'الجداول' });
});

r.post('/templates', allow(...EDITORS), (req, res) => {
  const name = clean(req.body.name, 60);
  if (!name) { flash(req, 'error', 'اكتب اسماً للجدول.'); return res.redirect('/templates'); }
  const from = Number(req.body.copy_from) || 0;
  const id = from ? P.duplicate(from, name) : Number(db.prepare('INSERT INTO templates (name) VALUES (?)').run(name).lastInsertRowid);
  if (!from) P.addDay({ templateId: id });
  res.redirect(`/templates/${id}`);
});

const getTemplate = (req, res) => {
  const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(req.params.id));
  if (!t) res.status(404).render('error', { title: 'غير موجود', message: 'هذا الجدول غير موجود.' });
  return t;
};

r.get('/templates/:id', allow(...EDITORS), (req, res) => {
  const t = getTemplate(req, res);
  if (!t) return;
  res.render('program', {
    title: ['{x}', { x: t.name }], tpl: t, m: null, days: P.load({ templateId: t.id }), canEdit: true,
    addDayAction: `/templates/${t.id}/days`, summary: (d) => P.summary(d, req.lang),
  });
});

r.post('/templates/:id', allow(...EDITORS), (req, res) => {
  const t = getTemplate(req, res);
  if (!t) return;
  db.prepare("UPDATE templates SET name = ?, note = ?, updated_at = datetime('now', 'localtime') WHERE id = ?")
    .run(clean(req.body.name, 60) || t.name, clean(req.body.note, 200), t.id);
  flash(req, 'success', 'تم الحفظ.');
  res.redirect(`/templates/${t.id}`);
});

r.post('/templates/:id/delete', allow('admin'), (req, res) => {
  db.prepare('DELETE FROM templates WHERE id = ?').run(Number(req.params.id));
  flash(req, 'success', 'تم حذف الجدول. يحتفظ المشتركون الذين أخذوه بنسختهم.');
  res.redirect('/templates');
});

r.post('/templates/:id/days', allow(...EDITORS), (req, res) => {
  const t = getTemplate(req, res);
  if (!t) return;
  const day = P.addDay({ templateId: t.id });
  res.redirect(`/templates/${t.id}#day-${day}`);
});

// ---------- a member's own program ----------

function memberFor(req, res) {
  const u = req.session.user;
  const id = u.role === 'member' ? u.id : Number(req.params.id);
  const m = db.prepare('SELECT m.id, m.name, m.trainer_id, m.template_id, t.name AS template_name FROM members m LEFT JOIN templates t ON t.id = m.template_id WHERE m.id = ?').get(id);
  if (!m) { res.status(404).render('error', { title: 'غير موجود', message: 'هذا العضو غير موجود.' }); return null; }
  if (u.role === 'trainer' && m.trainer_id !== u.id) { res.status(403).render('error', { title: 'غير مسموح', message: 'هذا العضو ليس من متدرّبيك.' }); return null; }
  return m;
}

function showMember(req, res, m) {
  const u = req.session.user;
  const canEdit = u.role === 'member' || u.role === 'admin' || (u.role === 'trainer' && m.trainer_id === u.id);
  res.render(u.role === 'member' ? 'me/program' : 'program', {
    title: ['جدول {name}', { name: m.name }], tpl: null, m, days: P.load({ memberId: m.id }), canEdit,
    addDayAction: u.role === 'member' ? '/me/program/days' : `/members/${m.id}/program/days`, summary: (d) => P.summary(d, req.lang),
    templates: db.prepare('SELECT id, name FROM templates ORDER BY id').all(),
    canAssign: u.role !== 'member',
  });
}

r.get('/members/:id/program', allow('admin', 'reception', 'trainer'), (req, res) => { const m = memberFor(req, res); if (m) showMember(req, res, m); });
r.get('/me/program', allow('member'), (req, res) => { const m = memberFor(req, res); if (m) showMember(req, res, m); });

r.post('/members/:id/assign', allow('admin', 'reception', 'trainer'), (req, res) => {
  const m = memberFor(req, res);
  if (!m) return;
  const t = db.prepare('SELECT id, name FROM templates WHERE id = ?').get(Number(req.body.template_id));
  if (!t) { flash(req, 'error', 'اختر جدولاً.'); return res.redirect(req.get('referer') || `/members/${m.id}`); }
  P.assign(m.id, t.id);
  N.notify({ member: m.id }, { title: ['جدولك الجديد: {name} 📋', { name: t.name }], body: 'افتح "جدولي" لتطّلع عليه', link: '/me/program' });
  if (m.trainer_id && m.trainer_id !== req.session.user.id) N.notify({ user: m.trainer_id }, { title: ['أصبح {name} على جدول {tpl}', { name: m.name, tpl: t.name }], link: `/members/${m.id}/program` });
  flash(req, 'success', ['أصبح {name} على جدول {tpl}. يمكنك التعديل عليه هنا.', { name: m.name, tpl: t.name }]);
  res.redirect(`/members/${m.id}/program`);
});

const addMemberDay = (req, res) => {
  const m = memberFor(req, res);
  if (!m) return;
  const u = req.session.user;
  if (u.role === 'reception') return res.status(403).render('error', { title: 'غير مسموح', message: 'تعديل جدول المشترك متاح للمدرّب والمشترك فقط.' });
  const day = P.addDay({ memberId: m.id });
  res.redirect(`${u.role === 'member' ? '/me/program' : `/members/${m.id}/program`}#day-${day}`);
};
r.post('/members/:id/program/days', allow('admin', 'trainer'), addMemberDay);
r.post('/me/program/days', allow('member'), addMemberDay);

// ---------- one day (template or member), same form everywhere ----------

const dayAndBack = (req) => {
  const day = db.prepare('SELECT * FROM program_days WHERE id = ?').get(Number(req.params.id));
  const u = req.session.user;
  const back = !day ? '/' : day.template_id ? `/templates/${day.template_id}` : u.role === 'member' ? '/me/program' : `/members/${day.member_id}/program`;
  return { day, back };
};

function tellOtherSide(req, day) {
  if (!day.member_id) return;
  const u = req.session.user;
  const m = db.prepare('SELECT id, name, trainer_id FROM members WHERE id = ?').get(day.member_id);
  if (u.role === 'member' && m.trainer_id) N.notify({ user: m.trainer_id }, { title: ['عدّل {name} جدوله (اليوم {n})', { name: m.name, n: day.day_no }], link: `/members/${m.id}/program#day-${day.id}` });
  if (u.role !== 'member') N.notify({ member: m.id }, { title: ['عدّل المدرّب جدولك (اليوم {n}) 📋', { n: day.day_no }], link: `/me/program#day-${day.id}` });
}

r.post('/program-days/:id', allow('admin', 'reception', 'trainer', 'member'), (req, res) => {
  const { day, back } = dayAndBack(req);
  if (!P.canEdit(req.session.user, day)) return res.status(403).render('error', { title: 'غير مسموح', message: 'لا يمكنك تعديل هذا اليوم.' });
  const n = P.saveDay(day.id, req.body);
  tellOtherSide(req, day);
  flash(req, 'success', ['تم حفظ اليوم {d} ({n} تمارين).', { d: day.day_no, n }]);
  res.redirect(`${back}#day-${day.id}`);
});

r.post('/program-days/:id/delete', allow('admin', 'reception', 'trainer', 'member'), (req, res) => {
  const { day, back } = dayAndBack(req);
  if (!P.canEdit(req.session.user, day)) return res.status(403).render('error', { title: 'غير مسموح', message: 'لا يمكنك تعديل هذا اليوم.' });
  P.deleteDay(day.id);
  tellOtherSide(req, day);
  flash(req, 'success', ['تم حذف اليوم {d}.', { d: day.day_no }]);
  res.redirect(back);
});

module.exports = r;
