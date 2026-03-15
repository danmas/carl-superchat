/**
 * carl-superchat content script
 *
 * Lightweight bridge: receives commands from background service worker,
 * injects text into AI chat, observes streaming response, sends chunks back.
 */

interface SiteAdapter {
  name: string;
  hostMatch: (hostname: string) => boolean;
  inputSelector: string;
  submitSelector: string;
  responseContainerSelector: string;
  isGenerating: () => boolean;
  getLastResponseElement: () => Element | null;
  insertText: (text: string) => Promise<boolean>;
  submit: () => Promise<boolean>;
}

// ── Adapter definitions ──────────────────────────────────────────────

const adapters: SiteAdapter[] = [
  {
    name: 'grok',
    hostMatch: (h) => h.includes('grok.com') || h.includes('x.com') || h.includes('x.ai'),
    inputSelector:
      'textarea[aria-label="Ask Grok anything"], textarea[placeholder="Ask anything"], textarea[placeholder], div[contenteditable="true"]',
    submitSelector:
      'button[aria-label="Submit"], button[aria-label="Send message"], button[data-testid="send-button"]',
    responseContainerSelector: 'div.relative.items-end',

    isGenerating() {
      const stop = document.querySelector('button[aria-label="Stop generating"], button[aria-label="Stop"]');
      return !!stop && stop.getBoundingClientRect().width > 0;
    },

    getLastResponseElement() {
      const msgs = document.querySelectorAll('div.message-bubble, div[class*="assistant"], div.relative.items-end');
      return msgs.length ? msgs[msgs.length - 1] : null;
    },

    async insertText(text: string) {
      const el = findFirst(this.inputSelector) as HTMLTextAreaElement | HTMLElement | null;
      if (!el) return false;
      el.focus();
      if (el.tagName === 'TEXTAREA') {
        (el as HTMLTextAreaElement).value = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } else {
        el.textContent = '';
        document.execCommand('insertText', false, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
      return true;
    },

    async submit() {
      const btn = findFirst(this.submitSelector) as HTMLButtonElement | null;
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    },
  },

  {
    name: 'gemini',
    hostMatch: (h) => h.includes('gemini.google.com'),
    inputSelector: 'div.ql-editor.textarea p, .ql-editor p, div[contenteditable="true"]',
    submitSelector:
      'button.send-button, button[aria-label*="Send"], button[data-testid="send-button"]',
    responseContainerSelector: 'div.query-content, message-content',

    isGenerating() {
      const stop = document.querySelector('button[aria-label="Stop generating"], mat-icon[data-mat-icon-name="stop_circle"]');
      return !!stop && stop.getBoundingClientRect().width > 0;
    },

    getLastResponseElement() {
      const msgs = document.querySelectorAll('message-content, .model-response-text, div.markdown');
      return msgs.length ? msgs[msgs.length - 1] : null;
    },

    async insertText(text: string) {
      const el = findFirst(this.inputSelector) as HTMLElement | null;
      if (!el) return false;
      el.focus();
      el.textContent = '';
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return true;
    },

    async submit() {
      const btn = findFirst(this.submitSelector) as HTMLButtonElement | null;
      if (!btn || btn.disabled) {
        const input = findFirst(this.inputSelector) as HTMLElement;
        if (input) {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
          return true;
        }
        return false;
      }
      btn.click();
      return true;
    },
  },

  {
    name: 'qwen',
    hostMatch: (h) => h.includes('qwen.ai') || h.includes('chat.qwen.ai'),
    inputSelector: 'textarea.message-input-textarea, #chat-input, textarea.chat-input',
    submitSelector:
      'button.omni-button-content-btn, div.message-input-right-button-send button, button.send-button',
    responseContainerSelector: '.user-message-text-content, div.user-message-content',

    isGenerating() {
      const stop = document.querySelector('button[class*="stop"], div[class*="stop-button"], div[class*="loading"], span[class*="loading"]');
      if (stop && stop.getBoundingClientRect().width > 0) return true;
      const cursors = document.querySelectorAll('span.blinking-cursor, span[class*="cursor"], div[class*="typing"]');
      for (const c of cursors) { if (c.getBoundingClientRect().width > 0) return true; }
      return false;
    },

    getLastResponseElement() {
      const selectors = [
        'div[class*="markdown-body"]',
        'div[class*="assistant-message"]',
        'div[class*="message-content"]',
        'div[class*="chat-message"] div[class*="content"]',
        'div.markdown-body',
        'div[class*="answer"]',
        '[class*="Message"] div[class*="content"]',
        '[class*="message"] [class*="body"]',
        'article div[class*="content"]',
        'div[class*="prose"]',
      ];
      for (const sel of selectors) {
        const all = document.querySelectorAll(sel);
        if (all.length) return all[all.length - 1];
      }
      // Fallback: last element in chat area with substantial text (not input)
      const chatArea = document.querySelector('[class*="chat"], [class*="conversation"], [class*="message-list"], [class*="messages"], main, [role="log"]') || document.body;
      const candidates = chatArea.querySelectorAll('div[class*="message"], div[class*="content"], div[class*="bubble"], article, [class*="markdown"]');
      for (let i = candidates.length - 1; i >= 0; i--) {
        const el = candidates[i];
        const t = el.textContent?.trim() || '';
        if (t.length > 20 && !el.querySelector('textarea') && !el.closest('form')) return el;
      }
      return null;
    },

    async insertText(text: string) {
      const el = findFirst(this.inputSelector) as HTMLTextAreaElement | null;
      if (!el) return false;
      el.focus();
      el.value = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },

    async submit() {
      const btn = findFirst(this.submitSelector) as HTMLButtonElement | null;
      if (!btn || btn.disabled) {
        const input = findFirst(this.inputSelector) as HTMLTextAreaElement;
        if (input) {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
          return true;
        }
        return false;
      }
      btn.click();
      return true;
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────

function findFirst(selectorList: string): Element | null {
  for (const sel of selectorList.split(',')) {
    const el = document.querySelector(sel.trim());
    if (el) return el;
  }
  return null;
}

function detectSite(): SiteAdapter | null {
  const hostname = window.location.hostname;
  return adapters.find((a) => a.hostMatch(hostname)) ?? null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Response observer ────────────────────────────────────────────────

let activeObserver: MutationObserver | null = null;

function observeResponse(
  adapter: SiteAdapter,
  cmdId: string,
  stream: boolean,
  onChunk: (text: string) => void,
  onDone: (fullText: string) => void,
  onError: (error: string) => void,
) {
  stopObserving();

  let lastText = '';
  let doneCheckTimer: ReturnType<typeof setInterval> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let noChangeCount = 0;
  let foundElement = false;
  const STABLE_THRESHOLD = 5;
  const OBSERVE_TIMEOUT = 60000;

  const check = () => {
    const el = adapter.getLastResponseElement();
    const currentText = el?.textContent?.trim() || '';

    if (!foundElement && el) {
      foundElement = true;
      console.log('[carl-superchat] Response element found');
    }

    if (currentText !== lastText) {
      noChangeCount = 0;
      if (stream && currentText.length > lastText.length) {
        const newPart = currentText.slice(lastText.length);
        onChunk(newPart);
      }
      lastText = currentText;
    } else if (currentText.length > 0) {
      noChangeCount++;
    }

    const generating = adapter.isGenerating();
    if (!generating && currentText.length > 0 && noChangeCount >= STABLE_THRESHOLD) {
      cleanup();
      onDone(lastText);
    }
  };

  const cleanup = () => {
    if (doneCheckTimer) { clearInterval(doneCheckTimer); doneCheckTimer = null; }
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
    if (activeObserver) { activeObserver.disconnect(); activeObserver = null; }
  };

  timeoutTimer = setTimeout(() => {
    console.warn('[carl-superchat] Observer timeout, sending what we have');
    cleanup();
    if (lastText.length > 0) {
      onDone(lastText);
    } else {
      onError('Timeout: no response detected within 60s');
    }
  }, OBSERVE_TIMEOUT);

  activeObserver = new MutationObserver(() => check());

  activeObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  doneCheckTimer = setInterval(check, 300);
}

function stopObserving() {
  if (activeObserver) {
    activeObserver.disconnect();
    activeObserver = null;
  }
}

// ── Message handler ──────────────────────────────────────────────────

const adapter = detectSite();

if (adapter) {
  chrome.runtime.sendMessage({
    type: 'bridge:register',
    site: adapter.name,
    url: window.location.href,
    title: document.title,
  });

  chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
    if (message.type === 'bridge:send') {
      handleSendCommand(message);
    }
  });

  window.addEventListener('beforeunload', () => {
    stopObserving();
    chrome.runtime.sendMessage({ type: 'bridge:unregister' }).catch(() => {});
  });

  console.log(`[carl-superchat] Adapter "${adapter.name}" active on ${window.location.hostname}`);
} else {
  console.log('[carl-superchat] No adapter matched for', window.location.hostname);
}

async function handleSendCommand(cmd: { id: string; message: string; stream?: boolean }) {
  if (!adapter) return;

  const stream = cmd.stream ?? true;

  const inserted = await adapter.insertText(cmd.message);
  if (!inserted) {
    chrome.runtime.sendMessage({ type: 'bridge:error', id: cmd.id, site: adapter.name, error: 'Failed to insert text' });
    return;
  }

  await sleep(200);

  const submitted = await adapter.submit();
  if (!submitted) {
    chrome.runtime.sendMessage({ type: 'bridge:error', id: cmd.id, site: adapter.name, error: 'Failed to submit' });
    return;
  }

  chrome.runtime.sendMessage({ type: 'bridge:sent', id: cmd.id, site: adapter.name });

  await sleep(adapter.name === 'qwen' ? 2500 : 1000);

  observeResponse(
    adapter,
    cmd.id,
    stream,
    (text) => {
      chrome.runtime.sendMessage({ type: 'bridge:chunk', id: cmd.id, site: adapter.name, text });
    },
    (fullText) => {
      chrome.runtime.sendMessage({ type: 'bridge:done', id: cmd.id, site: adapter.name, fullText });
    },
    (error) => {
      chrome.runtime.sendMessage({ type: 'bridge:error', id: cmd.id, site: adapter.name, error });
    },
  );
}
