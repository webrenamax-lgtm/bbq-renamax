# BBQ Renamax — сайт

Сайт точки **BBQ Renamax** (ТІР-бочка, 339 км траси Київ–Чоп, с. Велика Омеляна).
Статичний: HTML + CSS + трохи JS, без збірки й залежностей.

## Структура

| Файл | Що це |
|---|---|
| `index.html` | сам сайт |
| `content.json` | **увесь змінний контент**: телефон, графік, меню, ціни, банер-оголошення |
| `content.js` | підставляє content.json у сторінку |
| `admin.html` | форма редагування (відкривається як `адреса-сайту/admin.html`) |
| `img/logo.jpg` | логотип |

## Як оновити меню/ціни/графік

**Спосіб 1 (через адмінку):**
1. Відкрийте `https://<адреса-сайту>/admin.html`
2. Змініть поля → «Зберегти» — скачається новий `content.json`
3. Тут, на GitHub: відкрийте `content.json` → олівець **Edit** → вставте вміст скачаного файлу → **Commit changes**

**Спосіб 2 (одразу на GitHub):** відкрийте `content.json` → **Edit** → поправте текст (назву страви, ціну) → **Commit changes**. Через ~1 хв зміни на сайті.

## GitHub Pages

Settings → Pages → Source: **Deploy from a branch** → гілка `main`, папка `/ (root)` → Save.
Сайт: `https://webrenamax-lgtm.github.io/bbq-renamax/`
