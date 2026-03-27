## Как работает Terminal Agent

### Архитектура: Extension → AI Chat

Terminal Agent **НЕ вызывает AI напрямую**. Вместо этого он использует Extension для отправки сообщений в открытый AI чат (Grok, Gemini, Qwen и др.).

### Основной цикл

```
┌─────────────────────────────────────────────────────────────┐
│  Пользователь: ta: Проанализируй проект                     │
└─────────────────────────┬───────────────────────────────────┘
                          │
          POST /api/agent/start
          { mode: "standalone", prompt: "Проанализируй проект" }
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   terminal-agent.js (Сервер)                │
│  1. Создаёт сессию                                          │
│  2. Строит systemPrompt (OS + Memory Index)                 │
│  3. Возвращает { sessionId, systemPrompt, messages }        │
│  ❌ НЕ вызывает AI                                          │
└─────────────────────────┬───────────────────────────────────┘
                          │
          ◄── { sessionId, systemPrompt, userPrompt, messages }
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   КЛИЕНТ (index.html)                       │
│  Отправляет messages в AI чат через Extension:              │
│  POST /api/send { site: "grok", message: messages }         │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│             Extension → AI Chat (Grok/Gemini/Qwen)          │
│  AI отвечает: [CMD] dir /b                                  │
└─────────────────────────┬───────────────────────────────────┘
                          │
          POST /api/agent/:id/ai-response
          { aiContent: "[CMD] dir /b" }
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   terminal-agent.js (Сервер)                │
│  Парсит ответ AI → { type: "CMD", command: "dir /b" }       │
└─────────────────────────┬───────────────────────────────────┘
                          │
          ◄── { type: "CMD", command: "dir /b" }
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   КЛИЕНТ показывает Agent UI                │
│  [Execute] [Skip] [Cancel]                                  │
│                                                             │
│  Пользователь нажимает Execute                              │
│  → Выполняет команду локально                               │
│  → POST /api/agent/:id/command-result { stdout }            │
│  → Получает userContent                                     │
│  → Отправляет в AI чат                                      │
│  → Цикл продолжается...                                     │
└─────────────────────────────────────────────────────────────┘
```

### Memory и GET-FILE — мгновенная обработка

Если AI отвечает `[GET-FILE]`, `[STORE]`, `[RETRIEVE]` и т.д. — сервер обрабатывает их **мгновенно** и возвращает результат клиенту для отправки обратно в AI:

```
[GET-FILE] package.json
       │
       ▼
  Сервер читает файл
       │
       ▼
  ◄── { handled: true, result: "содержимое файла" }
       │
       ▼
  Клиент добавляет result в messages
       │
       ▼
  Отправляет в AI чат
```

### Типы директив и обработка

| Директива | Что делает | Кто обрабатывает |
|-----------|------------|------------------|
| `[CMD]` | Команда терминала | **Клиент** показывает UI → выполняет → отправляет в AI |
| `[ASK]` | Вопрос пользователю | **Клиент** показывает UI → получает ответ → отправляет в AI |
| `[ASK:optional]` | Опциональный вопрос | **Клиент** показывает UI → можно пропустить |
| `[MESSAGE]` | Информация | **Клиент** показывает → автоматически continue → отправляет в AI |
| `[DONE]` | Завершение | **Клиент** показывает → сессия закрыта |
| `[GET-FILE]` | Чтение файла | **Сервер** мгновенно → клиент отправляет результат в AI |
| `[STORE]` | Сохранить память | **Сервер** мгновенно → клиент отправляет "OK" в AI |
| `[RETRIEVE]` | Получить память | **Сервер** мгновенно → клиент отправляет содержимое в AI |
| `[LIST_MEMORY]` | Список памяти | **Сервер** мгновенно → клиент отправляет список в AI |
| `[APPEND_MEMORY]` | Дописать в память | **Сервер** мгновенно → клиент отправляет "OK" в AI |
| `[DELETE_MEMORY]` | Удалить память | **Сервер** мгновенно → клиент отправляет "OK" в AI |

### API Endpoints

| Endpoint | Метод | Описание |
|----------|-------|----------|
| `/api/agent/start` | POST | Создать сессию, получить systemPrompt |
| `/api/agent/:id/ai-response` | POST | Отправить ответ AI для парсинга |
| `/api/agent/:id/command-result` | POST | Отправить результат выполнения команды |
| `/api/agent/:id/message` | POST | Отправить ответ пользователя на [ASK] |
| `/api/agent/:id/continue` | POST | Продолжить после [MESSAGE] |
| `/api/agent/:id` | GET | Получить состояние сессии |
| `/api/agent/:id` | DELETE | Удалить сессию |

### Пример взаимодействия (standalone)

```javascript
// 1. Запуск — получаем systemPrompt
const startRes = await fetch('/api/agent/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    mode: 'standalone',
    prompt: 'Найди все .js файлы'
  })
}).then(r => r.json());

const { sessionId, messages } = startRes.data;
// messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]

// 2. Отправляем в AI чат через Extension
const aiResponse = await fetch('/api/send', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ site: 'grok', message: formatMessages(messages) })
}).then(r => r.json());
// aiResponse.fullText = "[CMD] dir /s /b *.js"

// 3. Парсим ответ AI на сервере
const parsed = await fetch(`/api/agent/${sessionId}/ai-response`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ aiContent: aiResponse.fullText })
}).then(r => r.json());
// parsed.data = { type: 'CMD', command: 'dir /s /b *.js', handled: false }

// 4. Показываем UI, выполняем команду, отправляем результат
const cmdResult = await fetch(`/api/agent/${sessionId}/command-result`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ stdout: 'app.js\nutils.js\nindex.js' })
}).then(r => r.json());
// cmdResult.data.userContent = "Command output:\napp.js\nutils.js\nindex.js\n\n[Step 2 of 100]"

// 5. Добавляем в messages и отправляем в AI
messages.push({ role: 'assistant', content: aiResponse.fullText });
messages.push({ role: 'user', content: cmdResult.data.userContent });
// → Отправляем в AI чат
// → Получаем следующую директиву
// → Цикл продолжается...
```

### Skill-режим

Загружает `SKILL.md` из `.carl-superchat/skills/`:

```yaml
---
name: study-project
description: Изучает структуру проекта
history_mode: last_n
history_max: 5
---
## Что делаю
1. Сканирую директории
2. Читаю ключевые файлы
3. Создаю MEMORY_project_overview.md
```

```javascript
await fetch('/api/agent/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    mode: 'skill',
    skillPath: 'study-project'
  })
});
```

### Структура файлов

```
server/
├── terminal-agent.js        ← REST API роутер (сессии, парсинг)
├── terminal-agent-ai.js     ← Промпты, парсер, память (без AI вызовов)
└── prompts.json             ← TERMINAL_AGENT_SYSTEM_PROMPT

.carl-superchat/
├── memory/
│   ├── MEMORY_project_overview.md   ← постоянная память
│   └── MEMORY_js_files.md
└── skills/
    └── study-project/
        └── SKILL.md
```

### Триггер запуска

В Test GUI (`index.html`) Terminal Agent запускается при вводе:
```
ta: <запрос пользователя>
```

Пример:
```
ta: Покажи список файлов в текущей директории
```

Память **общая** для всех сессий — агент может в новой сессии использовать информацию из предыдущих.

---

## Связанная документация

- [README_INDEX.md](./README_INDEX.md) — оглавление базы знаний
- [README_about.md](./README_about.md) — обзор проекта и REST API
- [README_logs.md](./README_logs.md) — система логирования