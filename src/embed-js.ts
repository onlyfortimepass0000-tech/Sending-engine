/**
 * The script clients paste into their website:
 *   <script src="https://YOUR-WORKER/embed.js?key=PUBLIC_KEY" defer></script>
 * - Any <form data-enquiry="optional-form-name"> is posted to us as JSON (no page reload).
 * - <div data-enquiry-form></div> gets a minimal ready-made form.
 * - utm_* and the external referrer of the first page in the visit are sent as the lead's source.
 * Plain ES5-style JS on purpose (no build step). Keep backticks and dollar-braces out of this string.
 */
export const EMBED_JS = String.raw`(function () {
  'use strict';
  var script = document.currentScript || document.querySelector('script[src*="/embed.js?"]');
  if (!script || !script.src) return;
  var base, key;
  try { var u = new URL(script.src); base = u.origin; key = u.searchParams.get('key'); } catch (e) { return; }
  if (!key) return;
  if (window.EnquiryEngine && window.EnquiryEngine.key === key) return;

  var API = base + '/api/intake/' + encodeURIComponent(key);
  var UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  var OK = "Thanks! We've received your enquiry and will be in touch shortly.";
  var ERR = 'Sorry, something went wrong. Please try again.';
  var configPromise = null;

  // First touch of the visit: utm_* and the external referrer survive navigation to the contact page.
  function attribution() {
    var saved = {};
    try { saved = JSON.parse(sessionStorage.getItem('ee_attr') || '{}') || {}; } catch (e) {}
    try {
      var q = new URLSearchParams(location.search);
      UTM.forEach(function (k) { var v = q.get(k); if (v) saved[k] = v; });
      if (!saved.referrer && document.referrer && new URL(document.referrer).origin !== location.origin) saved.referrer = document.referrer;
      sessionStorage.setItem('ee_attr', JSON.stringify(saved));
    } catch (e) {}
    return saved;
  }

  function getConfig() {
    if (!configPromise) {
      configPromise = fetch(API + '/config', { headers: { accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { return j && j.ok ? j : null; })
        .catch(function () { return null; });
    }
    return configPromise;
  }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    (kids || []).forEach(function (c) { n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  function injectStyle() {
    if (document.getElementById('ee-style')) return;
    var s = el('style', { id: 'ee-style' }, [
      '.ee-form{max-width:480px;font:inherit}.ee-form label{display:block;margin:10px 0 4px;font-weight:600}' +
      '.ee-form input,.ee-form textarea{width:100%;box-sizing:border-box;padding:10px;border:1px solid #c9ced6;border-radius:8px;font:inherit}' +
      '.ee-form button{margin-top:14px;padding:10px 18px;border:0;border-radius:8px;background:#111;color:#fff;font:inherit;font-weight:600;cursor:pointer}' +
      '.ee-form button[disabled]{opacity:.6;cursor:default}.ee-msg{margin:10px 0;font-weight:600}.ee-err{color:#b91c1c}.ee-ok{color:#15803d}' +
      '.ee-consent{font-size:12px;opacity:.75;margin:10px 0 0}'
    ]);
    document.head.appendChild(s);
  }

  function ensureHoneypot(form) {
    if (form.querySelector('[name="website_hp"]')) return;
    form.appendChild(el('input', { type: 'text', name: 'website_hp', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true',
      style: 'position:absolute;left:-9999px;top:auto;width:1px;height:1px;opacity:0' }));
  }

  function showConsent(form) {
    getConfig().then(function (cfg) {
      if (!cfg || !cfg.consent_text) return;
      var slot = form.querySelector('[data-enquiry-consent]');
      if (slot) { slot.textContent = cfg.consent_text; return; }
      var p = el('p', { 'class': 'ee-consent' }, [cfg.consent_text]);
      var btn = form.querySelector('[type="submit"], button:not([type])');
      if (btn && btn.parentNode) btn.parentNode.insertBefore(p, btn); else form.appendChild(p);
    });
  }

  function say(msgEl, text, isErr) {
    msgEl.textContent = text;
    msgEl.className = 'ee-msg ' + (isErr ? 'ee-err' : 'ee-ok');
  }

  function busy(form, on) {
    var buttons = form.querySelectorAll('button, input[type="submit"]');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = on;
  }

  function send(form, msgEl) {
    var data = {};
    new FormData(form).forEach(function (v, k) {
      if (typeof v !== 'string') return;
      data[k] = Object.prototype.hasOwnProperty.call(data, k) ? data[k] + ', ' + v : v;
    });
    var attr = attribution();
    for (var k in attr) if (attr[k] && !(k in data)) data[k] = attr[k];
    data.page_url = location.href.split('#')[0].slice(0, 300);
    var tag = form.getAttribute('data-enquiry');
    if (tag) data.form = tag; else if (!data.form) data.form = 'website';

    busy(form, true);
    fetch(API, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok && j && j.ok === true, j: j || {} }; });
      })
      .then(function (res) {
        busy(form, false);
        if (!res.ok) { say(msgEl, res.j.message || ERR, true); return; }
        form.reset();
        say(msgEl, form.getAttribute('data-enquiry-success') || OK, false);
        form.dispatchEvent(new CustomEvent('enquiry:sent', { bubbles: true }));
        var to = form.getAttribute('data-enquiry-redirect');
        if (to && (to.indexOf('/') === 0 || /^https?:/i.test(to))) location.href = to;
      }, function () { busy(form, false); say(msgEl, ERR, true); });
  }

  function bind(form) {
    if (form.getAttribute('data-ee-bound')) return;
    form.setAttribute('data-ee-bound', '1');
    ensureHoneypot(form);
    showConsent(form);
    var msgEl = el('p', { 'class': 'ee-msg', role: 'status', 'aria-live': 'polite' });
    form.parentNode.insertBefore(msgEl, form.nextSibling);
    form.addEventListener('submit', function (e) { e.preventDefault(); send(form, msgEl); });
  }

  function render(box) {
    if (box.getAttribute('data-ee-rendered')) return;
    box.setAttribute('data-ee-rendered', '1');
    injectStyle();
    var form = el('form', { 'class': 'ee-form', 'data-enquiry': box.getAttribute('data-enquiry-form') || 'embed', novalidate: '' }, [
      el('label', { 'for': 'ee-name' }, ['Name']), el('input', { id: 'ee-name', name: 'name', type: 'text', autocomplete: 'name', required: '' }),
      el('label', { 'for': 'ee-email' }, ['Email']), el('input', { id: 'ee-email', name: 'email', type: 'email', autocomplete: 'email', required: '' }),
      el('label', { 'for': 'ee-phone' }, ['Phone (optional)']), el('input', { id: 'ee-phone', name: 'phone', type: 'tel', autocomplete: 'tel' }),
      el('label', { 'for': 'ee-message' }, ['How can we help?']), el('textarea', { id: 'ee-message', name: 'message', rows: '4', required: '' }),
      el('button', { type: 'submit' }, ['Send enquiry'])
    ]);
    form.removeAttribute('novalidate');
    box.appendChild(form);
    bind(form);
  }

  function scan() {
    var boxes = document.querySelectorAll('[data-enquiry-form]');
    for (var i = 0; i < boxes.length; i++) render(boxes[i]);
    var forms = document.querySelectorAll('form[data-enquiry]');
    for (var j = 0; j < forms.length; j++) bind(forms[j]);
  }

  window.EnquiryEngine = { key: key, scan: scan };
  attribution();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();
})();
`;
