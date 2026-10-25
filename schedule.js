// Opening hours. A window whose close <= open runs past midnight (15:30 → 06:00 next day).
const D = require('./dates');

const at = (day, hm) => { const d = D.parse(day); const [h, m] = hm.split(':').map(Number); d.setHours(h, m, 0, 0); return d; };
const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
// Kickboxing members may check in this many minutes before class starts.
const EARLY_MIN = { iron: 0, kickboxing: 30 };

// data: { hours: [{category, weekday, open, close}], closures: [{day, category, closed, open, close, note}] }
function windowFor(data, category, day) {
  const exc = data.closures.filter((c) => c.day === day && (!c.category || c.category === category)).pop();
  if (exc && exc.closed) return null;
  const base = data.hours.find((h) => h.category === category && h.weekday === D.parse(day).getDay());
  const open = exc && exc.open ? exc.open : base && base.open;
  const close = exc && exc.close ? exc.close : base && base.close;
  if (!open || !close) return null;
  const start = at(day, open);
  const end = at(close <= open ? D.addDays(day, 1) : day, close);
  return { day, start, end, open, close, note: exc ? exc.note : '', changed: !!exc };
}

function windows(data, category, now = new Date(), ahead = 8) {
  const first = D.addDays(D.fmt(now), -1);
  const out = [];
  for (let i = 0; i <= ahead; i++) { const w = windowFor(data, category, D.addDays(first, i)); if (w) out.push(w); }
  return out;
}

// The window someone can check in to right now (with early entry), or null.
function current(data, category, now = new Date()) {
  const early = (EARLY_MIN[category] || 0) * 60000;
  return windows(data, category, now).find((w) => w.start - early <= now && now < w.end) || null;
}

function state(data, category, now = new Date()) {
  const ws = windows(data, category, now);
  const cur = ws.find((w) => w.start <= now && now < w.end);
  return { open: !!cur, current: cur || null, next: ws.find((w) => w.start > now) || null };
}

const hm = (d) => `${D.pad(d.getHours())}:${D.pad(d.getMinutes())}`;
// 12-hour time as an i18n message: "3:30 م" / "3:30 PM", from "15:30" or a Date
function ar(t) {
  const [h, m] = (typeof t === 'string' ? t : hm(t)).split(':').map(Number);
  return [h < 12 ? '{t} ص' : '{t} م', { t: `${h % 12 || 12}${m ? ':' + D.pad(m) : ''}` }];
}

function label(data, category, now = new Date()) {
  const s = state(data, category, now);
  const isToday = (w) => D.fmt(w.start) === D.fmt(now);
  const isTomorrow = (w) => D.fmt(w.start) === D.addDays(D.fmt(now), 1);
  // text is an i18n message
  if (s.open) return { open: true, text: ['مفتوح الآن، يغلق {t}', { t: ar(s.current.end) }] };
  if (!s.next) return { open: false, text: 'مغلق' };
  const t = ar(s.next.start), kb = category === 'kickboxing';
  // whole sentences per case, so each language can phrase "today"/"tomorrow" naturally
  if (isToday(s.next)) return { open: false, text: [kb ? 'مغلق، الحصة القادمة اليوم {t}' : 'مغلق، يفتح اليوم {t}', { t }] };
  if (isTomorrow(s.next)) return { open: false, text: [kb ? 'مغلق، الحصة القادمة غداً {t}' : 'مغلق، يفتح غداً {t}', { t }] };
  return { open: false, text: [kb ? 'مغلق، الحصة القادمة يوم {when} {t}' : 'مغلق، يفتح يوم {when} {t}', { when: WEEKDAYS[s.next.start.getDay()], t }] };
}

module.exports = { windowFor, windows, current, state, label, ar, hm, WEEKDAYS, EARLY_MIN };
