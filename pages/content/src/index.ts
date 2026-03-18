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
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(el, text);
        } else {
          (el as HTMLTextAreaElement).value = text;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.textContent = '';
        document.execCommand('insertText', false, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
      return true;
    },

    async submit() {
      await sleep(300);
      const btn = findFirst(this.submitSelector) as HTMLButtonElement | null;
      if (btn && !btn.disabled) {
        btn.click();
        return true;
      }
      const input = findFirst(this.inputSelector) as HTMLElement;
      if (input) {
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }),
        );
        return true;
      }
      return false;
    },
  },

  {
    name: 'gemini',
    hostMatch: (h) => h.includes('gemini.google.com'),
    inputSelector: 'div.ql-editor.textarea, div.ql-editor, rich-textarea [contenteditable="true"]',
    submitSelector:
      'button.send-button, button[aria-label="Send message"], button[aria-label*="Send"]',
    responseContainerSelector: 'message-content, .model-response-text, div.markdown',

    isGenerating() {
      const stop = document.querySelector(
        'button[aria-label="Stop generating"], mat-icon[data-mat-icon-name="stop_circle"], button[aria-label="Stop response"]',
      );
      return !!stop && stop.getBoundingClientRect().width > 0;
    },

    getLastResponseElement() {
      const msgs = document.querySelectorAll(
        'message-content, .model-response-text, div.markdown, .response-content',
      );
      return msgs.length ? msgs[msgs.length - 1] : null;
    },

    async insertText(text: string) {
      const el = findFirst(this.inputSelector) as HTMLElement | null;
      if (!el) {
        console.warn('[carl-superchat] Gemini: input element not found');
        return false;
      }
      el.focus();
      await sleep(100);
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      console.log('[carl-superchat] Gemini: text inserted, length=', text.length);
      return true;
    },

    async submit() {
      await sleep(500);
      const btn = findFirst(this.submitSelector) as HTMLButtonElement | null;
      console.log('[carl-superchat] Gemini: send button found=', !!btn, 'disabled=', btn?.disabled);
      if (btn && !btn.disabled) {
        btn.click();
        return true;
      }
      const input = findFirst(this.inputSelector) as HTMLElement;
      if (input) {
        console.log('[carl-superchat] Gemini: fallback Enter key');
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }),
        );
        return true;
      }
      return false;
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

// ── File attachment types & helpers ───────────────────────────────────

interface FileData {
  name: string;
  mime: string;
  data: string; // base64
}

// Both Grok and Qwen use id="filesUpload" (display:none), created dynamically on attach-button click
const FILE_INPUT_ID = '#filesUpload';

const ATTACH_BUTTON_SELECTORS: Record<string, string> = {
  grok: 'button[aria-label="Attach file"], button[aria-label="Attach files"], button[aria-label="Attach media"], [data-testid="attach-file"], button[class*="attach"], label[for="filesUpload"]',
  gemini: 'button[aria-label="Add files"], button[aria-label="Upload file"], button[aria-label="Add file"]',
  // Qwen: clicking "+" (ant-dropdown-trigger) opens a menu; "Загрузить вложение" is the first li
  qwen: 'span.ant-dropdown-trigger, div.mode-select span.ant-dropdown-trigger',
};

const FILE_PREVIEW_SELECTORS: Record<string, string> = {
  grok: '[data-testid="file-preview"], .file-preview, [class*="attachment-preview"], [class*="file-pill"], [class*="uploaded"], [class*="file-chip"]',
  gemini: '.file-preview, .xap-filed-upload-preview, [class*="file-chip"], [class*="upload-preview"]',
  qwen: '.vision-item-container, [class*="vision-item"], [class*="file-item"], [class*="attachment-item"], [class*="upload-file"], [class*="file-card"]',
};

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

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr.buffer;
}

function waitForElement(selectorList: string, timeout = 8000): Promise<Element | null> {
  const existing = findFirst(selectorList);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const timer = setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
    const observer = new MutationObserver(() => {
      const el = findFirst(selectorList);
      if (el) { clearTimeout(timer); observer.disconnect(); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

// ── Strategy 1: Paste event (most universal — works like Ctrl+V) ─────

async function attachViaPaste(siteName: string, adapter: SiteAdapter, files: File[]): Promise<boolean> {
  const inputEl = findFirst(adapter.inputSelector) as HTMLElement | null;
  const target = inputEl || document.body;
  if (inputEl) inputEl.focus();

  const dt = new DataTransfer();
  files.forEach(f => dt.items.add(f));

  const pasteEvent = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: dt,
  });

  target.dispatchEvent(pasteEvent);
  console.log(`[carl-superchat] Paste event dispatched on ${target.tagName}`);

  const previewSel = FILE_PREVIEW_SELECTORS[siteName];
  if (previewSel) {
    const preview = await waitForElement(previewSel, 5000);
    if (preview) {
      console.log('[carl-superchat] Paste: file preview detected');
      return true;
    }
  }
  await sleep(1000);
  return false;
}

// ── Strategy 2: file input with click interception ───────────────────

async function triggerAttachButton(siteName: string): Promise<HTMLInputElement | null> {
  const existing = document.querySelector(FILE_INPUT_ID) as HTMLInputElement | null;
  if (existing) return existing;

  const btnSel = ATTACH_BUTTON_SELECTORS[siteName];
  const btn = btnSel ? (findFirst(btnSel) as HTMLElement | null) : null;
  if (!btn) {
    console.warn(`[carl-superchat] Attach button not found for ${siteName}`);
    return null;
  }

  // Intercept HTMLInputElement.click to prevent native file picker from opening
  const origClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
    if (this.type === 'file') {
      console.log('[carl-superchat] Blocked native file picker');
      return;
    }
    return origClick.call(this);
  };

  let capturedInput: HTMLInputElement | null = null;

  try {
    if (siteName === 'qwen') {
      btn.click();
      const menuItem = await waitForElement('li.mode-select-common-item', 3000) as HTMLElement | null;
      if (!menuItem) {
        console.warn('[carl-superchat] Qwen: upload menu item not found');
        return null;
      }
      menuItem.click();
      await sleep(500);
    } else {
      btn.click();
      await sleep(500);
    }

    capturedInput = document.querySelector(FILE_INPUT_ID) as HTMLInputElement | null;
    if (!capturedInput) {
      capturedInput = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    }
  } finally {
    HTMLInputElement.prototype.click = origClick;
  }

  return capturedInput;
}

async function attachViaInput(siteName: string, files: File[]): Promise<boolean> {
  let fileInput = document.querySelector(FILE_INPUT_ID) as HTMLInputElement | null
    || document.querySelector('input[type="file"]') as HTMLInputElement | null;

  if (!fileInput) {
    fileInput = await triggerAttachButton(siteName);
  }

  if (!fileInput) {
    console.warn(`[carl-superchat] No file input found for ${siteName}`);
    return false;
  }

  const dt = new DataTransfer();
  files.forEach(f => dt.items.add(f));
  fileInput.files = dt.files;
  fileInput.dispatchEvent(new Event('input', { bubbles: true }));
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));

  console.log(`[carl-superchat] Set ${files.length} file(s) on input, dispatched change`);

  const previewSel = FILE_PREVIEW_SELECTORS[siteName];
  if (previewSel) {
    const preview = await waitForElement(previewSel, 5000);
    if (preview) {
      console.log('[carl-superchat] Input: file preview detected');
      return true;
    }
  }
  await sleep(1000);
  return false;
}

// ── Strategy 3: Drag and drop ────────────────────────────────────────

async function attachViaDragDrop(siteName: string, adapter: SiteAdapter, files: File[]): Promise<boolean> {
  const target = (findFirst(adapter.inputSelector) as HTMLElement | null)
    || (findFirst('div[contenteditable="true"], [role="textbox"]') as HTMLElement | null)
    || document.body;

  const dt = new DataTransfer();
  files.forEach(f => dt.items.add(f));

  target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
  await sleep(50);
  target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  await sleep(50);
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));

  console.log(`[carl-superchat] Drop dispatched on ${target.tagName}`);

  const previewSel = FILE_PREVIEW_SELECTORS[siteName];
  if (previewSel) {
    const preview = await waitForElement(previewSel, 5000);
    if (preview) {
      console.log('[carl-superchat] Drop: file preview detected');
      return true;
    }
  }
  await sleep(1000);
  return false;
}

// ── Main attach: try strategies in order ─────────────────────────────

async function attachFiles(siteName: string, filesData: FileData[]): Promise<boolean> {
  if (!filesData.length) return true;

  const currentAdapter = adapters.find(a => a.name === siteName);
  if (!currentAdapter) return false;

  const files = filesData.map(fd =>
    new File([base64ToArrayBuffer(fd.data)], fd.name, { type: fd.mime }),
  );

  // Strategy 1: paste (most reliable, works like Ctrl+V)
  console.log(`[carl-superchat] Trying paste strategy for ${siteName}...`);
  if (await attachViaPaste(siteName, currentAdapter, files)) {
    console.log(`[carl-superchat] Attached ${files.length} file(s) via paste`);
    return true;
  }

  // Strategy 2: file input with click interception
  console.log(`[carl-superchat] Paste didn't work, trying input strategy for ${siteName}...`);
  if (await attachViaInput(siteName, files)) {
    console.log(`[carl-superchat] Attached ${files.length} file(s) via input`);
    return true;
  }

  // Strategy 3: drag and drop
  console.log(`[carl-superchat] Input didn't work, trying drag-drop for ${siteName}...`);
  if (await attachViaDragDrop(siteName, currentAdapter, files)) {
    console.log(`[carl-superchat] Attached ${files.length} file(s) via drag-drop`);
    return true;
  }

  // None worked — log but don't fail (file might have attached without detectable preview)
  console.warn(`[carl-superchat] No strategy confirmed file preview for ${siteName}. Proceeding anyway.`);
  return true;
}

// ── Wait for file upload to complete ─────────────────────────────────

const UPLOAD_LOADING_SELECTORS: Record<string, string> = {
  qwen: '.vision-spinner, .circle-spinner, [class*="vision-spinner"], [class*="circle-spinner"]',
  grok: '[class*="uploading"], [class*="progress"], [class*="spinner"]',
  gemini: '[class*="uploading"], [class*="progress"], [class*="spinner"]',
};

async function waitForFileUpload(siteName: string, maxWait = 30000): Promise<void> {
  const loadingSel = UPLOAD_LOADING_SELECTORS[siteName];
  const start = Date.now();

  // First: short initial wait for upload indicators to appear
  await sleep(1500);

  // Then: poll until no loading indicators remain
  while (Date.now() - start < maxWait) {
    const loadingEl = loadingSel ? findFirst(loadingSel) : null;
    const sendBtn = findFirst(
      adapters.find(a => a.name === siteName)?.submitSelector || 'button.send-button',
    ) as HTMLButtonElement | null;

    const stillLoading = loadingEl && loadingEl.getBoundingClientRect().width > 0;
    const btnDisabled = sendBtn && (sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true');

    if (!stillLoading && !btnDisabled) {
      console.log(`[carl-superchat] File upload complete (${Date.now() - start}ms)`);
      return;
    }

    console.log(`[carl-superchat] Waiting for upload... loading=${!!stillLoading} btnDisabled=${!!btnDisabled}`);
    await sleep(1000);
  }

  console.warn(`[carl-superchat] File upload wait timeout (${maxWait}ms), proceeding anyway`);
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

async function handleSendCommand(cmd: { id: string; message: string; stream?: boolean; files?: FileData[] }) {
  if (!adapter) return;

  const stream = cmd.stream ?? true;

  if (cmd.files?.length) {
    try {
      const ok = await attachFiles(adapter.name, cmd.files);
      if (!ok) {
        chrome.runtime.sendMessage({ type: 'bridge:error', id: cmd.id, site: adapter.name, error: 'Failed to attach files' });
        return;
      }
      await waitForFileUpload(adapter.name);
    } catch (err: any) {
      chrome.runtime.sendMessage({ type: 'bridge:error', id: cmd.id, site: adapter.name, error: `File attach error: ${err.message}` });
      return;
    }
  }

  const inserted = await adapter.insertText(cmd.message);
  if (!inserted) {
    chrome.runtime.sendMessage({ type: 'bridge:error', id: cmd.id, site: adapter.name, error: 'Failed to insert text' });
    return;
  }

  await sleep(adapter.name === 'gemini' ? 500 : 200);

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
