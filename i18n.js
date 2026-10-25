// Arabic (MSA) is the source text and the key; English lives in locales/en.json.
// t('مرحباً {name}', { name }) → "Welcome Ali" in English, the Arabic itself otherwise.
const en = require('./locales/en.json');

const LANGS = ['ar', 'en'];
const missing = new Set(); // keys rendered in English with no translation (the i18n test checks this is empty)

function translate(lang, key, vars) {
  let s = key;
  if (lang === 'en') {
    if (en[key] !== undefined) s = en[key];
    else if (/[؀-ۿ]/.test(key)) missing.add(key);
  }
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => {
    if (vars[k] === undefined || vars[k] === null) return m;
    const v = vars[k];
    if (Array.isArray(v)) return msg(lang, v); // nested message, e.g. a duration or a time
    // values that are themselves UI words (حديد, منتهي...) get translated too; names and numbers pass through
    return lang === 'en' && typeof v === 'string' && en[v] !== undefined ? en[v] : String(v);
  });
}

// A message is a key, [key, vars], or a list of those joined with " · " (flash messages, check-in results, notifications).
function msg(lang, m) {
  if (m == null || m === '') return '';
  if (!Array.isArray(m)) return translate(lang, m);
  if (typeof m[0] !== 'string') return m.filter(Boolean).map((p) => msg(lang, p)).join(' · ');
  return translate(lang, m[0], m[1]);
}

module.exports = { LANGS, translate, msg, missing, en };
