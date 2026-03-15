import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));

const manifest = {
  manifest_version: 3,
  default_locale: 'en',
  name: 'carl-superchat',
  version: packageJson.version,
  description: 'AI Chat Bridge — Grok, Gemini, Qwen',

  host_permissions: [
    '*://*.grok.com/*',
    '*://grok.com/*',
    '*://*.x.com/*',
    '*://x.com/*',
    '*://*.x.ai/*',
    '*://x.ai/*',
    '*://*.gemini.google.com/*',
    '*://gemini.google.com/*',
    '*://*.chat.qwen.ai/*',
    '*://chat.qwen.ai/*',
    '*://*.qwen.ai/*',
    '*://qwen.ai/*',
  ],

  permissions: ['storage', 'tabs'],

  background: {
    service_worker: 'background.js',
    type: 'module' as const,
  },

  icons: {
    128: 'icon-128.png',
    34: 'icon-34.png',
    16: 'icon-16.png',
  },

  content_scripts: [
    {
      matches: [
        '*://grok.com/*',
        '*://*.grok.com/*',
        '*://x.com/i/grok*',
        '*://*.x.com/i/grok*',
        '*://grok.x.ai/*',
        '*://*.x.ai/*',
      ],
      js: ['content/index.iife.js'],
      run_at: 'document_idle' as const,
    },
    {
      matches: ['*://gemini.google.com/*', '*://*.gemini.google.com/*'],
      js: ['content/index.iife.js'],
      run_at: 'document_idle' as const,
    },
    {
      matches: [
        '*://chat.qwen.ai/*',
        '*://*.chat.qwen.ai/*',
        '*://qwen.ai/*',
        '*://*.qwen.ai/*',
      ],
      js: ['content/index.iife.js'],
      run_at: 'document_idle' as const,
    },
  ],

  web_accessible_resources: [
    {
      resources: ['*.js', '*.css', '*.svg', 'icon-128.png', 'icon-34.png', 'icon-16.png'],
      matches: ['*://*/*'],
    },
  ],
} satisfies chrome.runtime.ManifestV3;

export default manifest;
