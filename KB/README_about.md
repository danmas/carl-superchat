# carl-superchat — Обзор проекта

## Краткое описание

Chrome-расширение (Manifest V3) + Node.js сервер для **программного взаимодействия** с веб-версиями AI-чатов через реальный браузер.

### Основная функциональность

- **Отправка сообщений**: текст + файлы (base64) в AI-чаты
- **Стриминг ответов**: SSE (Server-Sent Events) или JSON
- **REST API**: для интеграции с любым GUI/бэкендом
- **Terminal Agent**: серверный агент с навыками (skills), памятью (memory), выполнением команд

### Поддерживаемые AI-сервисы (базовые адаптеры)

| Сервис | URL |
|--------|-----|
| Grok | grok.com, x.com/i/grok, x.ai |
| Gemini | gemini.google.com |
| Qwen | chat.qwen.ai |
| Kimi | kimi.com, kimi.moonshot.cn |
| DeepSeek | chat.deepseek.com |

> **Примечание**: В проекте также есть расширенные адаптеры для других сервисов (ChatGPT, Mistral, Perplexity и др.), но основной REST API работает с пятью сервисами выше.

---

## Архитектура

```
┌─────────────────┐     WebSocket      ┌─────────────────────────┐
│  Node.js Server │◄──────────────────►│  Background Service     │
│  (server.js)    │                    │  Worker (background.js) │
│                 │                    │                         │
│  - REST API     │                    │  - WS мост              │
│  - SSE стриминг │                    │  - Управление вкладками │
│  - Terminal     │                    │  - Keep-alive           │
│    Agent        │                    │  - Heartbeat            │
└─────────────────┘                    └───────────┬─────────────┘
                                                   │
                                       chrome.tabs.sendMessage
                                                   │
                         ┌─────────────────────────┼─────────────────────────┐
                         ▼                         ▼                         ▼
              ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
              │  Grok Tab        │     │  Gemini Tab      │     │  Qwen Tab        │
              │  (content.iife)  │     │  (content.iife)  │     │  (content.iife)  │
              │                  │     │                  │     │                  │
              │  - insertText    │     │  - insertText    │     │  - insertText    │
              │  - attachFiles   │     │  - attachFiles   │     │  - attachFiles   │
              │  - observeResp   │     │  - observeResp   │     │  - observeResp   │
              └──────────────────┘     └──────────────────┘     └──────────────────┘
```

---

## Ключевые файлы и директории

### Сервер

| Файл | Описание |
|------|----------|
| `server/server.js` | HTTP + WebSocket сервер (порт 3010). REST API: `/api/status`, `/api/tabs`, `/api/send`, `/api/open` |
| `server/terminal-agent.js` | Terminal Agent API: сессии, skills, выполнение команд |
| `server/terminal-agent-ai.js` | Парсинг ответов AI, memory CRUD, промпты |
| `server/prompts.json` | Системные промпты для Terminal Agent |
| `server/public/index.html` | Тестовый GUI |

### Расширение

| Файл/Директория | Описание |
|-----------------|----------|
| `chrome-extension/src/background/index.ts` | Service Worker — мост между сервером и вкладками |
| `chrome-extension/manifest.ts` | Manifest V3 с host_permissions для 3 сайтов |
| `pages/content/src/index.ts` | Content script с 3 inline-адаптерами (grok, gemini, qwen) |
| `pages/content/src/plugins/adapters/` | Расширенные адаптеры (14+ сервисов) — для MCP-режима |
| `chrome-extension/src/mcpclient/` | MCP Client с SSE/WebSocket плагинами |

### Хранилище проекта

| Директория | Описание |
|------------|----------|
| `.carl-superchat/skills/` | Навыки Terminal Agent (файлы SKILL.md) |
| `.carl-superchat/memory/` | Память агента (файлы MEMORY_*.md) |

---

## REST API

### Базовый URL: `http://localhost:3010`

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/api/status` | Статус подключения расширения |
| GET | `/api/tabs` | Список зарегистрированных вкладок |
| POST | `/api/send` | Отправка сообщения в AI-чат |
| POST | `/api/open` | Открыть/активировать вкладку сайта |

### POST `/api/send` — формат запроса

```json
{
  "site": "grok",           // "grok" | "gemini" | "qwen"
  "message": "Привет!",     // Текст сообщения
  "stream": true,           // SSE стриминг (default: true)
  "files": [                // Опционально: файлы (base64)
    {
      "name": "image.png",
      "mime": "image/png",
      "data": "iVBORw0KGgo..."
    }
  ]
}
```

### Terminal Agent API

| Метод | Endpoint | Описание |
|-------|----------|----------|
| POST | `/api/agent/start` | Создать сессию агента |
| POST | `/api/agent/:id/ai-response` | Передать ответ AI для парсинга |
| POST | `/api/agent/:id/command-result` | Результат выполнения команды |
| POST | `/api/agent/:id/execute` | Выполнить команду на сервере |
| POST | `/api/agent/:id/message` | Отправить сообщение пользователя |
| GET | `/api/agent/:id` | Информация о сессии |
| DELETE | `/api/agent/:id` | Удалить сессию |

---

## Особенности реализации

### Прикрепление файлов

Content script поддерживает **3 стратегии** прикрепления файлов (в порядке попыток):

1. **Paste** — эмуляция Ctrl+V через ClipboardEvent
2. **Input** — установка files на `<input type="file">` с перехватом click()
3. **Drag & Drop** — эмуляция перетаскивания файла

### Наблюдение за ответом AI

- MutationObserver отслеживает изменения в DOM
- Проверка `isGenerating()` через наличие кнопки "Stop"
- Стабилизация текста (5+ циклов без изменений) → `done`
- Таймаут: 60 секунд

### Keep-alive для фоновых вкладок

Chrome может приостанавливать фоновые вкладки. Background script периодически "будит" вкладки с активными запросами через `chrome.scripting.executeScript()`.

---

## Запуск

### 1. Сервер

```bash
cd server
npm install   # или: bun install
npm run dev   # или: node server.js
```

Сервер доступен на `http://localhost:3010`

### 2. Сборка расширения

```bash
# Из корня проекта
bun install
bun run build
```

Результат: `dist/` — unpacked extension для загрузки в Chrome.

### 3. Установка расширения

1. Chrome → `chrome://extensions/`
2. Включить "Режим разработчика"
3. "Загрузить распакованное расширение" → выбрать папку `dist/`

### 4. Тест

Открыть `http://localhost:3010/` — веб-интерфейс для тестирования.

---

## Происхождение проекта

Проект основан на [MCP-SuperAssistant](https://github.com/srbhptl39/MCP-SuperAssistant) (форк).

**Что сохранено:**
- MCP Client инфраструктура (`chrome-extension/src/mcpclient/`)
- Расширенные адаптеры для 14+ AI-сервисов (`pages/content/src/plugins/adapters/`)
- Event system, stores, plugin architecture

**Что добавлено в carl-superchat:**
- Упрощённый REST API для базовых 3 сервисов (grok, gemini, qwen)
- Terminal Agent с skills/memory system
- Inline-адаптеры в content script для стабильной работы

---

## Зависимости

### Runtime

- Node.js ≥ 22.12.0
- Bun ≥ 1.3.3 (или npm)
- Chrome (Manifest V3)

### Основные npm-паке|ы

- `ws` — WebSocket сервер
- `react` 19.x — UI компоненты
- `firebase` — Remote config (расширение)
- `turbo` — Monorepo build

---

## Конфигурация

| Файл | Описание |
|------|----------|
| `.env` | Переменные окружения (PORT и др.) |
| `config.json` | Конфигурация проекта |
| `turbo.json` | Turbo build pipelines |

Порт сервера: `PORT=3010` (по умолчанию)

---

## Примечания

1. **Никаких API-ключей не требуется** — расширение работает через реальный браузер пользователя
2. **Авторизация** — пользователь должен быть залогинен в соответствующих AI-сервисах
3. **Rate limits** — действуют стандартные ограничения сервисов
4. **Файлы** — поддерживаются изображения и PDF (зависит от конкретного сервиса)

---

## Связанная документация

- [README_INDEX.md](./README_INDEX.md) — оглавление базы знаний
- [README_terminal_agent_work.md](./README_terminal_agent_work.md) — архитектура Terminal Agent
- [README_logs.md](./README_logs.md) — система логирования
