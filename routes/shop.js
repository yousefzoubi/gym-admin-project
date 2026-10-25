const express = require('express');
const { db, tx } = require('../db');
const D = require('../dates');
const C = require('../core');
const N = require('../notify');
const { flash, allow, STAFF } = require('../mw');

const r = express.Router();
const { PRODUCT_TYPES, money, num } = C;

// ---------- point of sale ----------

r.get('/shop', allow(...STAFF), (req, res) => {
  res.render('shop', {
    products: db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY type, name').all(),
    members: db.prepare('SELECT id, name, phone FROM members ORDER BY name').all(),
    todaySales: db.prepare(`SELECT s.*, m.name AS member_name, (SELECT group_concat(i.name || ' ×' || i.qty, '، ') FROM sale_items i WHERE i.sale_id = s.id) AS items
      FROM sales s LEFT JOIN members m ON m.id = s.member_id WHERE s.gym_day = ? ORDER BY s.id DESC`).all(D.today()),
  });
});

r.post('/shop/sell', allow(...STAFF), (req, res) => {
  const lines = Object.entries(req.body)
    .filter(([k, v]) => k.startsWith('qty_') && Number(v) > 0)
    .map(([k, v]) => ({ id: Number(k.slice(4)), qty: Math.floor(Number(v)) }));
  const method = req.body.method === 'account' ? 'account' : 'cash';
  const memberId = Number(String(req.body.member || '').split(' ')[0]) || null;
  if (!lines.length) { flash(req, 'error', 'اختر منتجاً واحداً على الأقل.'); return res.redirect('/shop'); }
  if (memberId && !db.prepare('SELECT 1 FROM members WHERE id = ?').get(memberId)) { flash(req, 'error', 'العضو غير موجود.'); return res.redirect('/shop'); }
  if (method === 'account' && !memberId) { flash(req, 'error', 'البيع على الحساب يتطلب اختيار عضو.'); return res.redirect('/shop'); }
  try {
    const total = tx(() => {
      let sum = 0;
      const items = lines.map((l) => {
        const p = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(l.id);
        if (!p) throw Object.assign(new Error('product'), { msg: 'المنتج غير موجود.' });
        // Atomic stock check: never sell what isn't on the shelf
        if (!db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').run(l.qty, p.id, l.qty).changes) throw Object.assign(new Error('stock'), { msg: ['الكمية غير كافية من {name} (المتوفر {n}).', { name: p.name, n: p.stock }] });
        sum += p.price * l.qty;
        return { p, qty: l.qty };
      });
      sum = Math.round(sum * 100) / 100;
      const saleId = Number(db.prepare('INSERT INTO sales (member_id, total, method, gym_day, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(memberId, sum, method, D.today(), req.session.user.id).lastInsertRowid);
      const ins = db.prepare('INSERT INTO sale_items (sale_id, product_id, name, qty, price, cost) VALUES (?, ?, ?, ?, ?, ?)');
      for (const { p, qty } of items) ins.run(saleId, p.id, p.name, qty, p.price, p.cost);
      return sum;
    });
    if (memberId) N.notify({ member: memberId }, { title: ['شراء من المتجر: {amount}', { amount: money(total) }], body: method === 'account' ? 'أُضيف إلى حسابك' : 'مدفوع نقداً', link: '/me/account' });
    flash(req, 'success', [method === 'account' ? 'تم البيع: {amount} (على حساب العضو).' : 'تم البيع: {amount} نقداً.', { amount: money(total) }]);
  } catch (e) {
    if (!e.msg) throw e;
    flash(req, 'error', e.msg);
  }
  res.redirect('/shop');
});

r.post('/shop/sales/:id/delete', allow('admin'), (req, res) => {
  tx(() => {
    for (const i of db.prepare('SELECT product_id, qty FROM sale_items WHERE sale_id = ?').all(Number(req.params.id))) {
      if (i.product_id) db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(i.qty, i.product_id);
    }
    db.prepare('DELETE FROM sales WHERE id = ?').run(Number(req.params.id));
  });
  flash(req, 'success', 'أُلغي البيع وأُعيدت الكمية إلى المخزون.');
  res.redirect(req.get('referer') || '/shop');
});

// ---------- products ----------

function cleanProduct(b) {
  const name = String(b.name || '').trim().slice(0, 100);
  const price = num(b.price), cost = num(b.cost), stock = num(b.stock), low = num(b.low_stock);
  const expiry = /^\d{4}-\d{2}-\d{2}$/.test(b.expiry_date || '') ? b.expiry_date : null;
  if (!name || !PRODUCT_TYPES[b.type] || !(price >= 0) || !(cost >= 0) || !Number.isInteger(stock) || stock < 0) return null;
  return { name, type: b.type, price, cost, stock, low_stock: Number.isInteger(low) && low >= 0 ? low : 3, expiry_date: expiry };
}

r.get('/shop/products', allow('admin'), (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : D.today().slice(0, 7);
  res.render('products', {
    products: db.prepare('SELECT * FROM products ORDER BY active DESC, type, name').all(),
    month,
    report: db.prepare(`SELECT i.name, SUM(i.qty) AS qty, SUM(i.qty * i.price) AS sales, SUM(i.qty * (i.price - i.cost)) AS profit
      FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE substr(s.gym_day, 1, 7) = ? GROUP BY i.name ORDER BY sales DESC`).all(month),
  });
});

r.post('/shop/products', allow('admin'), (req, res) => {
  const p = cleanProduct(req.body);
  if (!p) { flash(req, 'error', 'تحقق من بيانات المنتج.'); return res.redirect('/shop/products'); }
  db.prepare('INSERT INTO products (name, type, price, cost, stock, low_stock, expiry_date) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(p.name, p.type, p.price, p.cost, p.stock, p.low_stock, p.expiry_date);
  const n = req.body.announce ? N.broadcast({ title: ['منتج جديد في المتجر: {name}', { name: p.name }], body: money(p.price), link: '/me/shop', onlyOptedIn: 'notify_offers' }) : 0;
  flash(req, 'success', n ? ['تمت إضافة المنتج وأُرسل إشعار إلى {n} مشتركاً.', { n }] : 'تمت إضافة المنتج.');
  res.redirect('/shop/products');
});

r.post('/shop/products/:id', allow('admin'), (req, res) => {
  const p = cleanProduct(req.body);
  if (!p) flash(req, 'error', 'تحقق من بيانات المنتج.');
  else {
    db.prepare('UPDATE products SET name = ?, type = ?, price = ?, cost = ?, stock = ?, low_stock = ?, expiry_date = ?, active = ? WHERE id = ?')
      .run(p.name, p.type, p.price, p.cost, p.stock, p.low_stock, p.expiry_date, req.body.active ? 1 : 0, Number(req.params.id));
    flash(req, 'success', 'تم حفظ المنتج.');
  }
  res.redirect('/shop/products');
});

module.exports = r;
