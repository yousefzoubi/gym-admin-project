// text is an i18n message: a key or [key, vars]
const flash = (req, type, text, extra = {}) => { req.session.flash = { type, text, ...extra }; };

function allow(...roles) {
  return (req, res, next) => {
    const u = req.session.user;
    if (!u) return res.redirect('/login');
    if (!roles.includes(u.role)) return res.status(403).render('error', { title: 'غير مسموح', message: 'ليست لديك صلاحية لهذه الصفحة.' });
    next();
  };
}

const STAFF = ['admin', 'reception'];
const DEMO = process.env.DEMO !== '0';

module.exports = { flash, allow, STAFF, DEMO };
