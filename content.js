/* content.js — fills [data-key] elements from content.json.
 * The HTML already contains real content inline; this only overwrites it,
 * so if fetch fails the site still works. */
(async () => {
  try {
    const res = await fetch('content.json?v=' + new Date().toISOString().slice(0, 10));
    if (!res.ok) return;
    const c = await res.json();
    const get = (path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), c);
    const fill = (tpl) => tpl.replace(/\{([^}]+)\}/g, (_, p) => get(p) ?? '');

    document.querySelectorAll('[data-key]').forEach(el => {
      const v = get(el.dataset.key);
      if (v != null && v !== '') el.textContent = v;
    });
    document.querySelectorAll('[data-href]').forEach(el => el.setAttribute('href', fill(el.dataset.href)));
    document.querySelectorAll('[data-src]').forEach(el => el.setAttribute('src', fill(el.dataset.src)));

    document.querySelectorAll('[data-list]').forEach(box => {
      const items = get(box.dataset.list);
      const tpl = box.querySelector('template');
      if (!Array.isArray(items) || !items.length || !tpl) return;
      box.querySelectorAll(':scope > :not(template)').forEach(n => n.remove());
      items.forEach(item => {
        const html = tpl.innerHTML.replace(/\{([^}]+)\}/g, (_, k) => item[k] ?? '');
        box.insertAdjacentHTML('beforeend', html);
      });
    });

    const ann = document.getElementById('announcement');
    if (ann && c.announcement && c.announcement.enabled && c.announcement.text) ann.hidden = false;
  } catch (e) { /* inline HTML remains — intended fallback */ }
})();
