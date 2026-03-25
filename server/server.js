import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import { handleAgentRoute } from './terminal-agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3010;

// ── State ────────────────────────────────────────────────────────────

let extensionWs = null;
const pendingRequests = new Map();
const sseClients = new Map();

// ── HTTP Server ──────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/status' && req.method === 'GET') {
    return handleStatus(req, res);
  }

  if (url.pathname === '/api/tabs' && req.method === 'GET') {
    return handleGetTabs(req, res);
  }

  if (url.pathname === '/api/send' && req.method === 'POST') {
    return handleSend(req, res);
  }

  if (url.pathname === '/api/open' && req.method === 'POST') {
    return handleOpen(req, res);
  }

  // Terminal Agent API
  if (url.pathname.startsWith('/api/agent')) {
    const handled = await handleAgentRoute(req, res, url.pathname);
    if (handled !== false) return;
  }

  // Static files
  serveStatic(req, res, url.pathname);
});

// ── WebSocket Server ─────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('[WS] Extension connected');
  extensionWs = ws;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleExtensionMessage(msg);
    } catch (e) {
      console.error('[WS] Parse error:', e);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Extension disconnected');
    if (extensionWs === ws) extensionWs = null;
    rejectAllPending('Extension disconnected');
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
  });
});

function handleExtensionMessage(msg) {
  const { id, type } = msg;

  if (type === 'heartbeat') return;

  if (type === 'tab_registered' || type === 'tab_unregistered') {
    console.log(`[WS] ${type}:`, msg.site || msg.tabId);
    return;
  }

  const pending = id ? pendingRequests.get(id) : null;
  if (!pending) return;

  switch (type) {
    case 'sent':
      if (pending.res && !pending.streaming) {
        // non-streaming: wait for done
      }
      break;

    case 'chunk':
      if (pending.sseClientId) {
        const sseRes = sseClients.get(pending.sseClientId);
        if (sseRes && !sseRes.writableEnded) {
          sseRes.write(`data: ${JSON.stringify({ chunk: msg.text })}\n\n`);
        }
      }
      pending.fullText = (pending.fullText || '') + (msg.text || '');
      break;

    case 'done':
      if (pending.sseClientId) {
        const sseRes = sseClients.get(pending.sseClientId);
        if (sseRes && !sseRes.writableEnded) {
          sseRes.write(`data: ${JSON.stringify({ done: true, fullText: msg.fullText })}\n\n`);
          sseRes.end();
        }
        sseClients.delete(pending.sseClientId);
      } else if (pending.res && !pending.res.writableEnded) {
        jsonResponse(pending.res, 200, { ok: true, fullText: msg.fullText });
      }
      pendingRequests.delete(id);
      break;

    case 'error':
      if (pending.sseClientId) {
        const sseRes = sseClients.get(pending.sseClientId);
        if (sseRes && !sseRes.writableEnded) {
          sseRes.write(`data: ${JSON.stringify({ error: msg.error })}\n\n`);
          sseRes.end();
        }
        sseClients.delete(pending.sseClientId);
      } else if (pending.res && !pending.res.writableEnded) {
        jsonResponse(pending.res, 500, { ok: false, error: msg.error });
      }
      pendingRequests.delete(id);
      break;

    case 'tabs':
      if (pending.res && !pending.res.writableEnded) {
        jsonResponse(pending.res, 200, { tabs: msg.tabs });
      }
      pendingRequests.delete(id);
      break;

    case 'tab_opened':
      if (pending.res && !pending.res.writableEnded) {
        jsonResponse(pending.res, 200, { ok: true, site: msg.site, tabId: msg.tabId, alreadyOpen: msg.alreadyOpen });
      }
      pendingRequests.delete(id);
      break;
  }
}

function rejectAllPending(reason) {
  for (const [id, p] of pendingRequests) {
    if (p.sseClientId) {
      const sseRes = sseClients.get(p.sseClientId);
      if (sseRes && !sseRes.writableEnded) {
        sseRes.write(`data: ${JSON.stringify({ error: reason })}\n\n`);
        sseRes.end();
      }
      sseClients.delete(p.sseClientId);
    } else if (p.res && !p.res.writableEnded) {
      jsonResponse(p.res, 503, { ok: false, error: reason });
    }
  }
  pendingRequests.clear();
}

// ── REST Handlers ────────────────────────────────────────────────────

function handleStatus(_req, res) {
  jsonResponse(res, 200, {
    connected: extensionWs !== null && extensionWs.readyState === 1,
    pendingRequests: pendingRequests.size,
  });
}

function handleGetTabs(_req, res) {
  if (!extensionWs || extensionWs.readyState !== 1) {
    return jsonResponse(res, 503, { ok: false, error: 'Extension not connected' });
  }

  const id = uid();
  pendingRequests.set(id, { res, timeout: setTimeout(() => timeoutRequest(id), 5000) });
  extensionWs.send(JSON.stringify({ id, action: 'get_tabs' }));
}

function handleSend(req, res) {
  if (!extensionWs || extensionWs.readyState !== 1) {
    return jsonResponse(res, 503, { ok: false, error: 'Extension not connected' });
  }

  readBody(req).then((body) => {
    const { site, message, stream, files } = body;
    if (!site || (!message && (!files || !files.length))) {
      return jsonResponse(res, 400, { ok: false, error: 'site and (message or files) are required' });
    }

    const shouldStream = stream !== false;
    const hasFiles = Array.isArray(files) && files.length > 0;
    const timeout = hasFiles ? 180000 : 120000;
    const id = uid();

    if (shouldStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const sseId = uid();
      sseClients.set(sseId, res);
      pendingRequests.set(id, {
        sseClientId: sseId,
        streaming: true,
        fullText: '',
        timeout: setTimeout(() => timeoutRequest(id), timeout),
      });
    } else {
      pendingRequests.set(id, {
        res,
        streaming: false,
        timeout: setTimeout(() => timeoutRequest(id), timeout),
      });
    }

    const payload = { id, action: 'send', site, message: message || '', stream: shouldStream };
    if (hasFiles) payload.files = files;
    extensionWs.send(JSON.stringify(payload));

    req.on('close', () => {
      const p = pendingRequests.get(id);
      if (p?.sseClientId) sseClients.delete(p.sseClientId);
      pendingRequests.delete(id);
    });
  }).catch((err) => {
    jsonResponse(res, 400, { ok: false, error: `Invalid JSON: ${err.message}` });
  });
}

function handleOpen(req, res) {
  if (!extensionWs || extensionWs.readyState !== 1) {
    return jsonResponse(res, 503, { ok: false, error: 'Extension not connected' });
  }

  readBody(req).then((body) => {
    const { site } = body;
    if (!site) {
      return jsonResponse(res, 400, { ok: false, error: 'site is required (grok, gemini, qwen)' });
    }

    const id = uid();
    pendingRequests.set(id, { res, timeout: setTimeout(() => timeoutRequest(id), 10000) });
    extensionWs.send(JSON.stringify({ id, action: 'open_tab', site }));
  }).catch((err) => {
    jsonResponse(res, 400, { ok: false, error: `Invalid JSON: ${err.message}` });
  });
}

function timeoutRequest(id) {
  const p = pendingRequests.get(id);
  if (!p) return;
  if (p.sseClientId) {
    const sseRes = sseClients.get(p.sseClientId);
    if (sseRes && !sseRes.writableEnded) {
      sseRes.write(`data: ${JSON.stringify({ error: 'Timeout waiting for response' })}\n\n`);
      sseRes.end();
    }
    sseClients.delete(p.sseClientId);
  } else if (p.res && !p.res.writableEnded) {
    jsonResponse(p.res, 504, { ok: false, error: 'Timeout waiting for response' });
  }
  pendingRequests.delete(id);
}

// ── Utilities ────────────────────────────────────────────────────────

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req, maxSize = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error(`Body too large (max ${(maxSize / 1024 / 1024) | 0} MB)`));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serveStatic(_req, res, pathname) {
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const filePath = path.join(__dirname, 'public', pathname);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(filePath).pipe(res);
}

// ── Start ────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n  carl-superchat server running:`);
  console.log(`    REST API:  http://localhost:${PORT}/api/status`);
  console.log(`    Test GUI:  http://localhost:${PORT}/`);
  console.log(`    WebSocket: ws://localhost:${PORT}\n`);
});
