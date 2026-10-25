// All dates are local 'YYYY-MM-DD' strings, so SQLite compares them as text.
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const stamp = (d) => `${fmt(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

// The gym is open past midnight (iron closes at 6 AM), so a "gym day" runs 06:00 → 06:00.
// A check-in at 2 AM on the 17th belongs to the 16th: same visit, same subscription day.
const DAY_CUTOFF_HOUR = 6;
const gymDay = (at = new Date()) => fmt(new Date(at.getTime() - DAY_CUTOFF_HOUR * 3600 * 1000));
const today = () => gymDay();

function addDays(s, n) {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return fmt(d);
}

// Jan 31 + 1 month = Feb 28/29, not Mar 3.
function addMonths(s, n) {
  const d = parse(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return fmt(d);
}

// Inclusive end: a 1-month plan starting Oct 17 ends Nov 16.
const endDate = (start, months) => addDays(addMonths(start, months), -1);

const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);

// Renewing early starts the day after the current end, so no days are lost.
const renewalStart = (currentEnd, now = today()) =>
  currentEnd && currentEnd >= now ? addDays(currentEnd, 1) : now;

const EXPIRING_DAYS = 7;

// sub: { start_date, end_date } or undefined (latest subscription of one type)
function status(sub, now = today()) {
  if (!sub) return 'none';
  if (sub.end_date < now) return 'expired';
  if (sub.start_date > now) return 'upcoming';
  return daysBetween(now, sub.end_date) <= EXPIRING_DAYS ? 'expiring' : 'active';
}

function age(birth, now = today()) {
  const [by, bm, bd] = birth.split('-').map(Number);
  const [ny, nm, nd] = now.split('-').map(Number);
  return ny - by - (nm < bm || (nm === bm && nd < bd) ? 1 : 0);
}

module.exports = { pad, fmt, parse, stamp, gymDay, today, addDays, addMonths, endDate, daysBetween, renewalStart, status, age, EXPIRING_DAYS, DAY_CUTOFF_HOUR };
