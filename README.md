# carl-superchat

Chrome-расширение + Node.js сервер для программного взаимодействия с AI-чатами (Grok, Gemini, Qwen) через реальный браузер.

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
                        │ Grok   │     │Gemini  │    │ Qwen   │
                        │ tab    │     │ tab    │    │ tab    │
                        └────────┘     └────────┘    └────────┘
```

## Быстрый старт

### 1. Установка зависимостей

```bash
# Корень проекта (расширение)
npx pnpm install

# Сервер
cd server
npm install
```

### 2. Сборка расширения

```bash
# Из корня проекта
npx pnpm base-build
```

Собранное расширение появится в `dist/`.

### 3. Загрузка в Chrome

1. Открой `chrome://extensions/`
2. Включи **Режим разработчика**
3. **Загрузить распакованное расширение** → выбери папку `dist/`

### 4. Запуск сервера

```bash
cd server
node server.js
```

Сервер стартует на порту **3010**:
- REST API: `http://localhost:3010/api/...`
- Test GUI: `http://localhost:3010/`
- WebSocket: `ws://localhost:3010`

### 5. Использование

1. Открой в Chrome один из AI-чатов: [grok.com](https://grok.com), [gemini.google.com](https://gemini.google.com), [chat.qwen.ai](https://chat.qwen.ai)
2. Открой тестовую страницу `http://localhost:3010/`
3. Выбери сайт, напиши сообщение, нажми Send

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

Отправка сообщения в AI-чат.

**Body:**
```json
{ "site": "grok", "message": "Привет!", "stream": true }
```

- `site` — `"grok"`, `"gemini"` или `"qwen"`
- `message` — текст сообщения
- `stream` — `true` (SSE, по умолчанию) или `false` (JSON после полного ответа)

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

**curl (если установлен)**
```bash
# статус
curl http://localhost:3010/api/status

# отправить сообщение
curl -X POST http://localhost:3010/api/send -H "Content-Type: application/json" -d "{\"site\":\"qwen\",\"message\":\"Привет!\",\"stream\":false}"
```

**Python**
```python
import requests
r = requests.post("http://localhost:3010/api/send", json={"site": "qwen", "message": "Привет!", "stream": False})
print(r.json()["fullText"])
```

**JavaScript / Node.js**
```javascript
const r = await fetch("http://localhost:3010/api/send", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ site: "qwen", message: "Привет!", stream: false })
});
const data = await r.json();
console.log(data.fullText);
```

## WS-протокол (Server ↔ Extension)

Для прямой интеграции без REST:

```
Server → Extension:
  { id, action: "send", site, message, stream? }
  { id, action: "get_tabs" }

Extension → Server:
  { id, type: "sent", site, tabId }
  { id, type: "chunk", site, text }
  { id, type: "done", site, fullText }
  { id, type: "error", site, error }
  { type: "tabs", tabs: [...] }
```

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
└── package.json               # Монорепо (pnpm + turbo)
```

## Поддерживаемые сайты

| Сайт | Hostname | Адаптер |
|------|----------|---------|
| Grok | `grok.com`, `x.com/i/grok` | `grok` |
| Google Gemini | `gemini.google.com` | `gemini` |
| Qwen Chat | `chat.qwen.ai` | `qwen` |

## Настройка порта

По умолчанию всё работает на порту **3010**. Чтобы изменить:

1. **Сервер** — в `server/server.js` поменяй `PORT`
2. **Расширение** — в `chrome-extension/src/background/index.ts` поменяй `WS_URL`
3. Пересобери: `npx pnpm base-build`

## Dev-режим

```bash
# Сборка с watch (авто-пересборка при изменениях)
npx pnpm base-dev

# Сервер с авто-рестартом
cd server
npm run dev
```

## На основе

Форк [MCP-SuperAssistant](https://github.com/srbhptl39/MCP-SuperAssistant) — MCP-логика выпотрошена, оставлены адаптеры для DOM-взаимодействия с AI-чатами.

## Лицензия

MIT
