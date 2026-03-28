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
      const cursors = Array.from(document.querySelectorAll('span.blinking-cursor, span[class*="cursor"], div[class*="typing"]'));
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

  {
    name: 'kimi',
    hostMatch: (h) => h.includes('kimi.com') || h.includes('kimi.moonshot.cn'),
    inputSelector: '.chat-input-editor[contenteditable="true"], div[contenteditable="true"][data-lexical-editor="true"], .chat-input-editor, textarea[placeholder*="Ask"]',
    // Kimi uses .send-button-container as the clickable wrapper, .send-icon is just an SVG
    submitSelector: '.send-button-container:not(.disabled), .chat-editor-action .send-button-container, button[class*="send"], div[class*="send-button"]',
    // Kimi response structure: .segment-content .markdown-container .markdown
    responseContainerSelector: '.segment-content .markdown, .markdown-container .markdown, .segment-content-box .markdown',

    isGenerating() {
      // Kimi shows loading indicator while generating
      const stop = document.querySelector('.stop-button, .segment-loading, [class*="stop"], [class*="loading-indicator"]');
      if (stop && stop.getBoundingClientRect().width > 0) return true;
      // Check for typing cursor
      const cursors = Array.from(document.querySelectorAll('.typing-cursor, .blinking-cursor, [class*="cursor"]'));
      for (const c of cursors) { if (c.getBoundingClientRect().width > 0) return true; }
      return false;
    },

    getLastResponseElement() {
      // Kimi-specific selectors based on actual DOM structure
      const kimiSelectors = [
        '.segment-content .markdown',
        '.segment-content-box .markdown',
        '.markdown-container .markdown',
        '.segment-content .paragraph',
        '[class*="segment-content"] .markdown',
        '[class*="segment-assistant"] .markdown',
      ];
      
      for (const sel of kimiSelectors) {
        const all = document.querySelectorAll(sel);
        if (all.length) {
          console.log(`[carl-superchat] Kimi: found response with selector ${sel}, count=${all.length}`);
          return all[all.length - 1];
        }
      }
      
      // Generic fallback selectors
      const fallbackSelectors = [
        'div[class*="markdown-body"]',
        'div[class*="assistant-message"]',
        'div[class*="message-content"]',
        'div.markdown-body',
        'div[class*="prose"]',
      ];
      
      for (const sel of fallbackSelectors) {
        const all = document.querySelectorAll(sel);
        if (all.length) return all[all.length - 1];
      }
      
      return null;
    },

    async insertText(text: string) {
      const el = findFirst(this.inputSelector) as HTMLElement | null;
      if (!el) return false;
      el.focus();

      // Handle contenteditable elements (Kimi uses Lexical editor)
      if (el.hasAttribute('contenteditable')) {
        el.textContent = '';
        document.execCommand('selectAll', false);
        document.execCommand('insertText', false, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.tagName === 'TEXTAREA') {
        (el as HTMLTextAreaElement).value = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    },

    async submit() {
      // Try to find and click the send button container
      const btn = findFirst(this.submitSelector) as HTMLElement | null;
      
      if (btn) {
        // Check if it's disabled
        const isDisabled = btn.classList.contains('disabled') || 
                          btn.getAttribute('aria-disabled') === 'true' ||
                          (btn as any).disabled;
        
        if (!isDisabled) {
          console.log('[carl-superchat] Kimi: clicking send button container');
          btn.click();
          return true;
        }
      }
      
      // Fallback: try Enter key on input
      const input = findFirst(this.inputSelector) as HTMLElement;
      if (input) {
        console.log('[carl-superchat] Kimi: using Enter key fallback');
        input.focus();
        
        // Kimi may need specific keyboard events
        const enterEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        });
        input.dispatchEvent(enterEvent);
        
        // Also try keyup
        const keyupEvent = new KeyboardEvent('keyup', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
        });
        input.dispatchEvent(keyupEvent);
        
        return true;
      }
      
      return false;
    },
  },

  {
    name: 'deepseek',
    hostMatch: (h) => h.includes('deepseek.com'),
    inputSelector: 'textarea#chat-input, textarea[placeholder*="Message DeepSeek"], textarea[placeholder*="Send a message"], div[contenteditable="true"]',
    submitSelector: 'button[data-testid="send-button"], button.ds-icon-button, div._7436101 button, button[aria-label*="Send"]',
    // DeepSeek response structure
    responseContainerSelector: '.ds-markdown, .markdown-body, div[class*="markdown"]',

    isGenerating() {
      // DeepSeek shows stop button while generating
      const stop = document.querySelector('button[aria-label*="Stop"], div[class*="stop"], .stop-generating');
      if (stop && stop.getBoundingClientRect().width > 0) return true;
      // Check for loading indicators
      const loading = document.querySelector('[class*="loading"], [class*="typing"], .regenerate-loading');
      if (loading && loading.getBoundingClientRect().width > 0) return true;
      return false;
    },

    getLastResponseElement() {
      // DeepSeek-specific selectors
      const deepseekSelectors = [
        '.ds-markdown',
        '.markdown-body',
        'div[class*="_8de5354"]',  // DeepSeek hashed class for response
        'div[class*="assistant"] .ds-markdown',
        '[class*="message-content"] .ds-markdown',
      ];
      
      for (const sel of deepseekSelectors) {
        const all = document.querySelectorAll(sel);
        if (all.length) {
          console.log(`[carl-superchat] DeepSeek: found response with selector ${sel}, count=${all.length}`);
          return all[all.length - 1];
        }
      }
      
      // Generic fallback
      const fallback = document.querySelectorAll('div[class*="markdown"]');
      if (fallback.length) return fallback[fallback.length - 1];
      
      return null;
    },

    async insertText(text: string) {
      const el = findFirst(this.inputSelector) as HTMLElement | null;
      if (!el) return false;
      el.focus();

      // DeepSeek uses textarea
      if (el.tagName === 'TEXTAREA') {
        const textarea = el as HTMLTextAreaElement;
        textarea.value = text;
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.hasAttribute('contenteditable')) {
        el.textContent = '';
        document.execCommand('selectAll', false);
        document.execCommand('insertText', false, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      }
      return true;
    },

    async submit() {
      // Try to find and click the send button
      const btn = findFirst(this.submitSelector) as HTMLElement | null;
      
      if (btn) {
        const isDisabled = btn.classList.contains('disabled') || 
                          btn.getAttribute('aria-disabled') === 'true' ||
                          (btn as any).disabled;
        
        if (!isDisabled) {
          console.log('[carl-superchat] DeepSeek: clicking send button');
          btn.click();
          return true;
        }
      }
      
      // Fallback: Enter key
      const input = findFirst(this.inputSelector) as HTMLElement;
      if (input) {
        console.log('[carl-superchat] DeepSeek: using Enter key fallback');
        input.focus();
        
        const enterEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        });
        input.dispatchEvent(enterEvent);
        return true;
      }
      
      return false;
    },
  },

  {
    name: 'zai',
    hostMatch: (h) => h.includes('z.ai'),
    inputSelector: '#chat-input, textarea#chat-input, textarea[placeholder*="Ask"], div[contenteditable="true"]',
    submitSelector: '#send-message-button, button[type="submit"], button[aria-label*="Send"]',
    // Z.AI response structure
    responseContainerSelector: '.markdown-body, div[class*="markdown"], div[class*="prose"]',

    isGenerating() {
      // Z.AI shows stop button while generating
      const stop = document.querySelector('button[aria-label*="Stop"], div[class*="stop"], [class*="loading"]');
      if (stop && stop.getBoundingClientRect().width > 0) return true;
      return false;
    },

    getLastResponseElement() {
      // Z.AI-specific selectors
      const zaiSelectors = [
        '.markdown-body',
        'div[class*="prose"]',
        'div[class*="assistant"] .markdown-body',
        '[class*="message-content"] .markdown-body',
        'div[class*="response"]',
      ];
      
      for (const sel of zaiSelectors) {
        const all = document.querySelectorAll(sel);
        if (all.length) {
          console.log(`[carl-superchat] Z.AI: found response with selector ${sel}, count=${all.length}`);
          return all[all.length - 1];
        }
      }
      
      // Generic fallback
      const fallback = document.querySelectorAll('div[class*="markdown"]');
      if (fallback.length) return fallback[fallback.length - 1];
      
      return null;
    },

    async insertText(text: string) {
      const el = findFirst(this.inputSelector) as HTMLElement | null;
      if (!el) return false;
      el.focus();

      // Z.AI uses textarea
      if (el.tagName === 'TEXTAREA') {
        const textarea = el as HTMLTextAreaElement;
        textarea.value = text;
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.hasAttribute('contenteditable')) {
        el.textContent = '';
        document.execCommand('selectAll', false);
        document.execCommand('insertText', false, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      }
      return true;
    },

    async submit() {
      // Try to find and click the send button
      const btn = findFirst(this.submitSelector) as HTMLElement | null;
      
      if (btn) {
        const isDisabled = btn.classList.contains('disabled') || 
                          btn.getAttribute('aria-disabled') === 'true' ||
                          (btn as any).disabled;
        
        if (!isDisabled) {
          console.log('[carl-superchat] Z.AI: clicking send button');
          btn.click();
          return true;
        }
      }
      
      // Fallback: Enter key
      const input = findFirst(this.inputSelector) as HTMLElement;
      if (input) {
        console.log('[carl-superchat] Z.AI: using Enter key fallback');
        input.focus();
        
        const enterEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        });
        input.dispatchEvent(enterEvent);
        return true;
      }
      
      return false;
    },
  },

  {
    name: 'chatgpt',
    hostMatch: (h) => h.includes('chatgpt.com'),
    inputSelector: '#prompt-textarea, .ProseMirror[contenteditable="true"], div[contenteditable="true"][data-id*="prompt"]',
    submitSelector: 'button[data-testid="send-button"], button[aria-label*="Send"], button[data-testid="fruitjuice-send-button"]',
    // ChatGPT response structure
    responseContainerSelector: '.markdown.prose, [data-message-author-role="assistant"] .markdown, div[class*="markdown"]',

    isGenerating() {
      // ChatGPT shows stop button while generating
      const stop = document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]');
      if (stop && stop.getBoundingClientRect().width > 0) return true;
      // Check for loading indicators
      const loading = document.querySelector('[class*="result-streaming"], [class*="typing"]');
      if (loading && loading.getBoundingClientRect().width > 0) return true;
      return false;
    },

    getLastResponseElement() {
      // ChatGPT-specific selectors
      const chatgptSelectors = [
        '[data-message-author-role="assistant"] .markdown.prose',
        '[data-message-author-role="assistant"] .markdown',
        '.agent-turn .markdown.prose',
        'div[class*="markdown"].prose',
        '[class*="message"][class*="assistant"] .markdown',
      ];
      
      for (const sel of chatgptSelectors) {
        const all = document.querySelectorAll(sel);
        if (all.length) {
          console.log(`[carl-superchat] ChatGPT: found response with selector ${sel}, count=${all.length}`);
          return all[all.length - 1];
        }
      }
      
      // Generic fallback
      const fallback = document.querySelectorAll('div[class*="markdown"]');
      if (fallback.length) return fallback[fallback.length - 1];
      
      return null;
    },

    async insertText(text: string) {
      const el = findFirst(this.inputSelector) as HTMLElement | null;
      if (!el) return false;
      el.focus();

      // ChatGPT uses ProseMirror (contenteditable)
      if (el.classList.contains('ProseMirror') || el.hasAttribute('contenteditable')) {
        // Clear existing content
        el.innerHTML = '';
        // Insert text via execCommand for ProseMirror compatibility
        document.execCommand('insertText', false, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      } else if (el.tagName === 'TEXTAREA') {
        const textarea = el as HTMLTextAreaElement;
        textarea.value = text;
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    },

    async submit() {
      // Try to find and click the send button
      const btn = findFirst(this.submitSelector) as HTMLElement | null;
      
      if (btn) {
        const isDisabled = btn.classList.contains('disabled') || 
                          btn.getAttribute('aria-disabled') === 'true' ||
                          (btn as any).disabled;
        
        if (!isDisabled) {
          console.log('[carl-superchat] ChatGPT: clicking send button');
          btn.click();
          return true;
        }
      }
      
      // Fallback: Enter key
      const input = findFirst(this.inputSelector) as HTMLElement;
      if (input) {
        console.log('[carl-superchat] ChatGPT: using Enter key fallback');
        input.focus();
        
        const enterEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        });
        input.dispatchEvent(enterEvent);
        return true;
      }
      
      return false;
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
  kimi: '.attachment-button, .attachment-icon, input[type="file"], label.attachment-button, button[aria-label*="Attach"]',
  deepseek: 'button[aria-label*="attach"], button[aria-label*="file"], input[type="file"]',
  zai: 'button[aria-label*="More"], button[aria-label*="attach"], input[type="file"]',
  chatgpt: '#upload-file-btn, button[aria-label*="Add photos"], button[data-testid="composer-action-file-upload"], input[type="file"]',
};

const FILE_PREVIEW_SELECTORS: Record<string, string> = {
  grok: '[data-testid="file-preview"], .file-preview, [class*="attachment-preview"], [class*="file-pill"], [class*="uploaded"], [class*="file-chip"]',
  gemini: '.file-preview, .xap-filed-upload-preview, [class*="file-chip"], [class*="upload-preview"]',
  qwen: '.vision-item-container, [class*="vision-item"], [class*="file-item"], [class*="attachment-item"], [class*="upload-file"], [class*="file-card"]',
  kimi: '.file-preview, .attachment-preview, .uploaded-file, [class*="file-item"], [class*="attachment-item"]',
  deepseek: '.file-preview, .attachment-preview, [class*="file-item"], [class*="uploaded-file"]',
  zai: '.file-preview, [class*="file-item"], [class*="uploaded"], div.px-3.pb-3',
  chatgpt: '.file-preview, .attachment-preview, [data-testid="file-attachment"], [class*="file-chip"]',
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

/**
 * Wait for chat input to be ready (visible and not disabled)
 * Protection against race condition when page is still loading
 */
async function waitForInputReady(siteName: string, timeout = 10000): Promise<boolean> {
  const startTime = Date.now();
  const checkInterval = 200;
  
  // Site-specific selectors
  const inputSelectors: Record<string, string> = {
    grok: 'textarea[placeholder*="Ask"], textarea[data-testid], textarea[class*="input"], div[contenteditable="true"]',
    gemini: 'div.ql-editor[contenteditable="true"], div[contenteditable="true"][aria-label], div.textarea',
    qwen: 'textarea.message-input-textarea, #chat-input, textarea.chat-input',
    kimi: '.chat-input-editor[contenteditable="true"], div[contenteditable="true"][data-lexical-editor="true"], .chat-input-editor',
    deepseek: 'textarea#chat-input, textarea[placeholder*="Message DeepSeek"], textarea[placeholder*="Send a message"]',
    zai: '#chat-input, textarea#chat-input, textarea[placeholder*="Ask"]',
    chatgpt: '#prompt-textarea, .ProseMirror[contenteditable="true"], div[contenteditable="true"][data-id*="prompt"]',
  };
  
  const selector = inputSelectors[siteName] || 'textarea, [contenteditable="true"], input[type="text"]';
  
  while (Date.now() - startTime < timeout) {
    const el = document.querySelector(selector) as HTMLElement | null;
    
    if (el) {
      const isVisible = el.offsetParent !== null || el.getBoundingClientRect().width > 0;
      const isDisabled = (el as HTMLInputElement).disabled === true;
      const isReadonly = el.hasAttribute('readonly');
      
      if (isVisible && !isDisabled && !isReadonly) {
        console.log(`[carl-superchat] waitForInputReady: found input after ${Date.now() - startTime}ms`);
        return true;
      }
      console.log(`[carl-superchat] waitForInputReady: input found but not ready (visible=${isVisible}, disabled=${isDisabled}, readonly=${isReadonly})`);
    } else {
      console.log(`[carl-superchat] waitForInputReady: input not found yet, selector=${selector}`);
    }
    
    await sleep(checkInterval);
  }
  
  console.error(`[carl-superchat] waitForInputReady: timeout after ${timeout}ms`);
  return false;
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
  kimi: '[class*="uploading"], [class*="progress"], [class*="spinner"], [class*="loading"]',
  deepseek: '[class*="uploading"], [class*="progress"], [class*="spinner"], [class*="loading"]',
  zai: '[class*="uploading"], [class*="progress"], [class*="spinner"], [class*="loading"]',
  chatgpt: '[class*="uploading"], [class*="progress"], [class*="spinner"], [class*="loading"]',
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
  if (!adapter) {
    console.error('[carl-superchat] handleSendCommand: No adapter available');
    chrome.runtime.sendMessage({ type: 'bridge:error', id: cmd.id, site: 'unknown', error: 'No adapter available' });
    return;
  }

  const stream = cmd.stream ?? true;
  const msgPreview = cmd.message.substring(0, 100) + (cmd.message.length > 100 ? '...' : '');
  
  console.log(`[carl-superchat] handleSendCommand: site=${adapter.name}, id=${cmd.id}, msgLen=${cmd.message.length}, files=${cmd.files?.length || 0}, stream=${stream}`);

  // Wait for chat input to be ready (protection against race condition)
  const inputReady = await waitForInputReady(adapter.name, 10000);
  if (!inputReady) {
    const error = `Timeout waiting for chat input: site=${adapter.name}, waited 10s`;
    console.error(`[carl-superchat] ${error}`);
    chrome.runtime.sendMessage({ type: 'bridge:error', id: cmd.id, site: adapter.name, error });
    return;
  }
  console.log(`[carl-superchat] Chat input is ready`);

  if (cmd.files?.length) {
    console.log(`[carl-superchat] Attaching ${cmd.files.length} files...`);
    try {
      const ok = await attachFiles(adapter.name, cmd.files);
      if (!ok) {
        const error = `Failed to attach files: site=${adapter.name}, fileCount=${cmd.files.length}`;
        console.error(`[carl-superchat] ${error}`);
        chrome.runtime.sendMessage({ type: 'bridge:error', id: cmd.id, site: adapter.name, error });
        return;
      }
      console.log(`[carl-superchat] Files attached, waiting for upload...`);
      await waitForFileUpload(adapter.name);
      console.log(`[carl-superchat] File upload complete`);
    } catch (err: any) {
      const error = `File attach error: site=${adapter.name}, err=${err.message}`;
      console.error(`[carl-superchat] ${error}`);
      chrome.runtime.sendMessage({ type: 'bridge:error', id: cmd.id, site: adapter.name, error });
      return;
    }
  }

  console.log(`[carl-superchat] Inserting text (${cmd.message.length} chars)...`);
  
  // Retry logic for insertText
  let inserted = false;
  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    inserted = await adapter.insertText(cmd.message);
    if (inserted) break;
    
    // Collect diagnostic info
    const inputEl = document.querySelector('textarea, [contenteditable="true"], input[type="text"]');
    const inputFound = !!inputEl;
    const inputVisible = inputEl ? (inputEl as HTMLElement).offsetParent !== null : false;
    const inputDisabled = inputEl ? (inputEl as HTMLInputElement).disabled : false;
    lastError = `attempt=${attempt}, inputFound=${inputFound}, inputVisible=${inputVisible}, inputDisabled=${inputDisabled}`;
    
    console.warn(`[carl-superchat] insertText failed (${lastError}), ${attempt < 3 ? 'retrying in 1s...' : 'giving up'}`);
    if (attempt < 3) await sleep(1000);
  }
  
  if (!inserted) {
    const error = `Failed to insert text after 3 attempts: site=${adapter.name}, ${lastError}, msgLen=${cmd.message.length}`;
    console.error(`[carl-superchat] ${error}`);
    chrome.runtime.sendMessage({ type: 'bridge:error', id: cmd.id, site: adapter.name, error });
    return;
  }
  console.log(`[carl-superchat] Text inserted successfully`);

  await sleep(adapter.name === 'gemini' ? 500 : 200);

  console.log(`[carl-superchat] Submitting...`);
  const submitted = await adapter.submit();
  if (!submitted) {
    const submitBtn = document.querySelector('button[type="submit"], button[aria-label*="send"], button[aria-label*="Send"]');
    const btnFound = !!submitBtn;
    const btnDisabled = submitBtn ? (submitBtn as HTMLButtonElement).disabled : false;
    
    const error = `Failed to submit: site=${adapter.name}, btnFound=${btnFound}, btnDisabled=${btnDisabled}`;
    console.error(`[carl-superchat] ${error}`);
    chrome.runtime.sendMessage({ type: 'bridge:error', id: cmd.id, site: adapter.name, error });
    return;
  }
  console.log(`[carl-superchat] Submitted successfully`);

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
