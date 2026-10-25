// In-app notifications + SMS. Every reminder has a dedupe key, so run() can be called as often as we like.
// title/body are i18n messages (key or [key, vars]) stored as JSON, so each reader sees their own language.
const { db, scheduleData } = require('./db');
const D = require('./dates');
const S = require('./schedule');
const { CATS, statusMap, money } = require('./core');
const { msg } = require('./i18n');

// ponytail: SMS goes to the console until an SMS provider (Unifonic, Twilio...) is chosen; swap this one function
function sendSms(phone, text) {
  console.log(`[SMS → ${phone}] ${text}`);
}

// Free text typed by staff (announcements, closure reasons) is shown as-is in every language.
const raw = (text) => (text ? ['{x}', { x: text }] : '');

const insert = db.prepare(`INSERT OR IGNORE INTO notifications (member_id, user_id, title, body, link, dedupe_key)
  VALUES (?, ?, ?, ?, ?, ?)`);

// to: { member } or { user }. sms: also text the member's phone (important stuff only, in Arabic).
function notify(to, { title, body = '', link = '', key = null, sms = false }) {
  const r = insert.run(to.member || null, to.user || null, JSON.stringify(title), JSON.stringify(body), link, key);
  if (r.changes && sms && to.member) {
    const m = db.prepare('SELECT phone FROM members WHERE id = ?').get(to.member);
    if (m) sendSms(m.phone, `IRON MAN: ${msg('ar', title)}${body ? ' - ' + msg('ar', body) : ''}`);
  }
  return r.changes > 0;
}

// For display: a stored title/body back to text in the reader's language
const show = (lang, stored) => { try { return msg(lang, JSON.parse(stored)); } catch { return stored; } };

const staff = (...roles) => db.prepare(`SELECT id, role FROM users WHERE role IN (${roles.map(() => '?').join(',')})`).all(...roles);
const activeMembers = (category = null) => {
  const all = db.prepare('SELECT id, name, phone, birth_date, trainer_id, notify_hours, notify_absence, notify_offers FROM members').all();
  const sm = statusMap(all.map((m) => m.id));
  return all.filter((m) => {
    const s = sm.get(m.id);
    return Object.keys(CATS).some((c) => (!category || c === category) && s[c] && ['active', 'expiring'].includes(s[c].status));
  }).map((m) => ({ ...m, s: sm.get(m.id) }));
};

function broadcast({ category = null, onlyOptedIn = null, ...m }) {
  let n = 0;
  for (const x of activeMembers(category)) {
    if (onlyOptedIn && !x[onlyOptedIn]) continue;
    if (notify({ member: x.id }, { ...m, key: m.key ? `${m.key}:${x.id}` : null })) n++;
  }
  return n;
}

function run(now = new Date()) {
  const today = D.gymDay(now);
  const hour = now.getHours();
  const daytime = hour >= 6; // gym-day hours only, nobody wants a reminder at 3 AM
  const sched = scheduleData();
  const members = db.prepare('SELECT id, name, birth_date, trainer_id, notify_hours, notify_absence FROM members').all();
  const sm = statusMap(members.map((m) => m.id));
  let expiringToday = 0;

  for (const m of members) {
    const s = sm.get(m.id);
    for (const [cat, label] of Object.entries(CATS)) {
      const c = s[cat];
      if (!c || !daytime || hour < 10) continue;
      if (c.days === 3 || c.days === 2 || c.days === 1) {
        const when = { 1: 'ينتهي اشتراك {cat} غداً', 2: 'ينتهي اشتراك {cat} بعد يومين', 3: 'ينتهي اشتراك {cat} بعد 3 أيام' }[c.days];
        notify({ member: m.id }, { title: [when, { cat: label }], body: 'جدّد اشتراكك عند الاستقبال حتى لا ينقطع تمرينك 💪', link: '/me', key: `exp3:${m.id}:${cat}:${c.end_date}`, sms: true });
      } else if (c.days === 0) {
        expiringToday++;
        notify({ member: m.id }, { title: ['ينتهي اشتراك {cat} اليوم', { cat: label }], body: 'اليوم هو الأخير! جدّد اشتراكك عند الاستقبال.', link: '/me', key: `exp0:${m.id}:${cat}:${c.end_date}`, sms: true });
      } else if (c.days === -1) {
        notify({ member: m.id }, { title: ['انتهى اشتراك {cat}', { cat: label }], body: 'ننتظر عودتك، جدّد اشتراكك عند الاستقبال.', link: '/me', key: `expd:${m.id}:${cat}:${c.end_date}` });
      }
    }

    const active = Object.values(s).some((c) => ['active', 'expiring'].includes(c.status));
    if (active && daytime && hour >= 12) {
      const last = db.prepare('SELECT MAX(gym_day) AS d FROM attendance WHERE member_id = ?').get(m.id).d;
      if (last && D.daysBetween(last, today) >= 7) {
        const n = D.daysBetween(last, today);
        if (m.notify_absence) notify({ member: m.id }, { title: 'اشتقنا إليك 💪', body: ['مضى {n} يوماً على آخر زيارة لك. النادي بانتظارك!', { n }], link: '/me', key: `abs:${m.id}:${last}` });
        if (m.trainer_id) notify({ user: m.trainer_id }, { title: ['{name} غائب منذ {n} يوماً', { name: m.name, n }], link: `/members/${m.id}`, key: `tabs:${m.trainer_id}:${m.id}:${last}` });
      }
    }

    if (daytime && hour >= 9 && m.birth_date.slice(5) === today.slice(5)) {
      notify({ member: m.id }, { title: ['كل عام وأنت بخير يا {name} 🎂', { name: m.name.split(' ')[0] }], body: 'من فريق IRON MAN كاملاً', key: `bday:${m.id}:${today.slice(0, 4)}` });
    }

    // Class reminder at 5 PM on class days
    if (s.kickboxing && ['active', 'expiring'].includes(s.kickboxing.status) && m.notify_hours && hour >= 17) {
      const w = S.windowFor(sched, 'kickboxing', today);
      if (w && now < w.start) notify({ member: m.id }, { title: ['حصة الكيك بوكسينج اليوم الساعة {t} 🥊', { t: S.ar(w.start) }], body: w.changed ? raw(w.note) : '', link: '/me', key: `class:${m.id}:${today}` });
    }

    // Days with unusual hours (Thursday closes 1 AM, Friday 6-9 PM, holidays) at noon
    if (s.iron && ['active', 'expiring'].includes(s.iron.status) && m.notify_hours && hour >= 12) {
      const w = S.windowFor(sched, 'iron', today);
      if (w && (w.close !== '06:00' || w.changed)) {
        notify({ member: m.id }, { title: ['دوام الحديد اليوم: من {from} إلى {to}', { from: S.ar(w.start), to: S.ar(w.end) }], body: raw(w.note), link: '/me', key: `hours:${m.id}:${today}` });
      }
    }
  }

  // Closure reminders the evening before
  if (hour >= 18) {
    const tomorrow = D.addDays(today, 1);
    for (const c of db.prepare('SELECT * FROM closures WHERE day = ?').all(tomorrow)) {
      const where = c.category ? CATS[c.category] : 'النادي';
      broadcast({
        category: c.category,
        title: c.closed ? ['تذكير: {where} مغلق غداً', { where }] : ['تذكير: دوام الغد من {from} إلى {to}', { from: S.ar(c.open), to: S.ar(c.close) }],
        body: raw(c.note), key: `closure-pre:${c.id}`,
      });
    }
  }

  // Staff morning summary
  if (daytime && hour >= 10) {
    const yesterday = db.prepare('SELECT COUNT(DISTINCT member_id) AS n FROM attendance WHERE gym_day = ?').get(D.addDays(today, -1)).n;
    for (const u of staff('admin', 'reception')) {
      notify({ user: u.id }, { title: ['ملخص اليوم: {n} اشتراكات تنتهي اليوم', { n: expiringToday }], body: ['حضور الأمس: {n}', { n: yesterday }], link: '/dashboard', key: `sum:${u.id}:${today}` });
    }
  }

  // Shop: low stock and supplements close to expiry → admins
  for (const p of db.prepare('SELECT * FROM products WHERE active = 1').all()) {
    for (const u of staff('admin')) {
      if (p.stock <= p.low_stock) notify({ user: u.id }, { title: ['المخزون منخفض: {name}', { name: p.name }], body: ['المتبقي {n}', { n: p.stock }], link: '/shop/products', key: `low:${u.id}:${p.id}:${p.stock}` });
      if (p.expiry_date && D.daysBetween(today, p.expiry_date) <= 30) notify({ user: u.id }, { title: ['{name} ينتهي في {date}', { name: p.name, date: p.expiry_date }], body: ['الكمية: {n}', { n: p.stock }], link: '/shop/products', key: `pexp:${u.id}:${p.id}:${p.expiry_date}` });
    }
  }
}

const receipt = (memberId, amount) => notify({ member: memberId }, { title: ['تم تسجيل دفعة بقيمة {amount}', { amount: money(amount) }], body: 'شكراً لك 🙏', link: '/me/account' });

module.exports = { notify, broadcast, run, receipt, sendSms, activeMembers, raw, show };
