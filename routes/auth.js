const express = require('express');
const crypto = require('node:crypto');
const { db, hashPassword, checkPassword } = require('../db');
const { sendSms } = require('../notify');
const { DEMO } = require('../mw');

const r = express.Router();
const { cleanInput: clean, normPhone, forgivingPassword } = require('../core');

// ponytail: per-IP lockout in memory, resets on restart
const fails = new Map();
const locked = (ip) => (fails.get(ip)?.until || 0) > Date.now();
function fail(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 10) { f.n = 0; f.until = Date.now() + 15 * 60 * 1000; }
  fails.set(ip, f);
}

function start(req, res, user) {
  req.session.regenerate(() => { req.session.user = user; res.redirect(user.role === 'member' ? '/me' : '/'); });
}

r.get('/login', (req, res) => res.render('login', { error: null }));
// Staff log in with a username, members with their phone number.
r.post('/login', (req, res) => {
  if (locked(req.ip)) return res.status(429).render('login', { error: 'محاولات كثيرة. حاول بعد 15 دقيقة.' });
  const login = clean(req.body.username);
  const typed = String(req.body.password || '');
  const forgiven = forgivingPassword(typed);
  const pwOk = (hash) => checkPassword(typed, hash) || (forgiven !== typed && checkPassword(forgiven, hash));
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(login);
  if (u && pwOk(u.password_hash)) { fails.delete(req.ip); return start(req, res, { id: u.id, name: u.name, role: u.role }); }
  const m = db.prepare('SELECT id, name, password_hash FROM members WHERE phone = ?').get(normPhone(login));
  if (m && pwOk(m.password_hash)) { fails.delete(req.ip); return start(req, res, { id: m.id, name: m.name, role: 'member' }); }
  fail(req.ip);
  // Demo only: say WHY a sign-in failed in the server log (never the password, only its shape) to debug phone keyboards
  if (DEMO) {
    const odd = [...typed].filter((ch) => ch.charCodeAt(0) > 126).map((ch) => 'U+' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
    console.log(`[login failed] "${login}" → ${u ? 'staff account' : m ? 'member account' : 'no such account'}; password length ${typed.length}${odd.length ? `, unusual characters ${odd.join(' ')}` : ''}${typed !== typed.trim() ? ', has spaces at the ends' : ''}`);
  }
  res.status(401).render('login', { error: m && !m.password_hash ? 'حسابك غير مفعّل بعد. اضغط "تفعيل حساب المشترك" لتفعيله أول مرة.' : 'بيانات الدخول غير صحيحة.' });
});
r.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// ---- OTP ----
// New member (first time only): phone + national ID + birth date must match what the gym registered.
// Forgot password: phone only. Both then get a 6-digit code by SMS and set a password.
const OTP_TTL = 5 * 60 * 1000;
const RESEND_AFTER = 60 * 1000;
const MAX_TRIES = 5;
const hashCode = (code) => crypto.createHash('sha256').update(code).digest('hex');
const page = (mode, extra = {}) => ({ mode, step: 1, error: null, phone: '', demoCode: null, ...extra });

function sendCode(res, mode, phone) {
  const prev = db.prepare('SELECT sent_at FROM otps WHERE phone = ?').get(phone);
  if (prev && Date.now() - prev.sent_at < RESEND_AFTER) {
    return res.render('activate', page(mode, { step: 2, phone, error: 'أُرسل الرمز قبل قليل. انتظر دقيقة قبل طلب رمز جديد.' }));
  }
  const code = String(crypto.randomInt(100000, 1000000));
  db.prepare(`INSERT INTO otps (phone, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?)
    ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at`)
    .run(phone, hashCode(code), Date.now() + OTP_TTL, Date.now());
  sendSms(phone, `IRON MAN: رمز التحقق ${code}. صالح لمدة 5 دقائق.`);
  res.render('activate', page(mode, { step: 2, phone, demoCode: DEMO ? code : null }));
}

r.get('/activate', (req, res) => res.render('activate', page('new')));
r.get('/forgot', (req, res) => res.render('activate', page('forgot')));

r.post('/activate', (req, res) => {
  if (locked(req.ip)) return res.status(429).render('activate', page('new', { error: 'محاولات كثيرة. حاول بعد 15 دقيقة.' }));
  const phone = normPhone(req.body.phone);
  const m = db.prepare('SELECT id, password_hash FROM members WHERE phone = ? AND national_id = ? AND birth_date = ?')
    .get(phone, clean(req.body.national_id), clean(req.body.birth_date));
  if (!m) { fail(req.ip); return res.status(400).render('activate', page('new', { phone, error: 'لم نجد مشتركاً مسجّلاً بهذه البيانات. يسجّلك الاستقبال أولاً، ثم تفعّل حسابك هنا. إذا كنت مسجّلاً فتأكد من الرقم الوطني وتاريخ الميلاد.' })); }
  if (m.password_hash) return res.status(400).render('activate', page('forgot', { phone, error: 'حسابك مفعّل مسبقاً. إذا نسيت كلمة المرور فاطلب رمزاً جديداً من هنا.' }));
  sendCode(res, 'new', phone);
});

r.post('/forgot', (req, res) => {
  if (locked(req.ip)) return res.status(429).render('activate', page('forgot', { error: 'محاولات كثيرة. حاول بعد 15 دقيقة.' }));
  const phone = normPhone(req.body.phone);
  const m = db.prepare('SELECT password_hash FROM members WHERE phone = ?').get(phone);
  if (m && !m.password_hash) return res.status(400).render('activate', page('new', { phone, error: 'حسابك غير مفعّل بعد. فعّله أول مرة بالرقم الوطني وتاريخ الميلاد.' }));
  // Unknown number: same screen, no code, so the page doesn't reveal who is a member.
  if (!m) { fail(req.ip); return res.render('activate', page('forgot', { step: 2, phone })); }
  sendCode(res, 'forgot', phone);
});

// Step 2: code + new password
r.post('/activate/verify', (req, res) => {
  const phone = normPhone(req.body.phone);
  const otp = db.prepare('SELECT * FROM otps WHERE phone = ?').get(phone);
  const mode = req.body.mode === 'new' ? 'new' : 'forgot';
  const again = (error) => res.status(400).render('activate', page(mode, { step: 2, error, phone }));
  if (!otp || otp.expires_at < Date.now()) return res.status(400).render('activate', page(mode, { phone, error: 'انتهت صلاحية الرمز أو أنه غير صحيح. اطلب رمزاً جديداً.' }));
  if (otp.attempts >= MAX_TRIES) return res.status(429).render('activate', page(mode, { phone, error: 'محاولات كثيرة. اطلب رمزاً جديداً.' }));
  db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE phone = ?').run(phone);
  const given = Buffer.from(hashCode(clean(req.body.code)), 'hex');
  if (!crypto.timingSafeEqual(given, Buffer.from(otp.code_hash, 'hex'))) return again(['الرمز غير صحيح. المحاولات المتبقية: {n}.', { n: MAX_TRIES - otp.attempts - 1 }]);
  const pw = String(req.body.password || '');
  if (pw.length < 8) return again('يجب أن تتكون كلمة المرور من 8 أحرف على الأقل.');
  if (pw !== req.body.password2) return again('كلمتا المرور غير متطابقتين.');
  const m = db.prepare('SELECT id, name FROM members WHERE phone = ?').get(phone);
  db.prepare('UPDATE members SET password_hash = ? WHERE id = ?').run(hashPassword(pw), m.id);
  db.prepare('DELETE FROM otps WHERE phone = ?').run(phone);
  start(req, res, { id: m.id, name: m.name, role: 'member' });
});

module.exports = r;
