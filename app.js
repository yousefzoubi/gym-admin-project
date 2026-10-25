const express = require('express');
const session = require('express-session');
const crypto = require('node:crypto');
const path = require('node:path');
const { db } = require('./db');
const D = require('./dates');
const C = require('./core');
const N = require('./notify');
const { DEMO } = require('./mw');
const I = require('./i18n');
const S = require('./schedule');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));
// ponytail: in-memory sessions, everyone is logged out on restart; use a store (connect-sqlite3) if that matters
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 30 * 24 * 3600 * 1000 },
}));

// CSRF: sameSite=lax already drops the cookie on cross-site POSTs; this also rejects foreign Origin headers.
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (req.method === 'POST' && origin && new URL(origin).host !== req.get('host')) return res.status(403).send('Forbidden');
  next();
});
app.use((req, res, next) => (req.path === '/import' ? next() : express.urlencoded({ extended: false })(req, res, next)));
// Express 5 leaves req.body undefined for a POST with no fields (e.g. the punch button)
app.use((req, res, next) => { req.body ??= {}; next(); });

// Simple line chart: values → SVG points in a w×h box
function chart(values, w = 300, h = 80) {
  const v = values.filter((x) => x != null);
  if (v.length < 2) return null;
  const min = Math.min(...v), max = Math.max(...v), span = max - min || 1;
  const pts = v.map((y, i) => [Math.round((i / (v.length - 1)) * w), Math.round(h - 6 - ((y - min) / span) * (h - 12))]);
  return { w, h, min, max, points: pts.map((p) => p.join(',')).join(' '), last: pts[pts.length - 1] };
}

// Language: ?lang= link sets a cookie for a year; Arabic by default.
app.get('/lang/:code', (req, res) => {
  const lang = I.LANGS.includes(req.params.code) ? req.params.code : 'ar';
  res.cookie('lang', lang, { maxAge: 365 * 24 * 3600 * 1000, sameSite: 'lax', httpOnly: true });
  const back = req.get('referer');
  res.redirect(back && new URL(back).host === req.get('host') ? back : '/');
});

const translated = (dict, t) => Object.fromEntries(Object.entries(dict).map(([k, v]) => [k, t(v)]));

app.use((req, res, next) => {
  const u = req.session.user;
  const lang = /(?:^|;\s*)lang=en(?:;|$)/.test(req.headers.cookie || '') ? 'en' : 'ar';
  const t = (key, vars) => I.translate(lang, key, vars);
  const tt = (m) => I.msg(lang, m);
  req.lang = lang;
  Object.assign(res.locals, {
    lang, dir: lang === 'en' ? 'ltr' : 'rtl', t, tt, arrow: lang === 'en' ? '→' : '←',
    ask: (key, vars) => `return confirm(${JSON.stringify(t(key, vars))})`, // onsubmit="<%= ask('...') %>"
    // seeded data (default plans, the Excel templates, cleaning tasks): translated when we have it, else shown as typed
    td: (x) => (lang === 'en' && x && I.en[x] !== undefined ? I.en[x] : x),
    CATS: translated(C.CATS, t), STATUS: translated(C.STATUS, t), ROLES: translated(C.ROLES, t),
    PRODUCT_TYPES: translated(C.PRODUCT_TYPES, t), GOALS: translated(C.GOALS, t),
    money: (n) => tt(C.money(n)), fmtDur: (min) => tt(C.fmtDur(min)), ar: (x) => tt(S.ar(x)),
    showNote: (stored) => N.show(lang, stored),
    longDate: (d = new Date()) => d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'ar-JO-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
  });
  res.locals.user = u;
  res.locals.flash = req.session.flash;
  res.locals.path = req.path;
  res.locals.unread = !u ? 0 : db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE ${u.role === 'member' ? 'member_id' : 'user_id'} = ? AND read_at IS NULL`).get(u.id).n;
  Object.assign(res.locals, { maskId: C.maskId, today: D.today(), D, minutes: C.minutes, chart, DEMO });
  delete req.session.flash;
  next();
});

app.use(require('./routes/auth'));
app.use(require('./routes/programs'));
app.use(require('./routes/me'));
app.use(require('./routes/shop'));
app.use(require('./routes/staff'));

app.use((req, res) => res.status(404).render('error', { title: 'غير موجود', message: 'هذه الصفحة غير موجودة.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'حدث خطأ', message: 'حدث خطأ في الخادم. حاول مرة أخرى.' });
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`IRON MAN gym: http://localhost:${port}${DEMO ? '  (DEMO mode: OTP codes shown on screen)' : ''}`));
  // Reminder job: idempotent (dedupe keys), so every 10 minutes is fine.
  const tick = () => { try { N.run(); } catch (e) { console.error('reminders failed', e); } };
  tick();
  setInterval(tick, 10 * 60 * 1000);
}

module.exports = app;
