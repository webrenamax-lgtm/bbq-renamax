/* order.js — онлайн-замовлення BBQ Renamax.
 * «+» у меню → кошик → форма → POST на релей (Cloudflare Worker, папка worker/) → Telegram власнику.
 * Налаштування: content.json → "order": { enabled, endpoint, note, step_kg }.
 * Працює, коли enabled = true і задано endpoint. Тест без відправки: відкрийте сайт з ?demo в адресі. */
(() => {
  'use strict';
  const DEMO = new URLSearchParams(location.search).has('demo');
  const KEY_CART = 'bbq_cart_v1';
  const KEY_ME = 'bbq_me_v1';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const dlg = $('#order');
  const form = $('#od-form');
  const bar = $('#cartbar');
  if (!dlg || !form || !bar || typeof dlg.showModal !== 'function') return;

  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* приватний режим — без збереження */ } },
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const qtyText = (q, u) => String(+q.toFixed(2)).replace('.', ',') + ' ' + u;
  const plural = (n, f) => { const a = n % 10, b = n % 100; return f[a === 1 && b !== 11 ? 0 : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 1 : 2]; };
  const normNum = (t) => String(t || '').replace(/(\d)[\s ]+(?=\d)/g, '$1');
  const toNum = (s) => parseFloat(String(s).replace(',', '.'));
  // «650 грн/кг» → 650; «Соус сакартвело - 150 грн» → 150; «Соуси 100 гр - 50 грн» → 50
  const grn = (t) => { const m = normNum(t).match(/(\d+(?:[.,]\d+)?)\s*грн/i); return m ? toNum(m[1]) : 0; };
  const priceOf = (t) => { if (grn(t)) return grn(t); const m = normNum(t).match(/\d+(?:[.,]\d+)?/); return m ? toNum(m[0]) : 0; };
  const unitOf = (t) => (/шт|порц/i.test(t || '') ? 'шт' : 'кг');

  /* ---------- час за Києвом ---------- */
  const TZ = (() => { try { new Intl.DateTimeFormat('en', { timeZone: 'Europe/Kyiv' }); return 'Europe/Kyiv'; } catch (e) { return 'Europe/Kiev'; } })();
  const nowMin = () => {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const g = (t) => +((p.find((x) => x.type === t) || {}).value || 0);
    return (g('hour') % 24) * 60 + g('minute');
  };
  const hhmm = (m) => { m = ((Math.round(m) % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
  const toMin = (s) => { const m = /(\d{1,2})[:.](\d{2})/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };

  /* ---------- стан ---------- */
  let C = null;
  let cfg = {};
  let wired = false;
  let sending = false;
  let mode = 'open';
  let shop = { open: 600, close: 1140 };
  const saved = ls.get(KEY_CART) || {};
  let cart = saved.items && typeof saved.items === 'object' ? saved.items : {};      // назва → { qty, unit, price }
  let extras = saved.extras && typeof saved.extras === 'object' ? saved.extras : {}; // назва → кількість
  const save = () => ls.set(KEY_CART, { items: cart, extras });
  const step = (u) => (u === 'шт' ? 1 : +cfg.step_kg > 0 ? +cfg.step_kg : 0.5);
  const total = () =>
    Object.values(cart).reduce((s, it) => s + (it.price || 0) * it.qty, 0) +
    Object.entries(extras).reduce((s, [t, q]) => s + grn(t) * q, 0);

  const menuRows = () => $$('#menu [data-list="services"] .dish');
  const rowInfo = (row) => {
    const p = ($('.price', row) || {}).textContent || '';
    return { title: (($('h3', row) || {}).textContent || '').trim(), price: priceOf(p), unit: unitOf(p) };
  };
  const extraTitles = () => $$('#menu [data-list="extras"] .chip').map((el) => el.textContent.trim()).filter(Boolean);

  /* ---------- рендер ---------- */
  function control(kind, title, q, label) {
    const a = `data-${kind}="${esc(title)}"`;
    if (!q) return `<button type="button" class="add" ${a} data-d="1" aria-label="Додати: ${esc(title)}"><span>+</span></button>`;
    return `<div class="step"><button type="button" ${a} data-d="-1" aria-label="Менше: ${esc(title)}"><span>−</span></button>` +
      `<span class="q">${label}</span>` +
      `<button type="button" ${a} data-d="1" aria-label="Більше: ${esc(title)}"><span>+</span></button></div>`;
  }

  function renderRows() {
    menuRows().forEach((row) => {
      const { title } = rowInfo(row);
      let ctl = $('.ctl', row);
      if (!ctl) { ctl = document.createElement('div'); ctl.className = 'ctl'; row.appendChild(ctl); }
      const it = cart[title];
      ctl.innerHTML = control('item', title, it && it.qty, it ? qtyText(it.qty, it.unit) : '');
    });
  }

  function renderBar() {
    const n = Object.keys(cart).length;
    bar.hidden = !n;
    document.body.classList.toggle('has-cart', !!n);
    $('#cb-count').textContent = `${n} ${plural(n, ['позиція', 'позиції', 'позицій'])}`;
    const s = total();
    $('#cb-sum').textContent = s ? `≈ ${money(s)} грн` : '';
  }

  function renderDialog() {
    const titles = Object.keys(cart);
    $('#od-items').innerHTML = titles.length
      ? titles.map((t) => {
          const it = cart[t];
          const sub = it.price ? `${money(it.price)} грн/${it.unit} · ≈ ${money(it.price * it.qty)} грн` : 'ціну уточнимо';
          return `<li><div class="od-it"><b>${esc(t)}</b><small>${sub}</small></div>${control('item', t, it.qty, qtyText(it.qty, it.unit))}</li>`;
        }).join('')
      : '<li class="od-empty">Кошик порожній — <a href="#menu" data-close>оберіть страви в меню</a>.</li>';
    const ex = extraTitles();
    $('#od-extras-wrap').hidden = !ex.length;
    $('#od-extras').innerHTML = ex.map((t) => {
      const q = extras[t] || 0;
      const p = grn(t);
      const sub = q && p ? `<small>≈ ${money(p * q)} грн</small>` : '';
      return `<li><div class="od-it"><b>${esc(t)}</b>${sub}</div>${control('extra', t, q, q + ' шт')}</li>`;
    }).join('');
    $('#od-sum').textContent = `${money(total())} грн`;
    $('#od-send').disabled = sending || !titles.length;
  }

  function commit() { save(); renderRows(); renderBar(); if (dlg.open) renderDialog(); }

  function changeItem(title, d) {
    let it = cart[title];
    if (!it) {
      const row = menuRows().find((r) => rowInfo(r).title === title);
      if (!row || d < 0) return;
      const i = rowInfo(row);
      it = { qty: 0, unit: i.unit, price: i.price };
    }
    it.qty = Math.min(100, Math.max(0, Math.round((it.qty + d * step(it.unit)) * 100) / 100));
    if (it.qty > 0) cart[title] = it; else delete cart[title];
    commit();
  }

  function changeExtra(title, d) {
    const q = Math.min(20, Math.max(0, (extras[title] || 0) + d));
    if (q) extras[title] = q; else delete extras[title];
    commit();
  }

  // після перемальовування повертаємо фокус на ту саму кнопку (для клавіатури)
  function refocus(root, attr, key, d) {
    const k = window.CSS && CSS.escape ? CSS.escape(key) : key.replace(/"/g, '\\"');
    const el = root.querySelector(`[${attr}="${k}"][data-d="${d}"]`) || root.querySelector(`[${attr}="${k}"]`);
    if (el) el.focus({ preventScroll: true });
  }

  /* ---------- коли забере ---------- */
  function setupWhen() {
    const n = nowMin();
    mode = n < shop.open ? 'before' : n >= shop.close ? 'after' : 'open';
    const chips = $('#od-chips');
    const note = $('#od-closed');
    const t = $('#od-time');
    t.min = hhmm(shop.open);
    t.max = hhmm(shop.close);
    if (mode === 'open') {
      chips.hidden = false;
      note.hidden = true;
      $$('input[name="when"]', chips).forEach((r) => {
        const m = parseInt(r.value, 10);
        if (m) r.closest('label').hidden = n + m > shop.close;
      });
      let cur = $('input[name="when"]:checked', chips);
      if (!cur || cur.closest('label').hidden) { cur = $('input[value="asap"]', chips); cur.checked = true; }
      t.hidden = cur.value !== 'time';
    } else {
      chips.hidden = true;
      note.hidden = false;
      t.hidden = false;
      note.textContent = mode === 'before'
        ? `Відкриваємось о ${hhmm(shop.open)}. На котру годину приготувати сьогодні?`
        : `Сьогодні вже зачинено (працюємо до ${hhmm(shop.close)}). На котру годину приготувати завтра?`;
    }
  }

  const choice = () => ($('#od-chips input[name="when"]:checked') || {}).value;
  const needTime = () => mode !== 'open' || choice() === 'time';

  function whenText() {
    const n = nowMin();
    const t = $('#od-time').value;
    if (mode === 'open') {
      const v = choice();
      if (v === 'asap') return `якнайшвидше (замовлено о ${hhmm(n)})`;
      if (v === '30' || v === '60') return `сьогодні ~${hhmm(n + +v)} (через ${v === '60' ? '1 год' : '30 хв'})`;
      return `сьогодні о ${t}`;
    }
    return `${mode === 'after' ? 'завтра' : 'сьогодні'} о ${t}`;
  }

  /* ---------- перевірка й відправка ---------- */
  function validate() {
    if (!Object.keys(cart).length) return ['Кошик порожній — додайте страви з меню.'];
    if (needTime()) {
      const m = toMin($('#od-time').value);
      if (m == null) return ['Вкажіть час, коли заберете замовлення.', '#od-time'];
      if (m < shop.open || m > shop.close) return [`Ми працюємо з ${hhmm(shop.open)} до ${hhmm(shop.close)} — оберіть час у цих межах.`, '#od-time'];
      if (mode === 'open' && m < nowMin()) return ['Цей час уже минув — оберіть пізніший.', '#od-time'];
    }
    if ($('#od-name').value.trim().length < 2) return ["Вкажіть, як до вас звертатися.", '#od-name'];
    const d = $('#od-phone').value.replace(/\D/g, '');
    if (d.length < 9 || d.length > 15) return ['Перевірте номер телефону — нам потрібно вам передзвонити.', '#od-phone'];
    return null;
  }

  function payload() {
    return {
      items: Object.entries(cart).map(([title, it]) => ({ title, qty: it.qty, unit: it.unit, price: it.price || 0 })),
      extras: Object.entries(extras).map(([title, qty]) => ({ title, qty, price: grn(title) })),
      when: whenText(),
      name: $('#od-name').value.trim(),
      phone: $('#od-phone').value.trim(),
      comment: $('#od-comment').value.trim(),
      company_site: $('#od-hp').value,
      elapsed: Math.round(performance.now()),
    };
  }

  const telLink = () => {
    const c = (C && C.contacts) || {};
    return `<a href="tel:${esc(c.phone || '+380686427777')}">${esc(c.phone_display || '068 642 77 77')}</a>`;
  };

  function showErr(html, field) {
    const box = $('#od-err');
    box.innerHTML = html;
    box.hidden = false;
    $$('[aria-invalid]', form).forEach((el) => el.removeAttribute('aria-invalid'));
    if (field) { const el = $(field); el.setAttribute('aria-invalid', 'true'); el.focus(); }
    else box.scrollIntoView({ block: 'nearest' });
  }
  function hideErr() {
    const box = $('#od-err');
    box.hidden = true;
    box.textContent = '';
    $$('[aria-invalid]', form).forEach((el) => el.removeAttribute('aria-invalid'));
  }

  function setSending(v) {
    sending = v;
    const b = $('#od-send');
    b.disabled = v || !Object.keys(cart).length;
    b.textContent = v ? 'Надсилаємо…' : 'Надіслати замовлення';
  }

  const FIELD_ERR = {
    name: ["Вкажіть, як до вас звертатися.", '#od-name'],
    phone: ['Перевірте номер телефону.', '#od-phone'],
    items: ['Кошик порожній — додайте страви з меню.'],
  };
  const SERVER_ERR = { rate: 'Забагато замовлень за короткий час.', too_fast: 'Не вдалося надіслати — натисніть ще раз.' };

  async function submit(e) {
    e.preventDefault();
    if (sending) return;
    hideErr();
    const bad = validate();
    if (bad) return showErr(esc(bad[0]), bad[1]);
    const data = payload();
    setSending(true);
    let res = null;
    try {
      if (DEMO) {
        await new Promise((r) => setTimeout(r, 700));
        res = { ok: true, id: 'DEMO' };
      } else {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        try {
          const r = await fetch(cfg.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, // «простий» запит — без CORS-preflight
            body: JSON.stringify(data),
            signal: ctrl.signal,
          });
          res = await r.json().catch(() => null);
          if (res && !r.ok) res.ok = false;
        } finally { clearTimeout(timer); }
      }
    } catch (ex) { res = null; }
    setSending(false);
    if (res && res.ok) return success(res.id, data);
    if (res && res.error === 'validation' && FIELD_ERR[res.field]) {
      const [m, f] = FIELD_ERR[res.field];
      return showErr(esc(m), f);
    }
    const m = (res && SERVER_ERR[res.error]) || 'Не вдалося надіслати замовлення.';
    showErr(`${esc(m)} Або подзвоніть — приймемо по телефону: ${telLink()}`);
  }

  function success(id, data) {
    ls.set(KEY_ME, { name: data.name, phone: data.phone });
    cart = {};
    extras = {};
    save();
    renderRows();
    renderBar();
    $('#od-comment').value = '';
    $('#od-time').value = '';
    $('#od-chips input[value="asap"]').checked = true;
    $('#od-num').textContent = '#' + id;
    $('#od-preview-wrap').hidden = !DEMO;
    if (DEMO) $('#od-preview').textContent = preview(data, id);
    form.hidden = true;
    $('#od-done').hidden = false;
    $('.od-thanks').focus();
  }

  // у демо-режимі показуємо, як замовлення виглядатиме в Telegram (той самий формат, що й у worker/)
  function preview(d, id) {
    const L = [`🔥 Нове замовлення #${id}`, ''];
    let sum = 0;
    d.items.forEach((it) => {
      if (it.price) { const s = Math.round(it.qty * it.price); sum += s; L.push(`• ${it.title} — ${qtyText(it.qty, it.unit)} × ${money(it.price)} = ${money(s)} грн`); }
      else L.push(`• ${it.title} — ${qtyText(it.qty, it.unit)}`);
    });
    d.extras.forEach((x) => {
      if (x.price) { const s = Math.round(x.qty * x.price); sum += s; L.push(`+ ${x.title} — ${x.qty} шт = ${money(s)} грн`); }
      else L.push(`+ ${x.title} — ${x.qty} шт`);
    });
    L.push('');
    if (sum) L.push(`💰 Орієнтовно: ${money(sum)} грн`);
    L.push(`⏰ Забере: ${d.when}`, `👤 ${d.name}`, `📞 ${d.phone}`);
    if (d.comment) L.push(`💬 ${d.comment}`);
    return L.join('\n');
  }

  function showForm() { form.hidden = false; $('#od-done').hidden = true; }

  function openDialog() {
    if (dlg.open) return;
    showForm();
    hideErr();
    renderDialog();
    setupWhen();
    const me = ls.get(KEY_ME) || {};
    if (me.name && !$('#od-name').value) $('#od-name').value = me.name;
    if (me.phone && !$('#od-phone').value) $('#od-phone').value = me.phone;
    document.documentElement.classList.add('modal-open');
    dlg.showModal();
  }

  function wire() {
    if (wired) return;
    wired = true;
    $('#menu').addEventListener('click', (e) => {
      const b = e.target.closest('[data-item]');
      if (!b) return;
      changeItem(b.dataset.item, +b.dataset.d);
      refocus($('#menu'), 'data-item', b.dataset.item, b.dataset.d);
    });
    $('#cb-open').addEventListener('click', openDialog);
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.closest('[data-close]')) return dlg.close();
      const b = e.target.closest('[data-item],[data-extra]');
      if (!b) return;
      if (b.dataset.item != null) {
        changeItem(b.dataset.item, +b.dataset.d);
        refocus(dlg, 'data-item', b.dataset.item, b.dataset.d);
      } else {
        changeExtra(b.dataset.extra, +b.dataset.d);
        refocus(dlg, 'data-extra', b.dataset.extra, b.dataset.d);
      }
    });
    dlg.addEventListener('close', () => {
      document.documentElement.classList.remove('modal-open');
      if (!$('#od-done').hidden) showForm();
    });
    $('#od-chips').addEventListener('change', () => {
      const t = $('#od-time');
      t.hidden = choice() !== 'time';
      if (!t.hidden) t.focus();
    });
    form.addEventListener('submit', submit);
  }

  /* ---------- старт ---------- */
  function init(c) {
    C = c || null;
    cfg = (C && C.order) || {};
    const on = DEMO || !!(cfg.enabled && cfg.endpoint);
    $$('[data-order-on]').forEach((el) => { el.hidden = !on; });
    $$('[data-order-off]').forEach((el) => { el.hidden = on; });
    if (!on) return;
    document.body.classList.add('ordering');
    $$('[data-order-text]').forEach((el) => { el.textContent = el.dataset.orderText; });

    // години роботи: order.hours («10:00-19:00») або перший робочий рядок графіка
    const firstOpen = ((C && C.hours) || []).find((h) => !h.closed);
    const times = Array.from(String(cfg.hours || (firstOpen && firstOpen.time) || '').matchAll(/(\d{1,2})[:.](\d{2})/g), (m) => +m[1] * 60 + +m[2]);
    if (times.length >= 2 && times[1] > times[0]) shop = { open: times[0], close: times[1] };

    // кошик зі збереженого — під актуальне меню (ціни могли змінитися, позиції — зникнути)
    const live = {};
    menuRows().forEach((r) => { const i = rowInfo(r); live[i.title] = i; });
    Object.keys(cart).forEach((t) => {
      const it = cart[t];
      if (!live[t] || !(it && it.qty > 0)) delete cart[t];
      else { it.price = live[t].price; it.unit = live[t].unit; }
    });
    const ex = new Set(extraTitles());
    Object.keys(extras).forEach((t) => { if (!ex.has(t) || !(extras[t] > 0)) delete extras[t]; });
    save();

    $('#od-demo').hidden = !DEMO;
    wire();
    renderRows();
    renderBar();
  }

  if (window.SITE_CONTENT !== undefined) init(window.SITE_CONTENT);
  else document.addEventListener('content:ready', (e) => init(e.detail), { once: true });
})();
