import 'webextension-polyfill';
import { createLogger } from '@extension/shared/lib/logger';

const logger = createLogger('BACKGROUND');

const WS_PORT = process.env['PORT'] || '3010';
const WS_URL = `ws://localhost:${WS_PORT}`;
const RECONNECT_INTERVAL = 3000;
const HEARTBEAT_INTERVAL = 15000;

const SITE_URLS: Record<string, string> = {
  grok: 'https://grok.com/',
  gemini: 'https://gemini.google.com/app',
  qwen: 'https://chat.qwen.ai/',
};

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

interface TabInfo {
  tabId: number;
  site: string;
  url: string;
  title: string;
}

const registeredTabs = new Map<number, TabInfo>();

function connectToServer() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  logger.debug(`Connecting to server: ${WS_URL}`);

  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    logger.error('WebSocket creation failed:', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    logger.debug('Connected to Node.js server');
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    startHeartbeat();
    broadcastToTabs({ type: 'bridge:server-status', connected: true });
  };

  ws.onmessage = (event) => {
    try {
      const cmd = JSON.parse(event.data);
      handleServerCommand(cmd);
    } catch (e) {
      logger.error('Failed to parse server message:', e);
    }
  };

  ws.onclose = () => {
    logger.debug('Disconnected from server');
    ws = null;
    stopHeartbeat();
    broadcastToTabs({ type: 'bridge:server-status', connected: false });
    scheduleReconnect();
  };

  ws.onerror = (e) => {
    logger.error('WebSocket error:', e);
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToServer();
  }, RECONNECT_INTERVAL);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'heartbeat', tabs: Array.from(registeredTabs.values()) }));
    }
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function sendToServer(msg: Record<string, unknown>) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    logger.warn('Cannot send to server — not connected');
  }
}

function handleServerCommand(cmd: any) {
  logger.debug('Server command:', cmd);

  switch (cmd.action) {
    case 'send': {
      const { id, site, message, files } = cmd;
      const msg: any = { type: 'bridge:send', id, message, stream: cmd.stream ?? true };
      if (files?.length) msg.files = files;
      routeToTab(id, site, msg);
      break;
    }
    case 'get_tabs': {
      sendToServer({ id: cmd.id, type: 'tabs', tabs: Array.from(registeredTabs.values()) });
      break;
    }
    case 'open_tab': {
      const { id, site } = cmd;
      openOrFocusTab(id, site);
      break;
    }
    default:
      logger.warn('Unknown server command:', cmd.action);
      sendToServer({ id: cmd.id, type: 'error', error: `Unknown action: ${cmd.action}` });
  }
}

// Keep track of tabs with active requests so we can keep them awake
const activeRequestTabs = new Set<number>();
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    for (const tabId of activeRequestTabs) {
      // Inject a tiny script to force the tab to "wake up" and process pending renders
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => { /* wake up */ },
      }).catch(() => {});
    }
  }, 500);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

async function routeToTab(cmdId: string, site: string, message: any) {
  let tab = findTabBySite(site);

  logger.debug(`routeToTab: cmdId=${cmdId}, site=${site}, type=${message.type}, tabFound=${!!tab}`);

  if (!tab) {
    const url = SITE_URLS[site];
    if (!url) {
      sendToServer({ id: cmdId, type: 'error', site, error: `No open tab for site: ${site}` });
      return;
    }

    logger.debug(`No tab for ${site}, auto-opening...`);
    try {
      await chrome.tabs.create({ url, active: false });
    } catch (err: any) {
      sendToServer({ id: cmdId, type: 'error', site, error: `Failed to auto-open tab: ${err.message}` });
      return;
    }

    // Wait for content script to register (up to 15s)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      tab = findTabBySite(site);
      if (tab) break;
    }

    if (!tab) {
      sendToServer({ id: cmdId, type: 'error', site, error: `Tab opened but content script did not register within 15s` });
      return;
    }
    logger.debug(`Auto-opened tab ${tab.tabId} for ${site}`);
  }

  logger.debug(`Sending message to tab ${tab.tabId}: type=${message.type}, id=${cmdId}`);

  if (message.type === 'bridge:send') {
    activeRequestTabs.add(tab.tabId);
    startKeepAlive();
  }

  chrome.tabs.sendMessage(tab.tabId, message).catch((err) => {
    logger.error(`Failed to send to tab ${tab!.tabId}: ${err.message}`);
    sendToServer({ id: cmdId, type: 'error', site, error: `Tab communication failed: ${err.message}` });
    activeRequestTabs.delete(tab!.tabId);
    if (activeRequestTabs.size === 0) stopKeepAlive();
  });
}

function findTabBySite(site: string): TabInfo | undefined {
  for (const info of registeredTabs.values()) {
    if (info.site === site) return info;
  }
  return undefined;
}

async function openOrFocusTab(cmdId: string, site: string) {
  const existing = findTabBySite(site);
  if (existing) {
    chrome.tabs.update(existing.tabId, { active: true }).catch(() => {});
    sendToServer({ id: cmdId, type: 'tab_opened', site, tabId: existing.tabId, alreadyOpen: true });
    return;
  }

  const url = SITE_URLS[site];
  if (!url) {
    sendToServer({ id: cmdId, type: 'error', site, error: `Unknown site: ${site}` });
    return;
  }

  try {
    const tab = await chrome.tabs.create({ url, active: false });
    logger.debug(`Opened new tab for ${site}: ${tab.id}`);
    sendToServer({ id: cmdId, type: 'tab_opened', site, tabId: tab.id!, alreadyOpen: false });
  } catch (err: any) {
    sendToServer({ id: cmdId, type: 'error', site, error: `Failed to open tab: ${err.message}` });
  }
}

function broadcastToTabs(message: any) {
  for (const tabId of registeredTabs.keys()) {
    chrome.tabs.sendMessage(tabId, message).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'bridge:register': {
      if (tabId) {
        registeredTabs.set(tabId, {
          tabId,
          site: message.site,
          url: message.url,
          title: message.title || '',
        });
        logger.debug(`Tab ${tabId} registered as ${message.site}`);
        sendToServer({
          type: 'tab_registered',
          tabId,
          site: message.site,
          url: message.url,
          title: message.title,
        });
      }
      sendResponse({ ok: true, connected: ws?.readyState === WebSocket.OPEN });
      return false;
    }

    case 'bridge:unregister': {
      if (tabId) {
        registeredTabs.delete(tabId);
        logger.debug(`Tab ${tabId} unregistered`);
        sendToServer({ type: 'tab_unregistered', tabId });
      }
      sendResponse({ ok: true });
      return false;
    }

    case 'bridge:chunk': {
      sendToServer({
        id: message.id,
        type: 'chunk',
        site: message.site,
        text: message.text,
      });
      return false;
    }

    case 'bridge:done': {
      sendToServer({
        id: message.id,
        type: 'done',
        site: message.site,
        fullText: message.fullText,
      });
      if (tabId) { activeRequestTabs.delete(tabId); if (activeRequestTabs.size === 0) stopKeepAlive(); }
      return false;
    }

    case 'bridge:sent': {
      sendToServer({
        id: message.id,
        type: 'sent',
        site: message.site,
        tabId,
      });
      return false;
    }

    case 'bridge:error': {
      logger.error(`Error from content script: tabId=${tabId}, site=${message.site}, error=${message.error}`);
      sendToServer({
        id: message.id,
        type: 'error',
        site: message.site,
        error: message.error,
      });
      if (tabId) { activeRequestTabs.delete(tabId); if (activeRequestTabs.size === 0) stopKeepAlive(); }
      return false;
    }

    case 'bridge:get-status': {
      sendResponse({
        connected: ws?.readyState === WebSocket.OPEN,
        tabs: Array.from(registeredTabs.values()),
      });
      return false;
    }
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (registeredTabs.has(tabId)) {
    const info = registeredTabs.get(tabId);
    registeredTabs.delete(tabId);
    logger.debug(`Tab ${tabId} removed`);
    sendToServer({ type: 'tab_unregistered', tabId, site: info?.site });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && registeredTabs.has(tabId)) {
    const info = registeredTabs.get(tabId)!;
    info.url = changeInfo.url;
  }
});

connectToServer();
logger.debug('Background script loaded — carl-superchat bridge');
