/**
 * Terminal Agent REST API Module
 * Lightweight session storage + memory operations
 * AI calls happen via Extension -> Chat, not here
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

import {
  buildSystemPrompt,
  buildInitialUserPrompt,
  parseAgentResponse,
  cleanOutputForAI,
  handleMemoryAction,
  loadMemoryIndex,
  handleGetFile
} from './terminal-agent-ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── In-Memory Storage ────────────────────────────────────────────────

const agentSessions = {};
// sessionId -> { systemPrompt, messages, step, maxSteps, state, mode, historyMode, historyMax, ... }

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

// ─── Helpers ──────────────────────────────────────────────────────────

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
  return true;
}

function readBody(req, maxSize = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error('Body too large'));
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

// ─── SKILL Loading ────────────────────────────────────────────────────

function parseSkillFrontmatter(content, fallbackName = 'unknown') {
  const match = content.match(/^(?:\s*---\s*\r?\n)?([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
  if (!match) {
    return { name: fallbackName, description: '', params: [], historyMode: 'full', content: content.trim() };
  }

  const frontmatter = match[1];
  const body = match[2].trim();
  const result = { name: fallbackName, description: '', params: [], historyMode: 'full', content: body };

  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  if (nameMatch) result.name = nameMatch[1].trim();

  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  if (descMatch) result.description = descMatch[1].trim();

  const historyMatch = frontmatter.match(/^history_mode:\s*(\S+)/m);
  if (historyMatch) {
    const mode = historyMatch[1].trim().toLowerCase();
    if (['full', 'last_n', 'system_only'].includes(mode)) {
      result.historyMode = mode;
    }
  }

  const historyMaxMatch = frontmatter.match(/^history_max:\s*(\d+)/m);
  if (historyMaxMatch) {
    result.historyMax = parseInt(historyMaxMatch[1], 10);
  }

  return result;
}

async function getProjectSkill(skillPath) {
  const skillsRoot = path.join(__dirname, '..', '.carl-superchat', 'skills');
  const relPath = (skillPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const filePath = path.join(skillsRoot, ...relPath.split('/'), 'SKILL.md');

  try {
    const content = await fs.readFile(filePath, 'utf8');
    const fallbackName = relPath.split('/').filter(Boolean).pop() || 'unknown';
    return parseSkillFrontmatter(content, fallbackName);
  } catch (e) {
    return null;
  }
}

// ─── Detect OS ────────────────────────────────────────────────────────

function detectOS() {
  const platform = process.platform;
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'darwin';
  return 'linux';
}

// ─── Route Handler ────────────────────────────────────────────────────

export async function handleAgentRoute(req, res, pathname) {

  // POST /api/agent/start
  if (pathname === '/api/agent/start' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { mode = 'standalone', prompt = '', skillPath, params = {} } = body;

      const remoteOS = detectOS();
      let systemPrompt;
      let taskName = 'Terminal Agent';
      let historyMode = 'full';
      let historyMax = 10;

      if (mode === 'skill' && skillPath) {
        const skill = await getProjectSkill(skillPath);
        if (!skill) {
          return jsonResponse(res, 404, { success: false, error: `Skill "${skillPath}" not found` });
        }
        taskName = skill.name || skillPath;
        historyMode = skill.historyMode || 'full';
        historyMax = skill.historyMax || 10;
        systemPrompt = await buildSystemPrompt(skill.content, taskName, remoteOS);
      } else {
        systemPrompt = await buildSystemPrompt(null, null, remoteOS);
      }

      const userPrompt = buildInitialUserPrompt(taskName, params, prompt, 1, 100);

      const sessionId = uid();
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ];

      const session = {
        systemPrompt,
        messages,
        step: 1,
        maxSteps: 100,
        state: 'idle',
        mode,
        historyMode,
        historyMax,
        pendingCommand: null,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString()
      };

      agentSessions[sessionId] = session;
      console.log('[agent] Session started:', sessionId, mode);

      // Return session info — client will send messages to AI via Extension
      return jsonResponse(res, 200, {
        success: true,
        data: {
          sessionId,
          mode,
          step: session.step,
          systemPrompt,
          userPrompt,
          messages
        }
      });
    } catch (e) {
      console.error('[agent] Error starting:', e.message);
      return jsonResponse(res, 500, { success: false, error: e.message });
    }
  }

  // POST /api/agent/:sessionId/ai-response
  // Client sends AI response here for parsing and state update
  const aiResponseMatch = pathname.match(/^\/api\/agent\/([^/]+)\/ai-response$/);
  if (aiResponseMatch && req.method === 'POST') {
    const sessionId = aiResponseMatch[1];
    const session = agentSessions[sessionId];
    console.log('[agent] ai-response for session:', sessionId, 'exists:', !!session);

    if (!session) {
      return jsonResponse(res, 404, { success: false, error: 'Session not found' });
    }

    try {
      const body = await readBody(req);
      const { aiContent } = body;
      console.log('[agent] AI content preview:', aiContent?.substring(0, 100));

      // Parse AI response
      const parsed = parseAgentResponse(aiContent);
      console.log('[agent] Parsed directive:', parsed.type);

      // Handle memory/GET-FILE instantly on server
      if (['STORE', 'RETRIEVE', 'LIST_MEMORY', 'APPEND_MEMORY', 'DELETE_MEMORY', 'GET-FILE', 'GET-FILES'].includes(parsed.type)) {
        let result;

        if (parsed.type === 'GET-FILE') {
          result = await handleGetFile(parsed.path);
        } else if (parsed.type === 'GET-FILES') {
          // Handle multiple GET-FILE directives
          const results = await Promise.all(
            parsed.paths.map(async (filePath) => {
              const content = await handleGetFile(filePath);
              return `--- ${filePath} ---\n${content}`;
            })
          );
          result = results.join('\n\n');
        } else {
          result = await handleMemoryAction(parsed.type, parsed.filename, parsed.content);
          if (parsed.type === 'LIST_MEMORY' && result) {
            result = result.map(m => `${m.file}: ${m.summary}`).join('\n') || '(no memories)';
          } else if (parsed.type === 'RETRIEVE' && result) {
            result = `Memory content:\n${result}`;
          } else {
            result = 'OK';
          }
        }

        // Return result so client can send it back to AI
        return jsonResponse(res, 200, {
          success: true,
          data: {
            type: parsed.type,
            handled: true,
            result,
            step: session.step
          }
        });
      }

      // Update state based on directive type
      if (parsed.type === 'CMD') {
        session.state = 'waiting_cmd';
        session.pendingCommand = parsed.command;
      } else if (parsed.type === 'ASK') {
        session.state = 'waiting_user';
      } else if (parsed.type === 'MESSAGE') {
        session.state = 'idle';
      } else if (parsed.type === 'DONE') {
        session.state = 'done';
      }

      // Add to message history
      session.messages.push({ role: 'assistant', content: parsed.content || aiContent });
      session.lastActivity = new Date().toISOString();

      return jsonResponse(res, 200, {
        success: true,
        data: {
          type: parsed.type,
          handled: false,
          parsed: {
            type: parsed.type,
            content: parsed.type === 'ASK' ? parsed.question :
              parsed.type === 'MESSAGE' ? parsed.message :
                parsed.type === 'DONE' ? parsed.message :
                  parsed.content,
            command: parsed.command || null,
            question: parsed.question || null,
            required: parsed.required !== undefined ? parsed.required : null
          },
          step: session.step,
          state: session.state
        }
      });
    } catch (e) {
      console.error('[agent] Error processing AI response:', e.message);
      return jsonResponse(res, 500, { success: false, error: e.message });
    }
  }

  // POST /api/agent/:sessionId/command-result
  const cmdResultMatch = pathname.match(/^\/api\/agent\/([^/]+)\/command-result$/);
  if (cmdResultMatch && req.method === 'POST') {
    const sessionId = cmdResultMatch[1];
    const session = agentSessions[sessionId];
    console.log('[agent] command-result for session:', sessionId, 'exists:', !!session);

    if (!session) {
      return jsonResponse(res, 404, { success: false, error: 'Session not found' });
    }

    try {
      const body = await readBody(req);
      const { stdout, stderr, exitCode, skipped = false } = body;
      console.log('[agent] Command result - skipped:', skipped, 'exitCode:', exitCode, 'stdout length:', stdout?.length);

      session.step++;
      if (session.step > session.maxSteps) {
        session.state = 'done';
        session.pendingCommand = null;
        return jsonResponse(res, 200, {
          success: true,
          data: { 
            step: session.step,
            userContent: 'Maximum steps reached',
            done: true
          }
        });
      }

      let userContent;
      if (skipped) {
        userContent = `User skipped the command.\n\n[Step ${session.step} of ${session.maxSteps}]`;
      } else {
        const cleanedOutput = cleanOutputForAI(stdout || '', session.pendingCommand);
        userContent = `Command output:\n${cleanedOutput}\n\n[Step ${session.step} of ${session.maxSteps}]`;
      }

      session.messages.push({ role: 'user', content: userContent });
      session.pendingCommand = null;
      session.lastActivity = new Date().toISOString();

      // Return userContent for client to send to AI
      return jsonResponse(res, 200, {
        success: true,
        data: { step: session.step, userContent, state: session.state }
      });
    } catch (e) {
      console.error('[agent] Error command-result:', e.message);
      return jsonResponse(res, 500, { success: false, error: e.message });
    }
  }

  // POST /api/agent/:sessionId/execute
  const executeMatch = pathname.match(/^\/api\/agent\/([^/]+)\/execute$/);
  if (executeMatch && req.method === 'POST') {
    const sessionId = executeMatch[1];
    const session = agentSessions[sessionId];

    if (!session) {
      return jsonResponse(res, 404, { success: false, error: 'Session not found' });
    }

    try {
      const body = await readBody(req);
      const { command } = body;
      const cmdToRun = command || session.pendingCommand;

      if (!cmdToRun) {
        return jsonResponse(res, 400, { success: false, error: 'No command to execute' });
      }

      console.log(`[agent] Executing: ${cmdToRun}`);

      try {
        // Execute with 30s timeout
        const { stdout, stderr } = await execAsync(cmdToRun, {
          timeout: 30000,
          maxBuffer: 10 * 1024 * 1024, // 10MB
          cwd: path.resolve(__dirname, '..')
        });

        // Truncate output if too large (max 5KB for AI context)
        const MAX_OUTPUT = 5 * 1024;
        const truncatedStdout = stdout.length > MAX_OUTPUT 
          ? stdout.substring(0, MAX_OUTPUT) + `\n\n[OUTPUT TRUNCATED: ${Math.round(stdout.length / 1024)}KB total, showing first 5KB]`
          : stdout;
        const truncatedStderr = stderr.length > MAX_OUTPUT
          ? stderr.substring(0, MAX_OUTPUT) + `\n\n[OUTPUT TRUNCATED]`
          : stderr;

        console.log('[agent] Command output length:', stdout.length, 'truncated to:', truncatedStdout.length);

        return jsonResponse(res, 200, {
          success: true,
          data: { stdout: truncatedStdout, stderr: truncatedStderr, exitCode: 0 }
        });
      } catch (execErr) {
        const errStdout = execErr.stdout || '';
        const errStderr = execErr.stderr || execErr.message;
        const MAX_OUTPUT = 5 * 1024;
        
        return jsonResponse(res, 200, {
          success: true, // Still success in terms of API, but command returned error
          data: {
            stdout: errStdout.length > MAX_OUTPUT ? errStdout.substring(0, MAX_OUTPUT) + '\n[TRUNCATED]' : errStdout,
            stderr: errStderr.length > MAX_OUTPUT ? errStderr.substring(0, MAX_OUTPUT) + '\n[TRUNCATED]' : errStderr,
            exitCode: execErr.code || 1
          }
        });
      }
    } catch (e) {
      console.error('[agent] Error executing command:', e.message);
      return jsonResponse(res, 500, { success: false, error: e.message });
    }
  }

  // POST /api/agent/:sessionId/message
  const messageMatch = pathname.match(/^\/api\/agent\/([^/]+)\/message$/);
  if (messageMatch && req.method === 'POST') {
    const sessionId = messageMatch[1];
    const session = agentSessions[sessionId];

    if (!session) {
      return jsonResponse(res, 404, { success: false, error: 'Session not found' });
    }

    try {
      const body = await readBody(req);
      const { userMessage } = body;

      session.step++;
      if (session.step > session.maxSteps) {
        session.state = 'done';
        return jsonResponse(res, 200, {
          success: true,
          data: { 
            step: session.step,
            userContent: 'Maximum steps reached',
            done: true
          }
        });
      }

      const userContent = `User response: ${userMessage}\n\n[Step ${session.step} of ${session.maxSteps}]`;
      session.messages.push({ role: 'user', content: userContent });
      session.lastActivity = new Date().toISOString();

      return jsonResponse(res, 200, {
        success: true,
        data: { step: session.step, userContent, state: session.state }
      });
    } catch (e) {
      console.error('[agent] Error message:', e.message);
      return jsonResponse(res, 500, { success: false, error: e.message });
    }
  }

  // POST /api/agent/:sessionId/continue
  const continueMatch = pathname.match(/^\/api\/agent\/([^/]+)\/continue$/);
  if (continueMatch && req.method === 'POST') {
    const sessionId = continueMatch[1];
    const session = agentSessions[sessionId];

    if (!session) {
      return jsonResponse(res, 404, { success: false, error: 'Session not found' });
    }

    try {
      session.step++;
      if (session.step > session.maxSteps) {
        session.state = 'done';
        return jsonResponse(res, 200, {
          success: true,
          data: { 
            step: session.step,
            userContent: 'Maximum steps reached',
            done: true
          }
        });
      }

      const userContent = `[Continue after informational message]\n\n[Step ${session.step} of ${session.maxSteps}]`;
      session.messages.push({ role: 'user', content: userContent });
      session.lastActivity = new Date().toISOString();

      return jsonResponse(res, 200, {
        success: true,
        data: { step: session.step, userContent, state: session.state }
      });
    } catch (e) {
      console.error('[agent] Error continue:', e.message);
      return jsonResponse(res, 500, { success: false, error: e.message });
    }
  }

  // GET /api/agent/:sessionId
  const infoMatch = pathname.match(/^\/api\/agent\/([^/]+)$/);
  if (infoMatch && req.method === 'GET') {
    const sessionId = infoMatch[1];
    const session = agentSessions[sessionId];

    if (!session) {
      return jsonResponse(res, 404, { success: false, error: 'Session not found' });
    }

    return jsonResponse(res, 200, {
      success: true,
      data: {
        sessionId,
        mode: session.mode,
        state: session.state,
        step: session.step,
        maxSteps: session.maxSteps,
        pendingCommand: session.pendingCommand,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity
      }
    });
  }

  // DELETE /api/agent/:sessionId
  if (infoMatch && req.method === 'DELETE') {
    const sessionId = infoMatch[1];
    const session = agentSessions[sessionId];

    if (!session) {
      return jsonResponse(res, 404, { success: false, error: 'Session not found' });
    }

    delete agentSessions[sessionId];
    console.log('[agent] Session deleted:', sessionId);

    return jsonResponse(res, 200, { success: true, data: { message: 'Session deleted' } });
  }

  return false;
}

// ─── Cleanup ──────────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [sessionId, session] of Object.entries(agentSessions)) {
    const lastActivity = new Date(session.lastActivity).getTime();
    if (now - lastActivity > maxAge) {
      delete agentSessions[sessionId];
      console.log('[agent] Cleaned up stale session:', sessionId);
    }
  }
}, 5 * 60 * 1000);
