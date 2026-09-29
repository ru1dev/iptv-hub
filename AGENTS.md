# AGENTS.md

> Полная техническая документация проекта для разработчиков и ИИ-агентов.
> README.md — для пользователей. Если README и AGENTS.md расходятся — правилен AGENTS.md.

---

## 🎯 Что это

**IPTV Hub** — self-hosted статический веб-плеер IPTV (M3U + EPG) без бэкенда.
Разворачивается на GitHub Pages; плейлист и телепрограмму браузер тянет напрямую
из S3-совместимого хранилища (Yandex Object Storage), конфигурация — через
GET-параметры или localStorage.

**Родительский проект:** `../iptv` (или https://github.com/ozyab09/iptv) —
Go-пайплайн, который ежедневно фильтрует M3U/EPG и загружает их в S3. IPTV Hub —
его клиент. Контракты данных: стандартный M3U (с `#EXTINF` атрибутами
`tvg-id`, `tvg-logo`, `group-title`) и XMLTV EPG (`.xml` или `.xml.gz`).

**Текущий статус:** v0.2 — парсеры + UI + плеер + PWA + CI/Pages, 28 юнит-тестов.

---

## 🧭 Ожидания от проекта (прочти перед любыми изменениями)

### Архитектурные принципы (не нарушать)

1. **Zero backend.** Никакого серверного кода, никаких серверных прокси,
   никаких серверных секретов. Всё — статика. Если задача требует бэкенда —
   сначала обсуди, не ломает ли это модель развёртывания.
2. **Privacy-first.** Ссылки пользователя живут в его localStorage. Никакой
   аналитики, телеметрии, сторонних скриптов. Единственные разрешённые
   runtime-зависимости — то, что бандлится (сейчас только `hls.js`).
3. **Чистые модули.** Парсеры (`m3u.ts`, `epg.ts`, `config.ts`) — чистые
   функции без DOM и fetch, полностью покрыты тестами. UI (`main.ts`) —
   тонкий слой: только DOM-события и вызов чистых модулей.
4. **Не расширять зависимости.** Новый runtime-пакет = взвешенное решение.
   DASH, если понадобится, добавлять через отдельный адаптер в `player.ts`
   (например dash.js), а не заменой архитектуры.

### Функциональные ожидания (что должно работать в любом PR)

- Разбор M3U: атрибуты `tvg-id`/`tvg-logo`/`group-title`, дедуп по URL,
  сортировка по алфавиту, дроп entries без URL, `#EXTM3U` `tvg-url`/`url-tvg`.
- Нормализация имён (`normalizeName`): нижний регистр, без эмодзи, без
  quality-маркеров, без региональных суффиксов. Используется и поиском,
  и матчингом EPG — изменил её, обнови тесты **обоих** потребителей.
- EPG: `.xml` и `.gzip` (magic bytes `1f 8b`, `DecompressionStream`),
  индексация по `id:<tvg-id>` и `name:<display-name>`, now/next по локальному
  времени. EPG может отсутствовать — UI обязан работать и без него.
- Конфиг: приоритет `?p=`/`?e=` → localStorage → setup-экран. Не-http(s)
  URL отклоняются (защита от `javascript:`-инъекций). EPG необязателен.
- Плеер: HLS через hls.js при `Hls.isSupported()`, нативный `<video>` иначе
  (Safari/iOS). Прогрессивные mp4 работают. DASH — нет (это осознанно).

### Известные ограничения (не считать багами)

- **CORS самих медиа-потоков.** Браузер может не дать играть потоки с чужих
  CDN без CORS-заголовков (в Chrome — fetch/MSE; в Safari — обычно ок,
  т.к. нативный playback). Это ограничение платформы, чинится только
  прокси, который по принципам проекта запрещён. В UI есть toast об ошибке.
- **Медиа не работает в оффлайне.** SW кеширует shell + плейлист/EPG, но не
  сегменты потоков — живой ТВ в оффлайне не существует. Список каналов и
  программа в оффлайне видны, воспроизведение — нет. Это осознанно.
- **SW только в прод-сборке.** Регистрация обёрнута в `import.meta.env.PROD`,
  чтобы не ломать dev-сервер и HMR. Проверять оффлайн-режим — только на
  `npm run preview` или в деплое, не в `npm run dev`.
- **Манифест — только относительные пути (`./`).** Сайт живёт на
  `https://<user>.github.io/iptv-hub/` (подпуть!), абсолютные `/...` сломают
  установку PWA и иконки. Это касается и `start_url`, и `scope`, и `sw.js`.
- **Стриминг EPG в память.** EPG грузится целиком в память (стриминг только
  на этапе скачивания). Для гигантских файлов (>200MB распакованных) на
  слабых устройствах возможен рост памяти — приемлемо для MVP, ROADMAP имеет
  пункт про индексированный доступ.
- **Матчинг EPG по имени** — точный lowercase. fuzzy (Levenshtein, как в
  родительском `iptv`) не реализован осознанно; tvg-id надёжнее.
- **Пробинг каналов** («жив ли поток») не делается — это задача родительского
  пайплайна `iptv` (`PROBE_SOURCES=true`), а не клиента.

### Что считать-done для любого изменения

1. `npm run build` проходит (typecheck strict + vite build, 0 ошибок).
2. `npm test` зелёный; новая логика парсеров покрыта тестами.
3. Не добавлено runtime-зависимостей без обсуждения (`@types/node` в dev —
   исключение: типы для node-тестов, в бандл не попадает).
4. README (пользовательский) и этот файл обновлены, если менялся контракт.
5. Если менялся кэшируемый shell (index.html, иконки, манифест) — bump
   `VERSION` в `public/sw.js`, иначе клиенты останутся на старом кэше.

---

## 🏗 Архитектура

```
iptv-hub/
├── index.html              # разметка: 2 экрана + player bar + toast
├── public/                 # копируется в dist/ как есть
│   ├── manifest.webmanifest  # PWA-манифест (ОБЯЗАТЕЛЬНО относительные пути ./)
│   ├── sw.js                 # service worker: shell cache-first, данные network-first
│   └── icons/                # генерируются: npm run icons (scripts/gen-icons.mjs)
├── scripts/gen-icons.mjs   # PNG-генератор без зависимостей (node:zlib, ручной PNG)
├── src/
│   ├── main.ts             # UI-слой: экраны, рендер списков, события, boot, SW-регистрация
│   ├── config.ts           # ?p=&e= → localStorage → null (чистый, тестируемый)
│   ├── m3u.ts              # парсер M3U: Channel, категории, normalizeName
│   ├── epg.ts              # загрузка (стрим+gzip) и разбор XMLTV, now/next
│   ├── player.ts           # Player: hls.js / нативный <video>, хук на сегменты
│   ├── recorder.ts         # запись перекодированием: mime, имя файла, жизненный цикл
│   ├── segment-recorder.ts # запись HLS сегментами: контейнер, потолок, init-сегмент
│   ├── recording-sink.ts   # куда писать: OPFS на диск, откат — память
│   ├── debug-log.ts        # экранный лог по ?debug=1 (на телефоне консоли нет)
│   ├── types.ts            # Channel, PlaylistSnapshot, EpgProgramme, NowNext
│   └── style.css           # тёмная неоновая тема, mobile-first
├── tests/                  # vitest: m3u, epg, config, pwa (node env, без DOM)
├── .github/workflows/ci.yml  # PR: build+test; push main: + deploy Pages
├── vite.config.ts          # vitest config (environment: node)
└── AGENTS.md               # этот файл
```

**Поток данных:**

```
URL ?p=&e= ─┐
localStorage ┴→ resolveConfig ─→ fetch playlist ─→ parseM3U ─→ UI (категории/поиск)
                                       │
                                       └→ (tvg-url fallback) ─→ loadEpg ─→ parseEpg
                                                ─→ getNowNext ─→ бейджи в списке
Клик по каналу ─→ Player.play() ─→ hls.js | <video>.src
```

### Запись эфира

Два пути, выбор по наличию hls-инстанса:

```
HLS  ─→ FRAG_LOADED ─→ segment-recorder ─→ OPFS/память ─→ .ts | .mp4
иное ─→ captureStream(<video>) | канвас+WebAudio ─→ MediaRecorder ─→ .webm
```

Сегментный путь ничего не перекодирует: складывает то, что hls.js уже скачал.
Он и основной — перекодирование осталось для нативного воспроизведения и
прямых mp4, где сегментов нет.

Про перекодирование важно помнить (выяснено в #58/#60):

- mime обязан соответствовать **фактическому** составу дорожек: если объявить
  `opus` без аудиодорожки, Firefox зависает намертво, а `isTypeSupported`
  рассинхрон не показывает;
- после `stop()` источник трогать нельзя — Gecko досылает последний чанк и
  событие `stop` примерно через 16 мс, снос в этом окне съедает и то, и другое;
- на Firefox для Android перекодирование невозможно в принципе: захват
  элемента роняет энкодер, канвас отдаёт черноту.

### Ключевые типы (`src/types.ts`)

- `Channel { name, normalizedName, url, tvgId, logo, group, quality }`
- `PlaylistSnapshot { channels, categories, headerTvgUrl }`
- `EpgProgramme { start, stop, title, desc }` — ISO UTC строки
- `NowNext { now, next }`

### Контракты данных

**M3U:** стандартный расширенный M3U. Парсер толерантен: `#EXTVLCOPT`/
`#KODIPROP` привязываются к текущему entry; entry без URL отбрасывается;
дедуп по URL (первый выигрывает). Сортировка — `localeCompare(..., "ru")`.

**EPG:** XMLTV. Матчинг канала: сначала по `tvg-id` (lowercase, ключ
`id:...`), при отсутствии — по нормализованному имени (ключ `name:...`,
дисплей-неймы из `<channel><display-name>`). Даты — `YYYYMMDDHHMMSS ±HHMM`.

**Конфиг:** `?p=<playlistUrl>&e=<epgUrl>` (об encodeURIComponent), ключ
localStorage — `iptv-hub.config.v1`.

---

## 🧪 Тесты и качество

```bash
npm test           # vitest run (node env)
npm run test:watch
npm run build      # tsc --noEmit (strict, noUncheckedIndexedAccess) + vite build
npm run dev        # vite dev server
npm run preview    # предпросмотр dist/
```

- Парсеры (`m3u.ts`, `epg.ts`, `config.ts`) обязаны оставаться чистыми
  (без DOM/fetch внутри) — это делает их тестируемыми в node без jsdom.
- Тесты не должны зависеть от сети.

## 🔄 CI/CD

Workflow `ci.yml`: PR — `npm test` + `npm run build`; push в `main` — то же +
деплой `dist/` в GitHub Pages (artifact + `actions/deploy-pages@v4`).
Pages включить руками: Settings → Pages → Source: **GitHub Actions**.

## 💻 Conventions

- TypeScript strict, типы без `any`; DOM-доступ через `$()`-хелпер c throw.
- Комментарии на русском, идентификаторы на английском (как в кодовой базе
  автора).
- Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`,
  `refactor:`.

### Процесс изменений (branch protection включён — push в `main` запрещён)

1. **Issue** для каждой правки/фичи/бага (`gh issue create`) — даже для
   мелочей; в теле — зачем, что сделать, acceptance-критерий.
2. **Ветка** от актуального `main`: `docs/<slug>`, `feat/<slug>`, `fix/<slug>`
   (в идеале — с номером issue: `fix/12-player-retry`).
3. **PR** в `main` с `Closes #<issue>` в описании. CI обязан прогнать
   `build` (vitest + typecheck + vite build) — check `build` обязателен
   к зелёному статусу (ruleset `main-protection`).
4. **Merge** после зелёного CI (любой из методов: merge/squash/rebase).
   Деплой на Pages происходит автоматически при обновлении `main`.
5. Прямой push, force-push и удаление `main` отклоняются GitHub-ом
   (`push declined due to repository rule violations`) — это не ошибка
   окружения, обходить защиту не нужно.

### Post-task follow-up

После задачи спросить пользователя про (a) issue, (b) ветку, (c) PR —
не коммитить/пушить в `main` напрямую, это заблокировано protection-ом.

## 🗺 Дорожная карта (актуальные направления)

- PWA: manifest + service worker (офлайн-кэш UI, не данных).
- «Избранное» в localStorage (дедуп с `_Best` из родительского пайплайна).
- Полная программа канала (модалка с расписанием дня из EPG).
- Экспорт/импорт настроек (JSON, как в sms-forwarder).
- DASH-адаптер (dash.js) за фиче-флагом.
- Кастомные эмодзи-пары из родительского `iptv` (FNV-1a) в списке каналов.

## 🔮 Как подхватить проект другому агенту

1. Прочти этот файл целиком, потом README.md.
2. `npm ci && npm test && npm run build` — всё должно быть зелёным до твоих правок.
3. Не ломай три инварианта: zero backend, privacy-first, чистые парсеры.
4. Ограничения из раздела «Известные ограничения» — не баги, тикеты на них
   заводить не нужно.
5. Пайплайн родительского проекта лежит в `../iptv` — его AGENTS.md описывает
   форматы `playlist.m3u` и `epg.xml-filtered.gz` детальнее.
