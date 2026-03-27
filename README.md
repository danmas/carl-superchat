# carl-superchat

Chrome-расширение + Node.js сервер для программного взаимодействия с AI-чатами (Grok, Gemini, Qwen, Kimi, DeepSeek) через реальный браузер.

Расширение инжектится в открытые вкладки AI-чатов, принимает команды от сервера по WebSocket, вставляет сообщения в чат, наблюдает за ответом AI и стримит его обратно. REST API позволяет интегрировать любой GUI или бэкенд.

## Архитектура

```
┌─────────────────────┐     REST / SSE     ┌──────────────────────┐
│  Твой GUI / бэкенд  │◄─────────────────►│  Node.js Server      │
│  (или test page)    │   POST /api/send   │  :3010               │
└─────────────────────┘                    └──────┬───────────────┘
                                                  │ WebSocket
                                           ┌──────▼───────────────┐
                                           │  Background SW       │
                                           │  (единый WS-клиент)  │
                                           │  роутинг по tabId    │
                                           └──┬─────┬─────┬──────┘
                                    chrome.runtime.sendMessage
                              ┌────┘         │         └────┐
                        ┌─────▼──┐     ┌─────▼──┐    ┌─────▼──┐
                        │ Grok   │     │Gemini  │    │ Qwen   │    │ Kimi   │
                        │ tab    │     │ tab    │    │ tab    │    │ tab    │
                        └────────┘     └────────┘    └────────┘    └────────┘
```

## Требования

- [Bun](https://bun.sh) ≥ 1.0
- Node.js ≥ 22 (для сервера, опционально можно запускать через `bun run`)

## Быстрый старт

### 1. Установка зависимостей

```bash
# Корень проекта (расширение + монорепо)
bun install

# Сервер (отдельная папка, при необходимости)
cd server
bun install
```

### 2. Сборка расширения

```bash
# Из корня проекта
bun run build
```

Собранное расширение появится в `dist/`.

### 3. Загрузка в Chrome

1. Открой `chrome://extensions/`
2. Включи **Режим разработчика**
3. **Загрузить распакованное расширение** → выбери папку `dist/`

### 4. Запуск сервера

Расширение подключается к WebSocket на порту **3010** — сервер должен быть запущен.

```bash
cd server
node --env-file=../.env server.js
# или
bun run start
```

Сервер стартует на порту **3010**:
- REST API: `http://localhost:3010/api/...`
- Test GUI: `http://localhost:3010/`
- WebSocket: `ws://localhost:3010`

### 5. Использование

1. Открой в Chrome один из AI-чатов: [grok.com](https://grok.com), [gemini.google.com](https://gemini.google.com), [chat.qwen.ai](https://chat.qwen.ai), [kimi.com](https://kimi.com), [chat.deepseek.com](https://chat.deepseek.com)
2. Открой тестовую страницу `http://localhost:3010/`
3. Выбери сайт, напиши сообщение (или прикрепи файл кнопкой **📎**), нажми Send

После изменений в content script: **`bun run build`** из корня, затем в `chrome://extensions/` обнови расширение (кнопка ⟳). Пока идёт сборка, папка `dist/` может быть пустой — Chrome тогда покажет «Manifest file is missing»; дождись окончания `bun run build`.

## REST API

### `GET /api/status`

Статус подключения расширения.

```json
{ "connected": true, "pendingRequests": 0 }
```

### `GET /api/tabs`

Список открытых AI-вкладок.

```json
{ "tabs": [{ "tabId": 123, "site": "grok", "url": "https://grok.com/", "title": "Grok" }] }
```

### `POST /api/send`

Отправка сообщения (и/или файлов) в AI-чат.

**Body:**
```json
{
  "site": "grok",
  "message": "Привет!",
  "stream": true,
  "files": [
    { "name": "photo.jpg", "mime": "image/jpeg", "data": "<base64>" }
  ]
}
```

- `site` — `"grok"`, `"gemini"` или `"qwen"`
- `message` — текст сообщения (необязателен, если есть `files`)
- `stream` — `true` (SSE, по умолчанию) или `false` (JSON после полного ответа)
- `files` — массив файлов (необязателен):
  - `name` — имя файла с расширением
  - `mime` — MIME-тип (`image/jpeg`, `application/pdf`, ...)
  - `data` — содержимое файла в base64

Файлы прикрепляются к чату **до** вставки текста. Content script **ждёт окончания загрузки файла на сторону сайта** (например, на Qwen — пока не исчезнет спиннер `.vision-spinner`), затем вставляет текст и жмёт Send — иначе чат может ответить «файлы ещё загружаются».

Лимит тела запроса — 50 МБ. Таймаут ожидания ответа при наличии файлов — 180с (без файлов — 120с).

**Файлы проверены:** **Grok** и **Qwen** (изображения, PDF, md и т.д.). **Gemini** — та же схема API, при сбоях смотри селекторы в `pages/content/src/index.ts`.

**Ответ при `stream: true`** (SSE):
```
data: {"chunk":"Привет"}
data: {"chunk":"! Чем могу помочь?"}
data: {"done":true,"fullText":"Привет! Чем могу помочь?"}
```

**Ответ при `stream: false`** (JSON):
```json
{ "ok": true, "fullText": "Привет! Чем могу помочь?" }
```

### Тестирование API (порт 3010)

Перед тестами: сервер запущен (`node server.js` в `server/`), расширение загружено, вкладка нужного AI-чата (Qwen/Grok/Gemini) открыта в Chrome.

**1. Статус подключения расширения**
```powershell
Invoke-RestMethod http://localhost:3010/api/status
```

**2. Список открытых AI-вкладок**
```powershell
Invoke-RestMethod http://localhost:3010/api/tabs
```

**3. Отправить вопрос и получить полный ответ (без стрима)**
```powershell
$body = @{ site = "qwen"; message = "Что такое Rust?"; stream = $false } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:3010/api/send -Method POST -ContentType "application/json" -Body $body
```
Ответ: `{ "ok": true, "fullText": "..." }`.

**4. Со стримом (SSE)**
```powershell
$body = '{"site":"qwen","message":"Что такое Rust?","stream":true}'
Invoke-WebRequest -Uri http://localhost:3010/api/send -Method POST -ContentType "application/json" -Body $body
```
Строки вида `data: {"chunk":"..."}`, в конце — `data: {"done":true,"fullText":"..."}`.

**5. Отправить файл (без стрима)**
```powershell
$bytes = [System.IO.File]::ReadAllBytes("C:\path\to\photo.jpg")
$base64 = [Convert]::ToBase64String($bytes)
$body = @{
  site = "grok"
  message = "Что на этом фото?"
  stream = $false
  files = @(@{ name = "photo.jpg"; mime = "image/jpeg"; data = $base64 })
} | ConvertTo-Json -Depth 3
Invoke-RestMethod -Uri http://localhost:3010/api/send -Method POST -ContentType "application/json" -Body $body
```

**curl (если установлен)**
```bash
# статус
curl http://localhost:3010/api/status

# отправить сообщение
curl -X POST http://localhost:3010/api/send \
  -H "Content-Type: application/json" \
  -d '{"site":"qwen","message":"Привет!","stream":false}'

# отправить файл
BASE64=$(base64 -w0 photo.jpg)
curl -X POST http://localhost:3010/api/send \
  -H "Content-Type: application/json" \
  -d "{\"site\":\"grok\",\"message\":\"Опиши фото\",\"stream\":false,\"files\":[{\"name\":\"photo.jpg\",\"mime\":\"image/jpeg\",\"data\":\"$BASE64\"}]}"
```

**Python**
```python
import requests, base64

# текст
r = requests.post("http://localhost:3010/api/send", json={"site": "qwen", "message": "Привет!", "stream": False})
print(r.json()["fullText"])

# файл
with open("photo.jpg", "rb") as f:
    b64 = base64.b64encode(f.read()).decode()
r = requests.post("http://localhost:3010/api/send", json={
    "site": "grok",
    "message": "Что на этом фото?",
    "stream": False,
    "files": [{"name": "photo.jpg", "mime": "image/jpeg", "data": b64}]
})
print(r.json()["fullText"])
```

**JavaScript / Node.js**
```javascript
import { readFileSync } from 'fs';

// текст
const r = await fetch("http://localhost:3010/api/send", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ site: "qwen", message: "Привет!", stream: false })
});
console.log((await r.json()).fullText);

// файл
const b64 = readFileSync("photo.jpg").toString("base64");
const r2 = await fetch("http://localhost:3010/api/send", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    site: "grok",
    message: "Что на фото?",
    stream: false,
    files: [{ name: "photo.jpg", mime: "image/jpeg", data: b64 }]
  })
});
console.log((await r2.json()).fullText);
```

## WS-протокол (Server ↔ Extension)

Для прямой интеграции без REST:

```
Server → Extension:
  { id, action: "send", site, message, stream?, files? }
  { id, action: "get_tabs" }
  { id, action: "open_tab", site }

Extension → Server:
  { id, type: "sent", site, tabId }
  { id, type: "chunk", site, text }
  { id, type: "done", site, fullText }
  { id, type: "error", site, error }
  { id, type: "tabs", tabs: [...] }
  { id, type: "tab_opened", site, tabId, alreadyOpen }
  { type: "heartbeat", tabs: [...] }
  { type: "tab_registered", tabId, site, url, title }
  { type: "tab_unregistered", tabId, site? }
```

Поле `files` — массив `{ name, mime, data }` (base64), передаётся в content script как есть.

## Структура проекта

```
carl-superchat/
├── chrome-extension/          # Ядро расширения (background SW)
│   ├── src/background/index.ts   # WS-клиент, роутинг команд в табы
│   ├── manifest.ts               # Manifest V3 (Grok, Gemini, Qwen)
│   └── public/                   # Иконки
├── pages/content/             # Content script
│   └── src/index.ts              # Адаптеры + MutationObserver стриминг
├── packages/                  # Shared packages (env, storage, hmr, etc.)
├── server/                    # Node.js сервер
│   ├── server.js                 # REST API + WebSocket
│   └── public/index.html        # Тестовая страница (чат-GUI)
├── dist/                      # Собранное расширение (Load unpacked)
└── package.json               # Монорепо (bun + turbo)
```

## Поддерживаемые сайты

| Сайт | Hostname | Адаптер | Файлы (API) |
|------|----------|---------|-------------|
| Grok | `grok.com`, `x.com/i/grok` | `grok` | да |
| Google Gemini | `gemini.google.com` | `gemini` | API готов, при сбоях — селекторы |
| Qwen Chat | `chat.qwen.ai` | `qwen` | да |
| Kimi | `kimi.com`, `kimi.moonshot.cn` | `kimi` | да |
| DeepSeek | `chat.deepseek.com` | `deepseek` | да |

## Настройка порта

По умолчанию всё работает на порту **3010**. Чтобы изменить:

1. **Сервер** — переменная `PORT` в `server/server.js` или в `.env`
2. **Расширение** — в `chrome-extension/src/background/index.ts` (или через env при сборке) — `process.env['PORT']`
3. Пересобери: `bun run build`

## Dev-режим

```bash
# Расширение: сборка с watch + HMR (авто-пересборка при изменениях)
bun run dev

# В отдельном терминале — сервер (нужен для работы расширения)
cd server
node --env-file=../.env --watch server.js
# или: bun run dev
```

Без запущенного сервера на порту 3010 расширение будет показывать ошибку подключения WebSocket — это ожидаемо.

## Прикрепление файлов — как работает

1. `POST /api/send` с `files: [{ name, mime, data (base64) }]`
2. Сервер → WebSocket → background → `chrome.tabs.sendMessage` → content script
3. **Прикрепление** (по очереди, пока не сработает превью):
   - **Paste** на поле ввода (как Ctrl+V)
   - **Input** `#filesUpload` / `input[type="file"]` (Grok/Qwen часто используют `#filesUpload`; у Qwen меню **+** → «Загрузить вложение», при необходимости блокируется нативный file picker)
   - **Drag-and-drop** на textarea / зону ввода — на **Qwen** обычно срабатывает именно он
4. **Ожидание загрузки на сервер чата** (до ~30 с): на Qwen — пока виден `.vision-spinner` / `.circle-spinner`; иначе Send уходит раньше времени («некоторые файлы ещё загружаются»).
5. Вставка текста → Send → стрим ответа как обычно

**Форматы:** то, что принимает сам чат (jpg, png, webp, pdf, md, …). В `files` можно передать несколько элементов за один запрос.

**Лимиты:** ~20 МБ на файл практично; body до 50 МБ.

> **Селекторы** меняются с обновлениями сайтов. См. `pages/content/src/index.ts`: стратегии attach, `FILE_PREVIEW_SELECTORS`, `UPLOAD_LOADING_SELECTORS`, `ATTACH_BUTTON_SELECTORS` (Qwen: `span.ant-dropdown-trigger` + пункт меню).

## На основе

Форк [MCP-SuperAssistant](https://github.com/srbhptl39/MCP-SuperAssistant) — MCP-логика выпотрошена, оставлены адаптеры для DOM-взаимодействия с AI-чатами.

## Лицензия

MIT
