/**
 * BBQ Renamax — релей онлайн-замовлень (Cloudflare Worker).
 *
 * Сайт (GitHub Pages) надсилає сюди замовлення → воркер перевіряє його і пересилає в Telegram.
 * Токен бота живе тут, у секретах воркера, і ніколи не потрапляє в код сайту.
 *
 * Змінні воркера (Settings → Variables and Secrets):
 *   BOT_TOKEN        Secret  токен бота від @BotFather
 *   CHAT_ID          Secret  chat_id власника або групи (група: -100…); кілька — через кому
 *   ALLOWED_ORIGINS  Text    https://webrenamax-lgtm.github.io   (кілька — через кому)
 *
 * Захист від спаму: перевірка Origin, ліміт запитів з однієї IP, приховане поле-пастка,
 * мінімальний час заповнення, сувора валідація й обрізання полів.
 * Опційно можна підключити Rate Limiting binding з назвою ORDER_LIMITER — тоді ліміт надійніший.
 */

const MAX_BODY = 16 * 1024;                          // максимальний розмір запиту, байт
const MIN_FILL_MS = 1500;                            // швидше людина не встигає — це бот
const RATE = { count: 8, windowMs: 10 * 60 * 1000 }; // замовлень з однієї IP за 10 хв
const hits = new Map();

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = list(env.ALLOWED_ORIGINS);
    const originOk = allowed.length === 0 || allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': originOk && origin ? origin : allowed[0] || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method === 'GET') return text('BBQ Renamax order relay: OK', 200, cors);
    if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405, cors);
    if (!originOk) return json({ ok: false, error: 'origin' }, 403, cors);
    if (!env.BOT_TOKEN || !env.CHAT_ID) return json({ ok: false, error: 'config' }, 500, cors);

    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    if (!(await allow(ip, env))) return json({ ok: false, error: 'rate' }, 429, cors);

    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ ok: false, error: 'size' }, 413, cors);
    let data;
    try { data = JSON.parse(raw); } catch { return json({ ok: false, error: 'json' }, 400, cors); }
    if (!data || typeof data !== 'object') return json({ ok: false, error: 'json' }, 400, cors);

    // Поле-пастку бачать і заповнюють лише боти: відповідаємо «успіхом», нічого не надсилаючи.
    if (data.company_site) return json({ ok: true, id: orderId() }, 200, cors);
    if (typeof data.elapsed === 'number' && data.elapsed < MIN_FILL_MS) {
      return json({ ok: false, error: 'too_fast' }, 422, cors);
    }

    const order = clean(data);
    if (order.error) return json({ ok: false, error: 'validation', field: order.error }, 422, cors);

    const id = orderId();
    const message = format(order, id);
    const sent = await Promise.all(list(env.CHAT_ID).map((chat) => send(env.BOT_TOKEN, chat, message)));
    if (!sent.some(Boolean)) return json({ ok: false, error: 'telegram' }, 502, cors);
    return json({ ok: true, id }, 200, cors);
  },
};

/* ---------- валідація ---------- */

function clean(d) {
  const name = str(d.name, 60);
  const digits = String(d.phone ?? '').replace(/\D/g, '');
  if (name.length < 2) return { error: 'name' };
  if (digits.length < 9 || digits.length > 15) return { error: 'phone' };

  const items = arr(d.items, 40)
    .map((it) => ({
      title: str(it?.title, 80),
      qty: num(it?.qty, 0, 100),
      unit: it?.unit === 'шт' ? 'шт' : 'кг',
      price: num(it?.price, 0, 100000),
    }))
    .filter((it) => it.title && it.qty > 0);
  if (!items.length) return { error: 'items' };

  const extras = arr(d.extras, 20)
    .map((it) => ({ title: str(it?.title, 80), qty: Math.round(num(it?.qty, 0, 50)), price: num(it?.price, 0, 100000) }))
    .filter((it) => it.title && it.qty > 0);

  return {
    name,
    phone: phone(String(d.phone), digits),
    items,
    extras,
    when: str(d.when, 80) || 'не вказано',
    comment: str(d.comment, 500),
  };
}

const str = (v, max) =>
  String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const num = (v, min, max) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : 0;
};
function phone(raw, d) {
  if (d.length === 10 && d[0] === '0') return '+38' + d;      // 067 123 45 67
  if (d.length === 12 && d.startsWith('380')) return '+' + d;  // 380671234567
  return (raw.trim().startsWith('+') ? '+' : '') + d;           // іноземні номери як є
}

/* ---------- повідомлення ---------- */

function format(o, id) {
  const L = [`🔥 <b>Нове замовлення #${id}</b>`, ''];
  let sum = 0;
  let unpriced = false;
  for (const it of o.items) {
    const q = qty(it.qty, it.unit);
    if (it.price > 0) {
      const line = Math.round(it.qty * it.price);
      sum += line;
      L.push(`• ${esc(it.title)} — ${q} × ${money(it.price)} = <b>${money(line)} грн</b>`);
    } else {
      unpriced = true;
      L.push(`• ${esc(it.title)} — ${q}`);
    }
  }
  for (const ex of o.extras) {
    if (ex.price > 0) {
      const line = Math.round(ex.qty * ex.price);
      sum += line;
      L.push(`+ ${esc(ex.title)} — ${ex.qty} шт = ${money(line)} грн`);
    } else {
      unpriced = true;
      L.push(`+ ${esc(ex.title)} — ${ex.qty} шт`);
    }
  }
  L.push('');
  if (sum > 0) L.push(`💰 Орієнтовно: <b>${money(sum)} грн</b>${unpriced ? ' + позиції без ціни' : ''}`);
  L.push(`⏰ Забере: ${esc(o.when)}`);
  L.push(`👤 ${esc(o.name)}`);
  L.push(`📞 ${esc(o.phone)}`);
  if (o.comment) L.push(`💬 ${esc(o.comment)}`);
  return L.join('\n');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const qty = (q, u) => String(+q.toFixed(2)).replace('.', ',') + ' ' + u;

/* ---------- Telegram ---------- */

async function send(token, chatId, html) {
  const call = (body) =>
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, link_preview_options: { is_disabled: true }, ...body }),
    });
  try {
    const r = await call({ text: html, parse_mode: 'HTML' });
    if (r.ok) return true;
    console.log('telegram error', chatId, r.status, await r.text().catch(() => ''));
    if (r.status === 400) {
      // розмітка не пройшла — шлемо простим текстом, щоб не загубити замовлення
      const plain = html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      return (await call({ text: plain })).ok;
    }
    return false;
  } catch (e) {
    console.log('telegram fetch failed', chatId, String(e));
    return false;
  }
}

/* ---------- службове ---------- */

async function allow(ip, env) {
  if (env.ORDER_LIMITER?.limit) {
    try { return (await env.ORDER_LIMITER.limit({ key: ip })).success; } catch { /* нижче — запасний ліміт */ }
  }
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);
  const ok = recent.length < RATE.count;
  if (ok) recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 2000) hits.clear();
  return ok;
}

function orderId() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...crypto.getRandomValues(new Uint8Array(4))].map((x) => abc[x % abc.length]).join('');
}

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const json = (obj, status, headers) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const text = (body, status, headers) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });
