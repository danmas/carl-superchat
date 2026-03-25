/**
 * Terminal Agent AI Module
 * Handles prompts, response parsing, and memory management
 * NO direct AI calls — AI is handled via Extension -> Chat
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = path.join(__dirname, '..', '.carl-superchat', 'memory');

// Load prompts
const promptsPath = path.join(__dirname, 'prompts.json');
let prompts = {};
try {
  const data = await fs.readFile(promptsPath, 'utf8');
  prompts = JSON.parse(data);
} catch (e) {
  console.error('[agent] Failed to load prompts.json:', e.message);
}

export function getPrompt(key) {
  return prompts[key] || '';
}

// ─── Memory Functions ─────────────────────────────────────────────────

async function ensureMemoryDir() {
  await fs.mkdir(MEMORY_DIR, { recursive: true });
}

export async function loadMemoryIndex() {
  await ensureMemoryDir();
  const files = await fs.readdir(MEMORY_DIR).catch(() => []);
  const memoryFiles = files.filter(f => f.startsWith('MEMORY_') && f.endsWith('.md'));
  const index = [];
  for (const file of memoryFiles) {
    const fullPath = path.join(MEMORY_DIR, file);
    const content = await fs.readFile(fullPath, 'utf8').catch(() => '');
    const summary = content.split('\n')[0].substring(0, 150) || '(no summary)';
    index.push({ file, summary: summary.trim() });
  }
  return index;
}

export async function handleMemoryAction(type, filename, content = '') {
  await ensureMemoryDir();
  const fullPath = path.join(MEMORY_DIR, filename);
  
  if (type === 'STORE') {
    await fs.writeFile(fullPath, content);
    return null;
  }
  if (type === 'APPEND_MEMORY') {
    const existing = await fs.readFile(fullPath, 'utf8').catch(() => '');
    await fs.writeFile(fullPath, existing + '\n' + content);
    return null;
  }
  if (type === 'RETRIEVE') {
    return await fs.readFile(fullPath, 'utf8').catch(() => 'NOT_FOUND');
  }
  if (type === 'LIST_MEMORY') {
    return await loadMemoryIndex();
  }
  if (type === 'DELETE_MEMORY') {
    await fs.unlink(fullPath).catch(() => {});
    return null;
  }
  return null;
}

// ─── Output Cleaning ──────────────────────────────────────────────────

function stripAnsi(str) {
  if (!str) return '';
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

export function cleanOutputForAI(rawOutput, lastCommand = null) {
  if (!rawOutput) return '(no output)';

  let clean = stripAnsi(rawOutput)
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/^([a-zA-Z]:\\[^>]*>|[\w.-]+@[\w.-]+:[^$#>]*[\$#>])\s*/gm, '')
    .replace(/Microsoft Windows \[Version[^\]]*\][^\n]*\n/g, '')
    .replace(/\(c\) Microsoft Corporation[^\n]*\n/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join('\n');

  if (lastCommand && typeof lastCommand === 'string') {
    const trimmedCmd = lastCommand.trim();
    if (clean.startsWith(trimmedCmd)) {
      clean = clean.substring(trimmedCmd.length).trim();
    }
  }

  const lines = clean.split('\n');
  const uniqueLines = [];
  const seen = new Set();
  for (const line of lines) {
    if (!seen.has(line)) {
      seen.add(line);
      uniqueLines.push(line);
    }
  }
  clean = uniqueLines.join('\n').trim();
  return clean || '(no output)';
}

// ─── System Prompt Builder ────────────────────────────────────────────

export async function buildSystemPrompt(skillContent = null, skillName = null, remoteOS = 'windows') {
  const osInfo = remoteOS === 'windows'
    ? `--- Target OS: Windows ---
Use CMD/PowerShell commands. Examples:
- List files: dir | Get-ChildItem
- Read file: type file.txt | Get-Content 'file'
- Find text: findstr "pattern" file | Select-String -Pattern "pattern"
- Process list: tasklist | Get-Process`
    : remoteOS === 'darwin'
      ? `--- Target OS: macOS ---
Use POSIX/BSD commands. Examples:
- List files: ls -la
- Read file: cat file
- Find text: grep "pattern" file
- Process list: ps aux`
      : `--- Target OS: Linux ---
Use POSIX/GNU commands. Examples:
- List files: ls -la
- Read file: cat file
- Find text: grep "pattern" file
- Process list: ps aux`;

  let systemPrompt = getPrompt('TERMINAL_AGENT_SYSTEM_PROMPT');
  systemPrompt = `${osInfo}\n\n${systemPrompt}`;

  if (skillContent && skillName) {
    systemPrompt += `\n\n--- Active Skill: ${skillName} ---\n${skillContent}`;
  }

  const index = await loadMemoryIndex();
  let indexText = '\n\n--- Current Memory Index ---\n';
  for (const item of index) {
    indexText += `${item.file}\n${item.summary}\n\n`;
  }
  systemPrompt += indexText;

  return systemPrompt;
}

export function buildInitialUserPrompt(taskName, params = {}, userPrompt = '', step = 1, maxSteps = 100) {
  let prompt = userPrompt || `Execute task: ${taskName}`;

  if (Object.keys(params).length > 0) {
    prompt += `\n\nParameters:\n${Object.entries(params).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;
  }

  prompt += `\n\n[Step ${step} of ${maxSteps}]`;
  return prompt;
}

// ─── Response Parser ──────────────────────────────────────────────────

export function parseAgentResponse(aiContent) {
  const content = aiContent.trim();

  const cmdMatch = content.match(/^\[CMD\]\s*(.+)$/im);
  const askOptionalMatch = content.match(/^\[ASK:optional\]\s*(.+)$/ims);
  const askMatch = content.match(/^\[ASK\]\s*(.+)$/ims);
  const msgMatch = content.match(/^\[MESSAGE\]\s*(.+)$/ims);
  const doneMatch = content.match(/^\[DONE\]\s*(.*)$/ims);

  if (cmdMatch) {
    let command = cmdMatch[1].trim();
    command = command.replace(/^```[a-z]*\s*|\s*```$/g, '').trim();
    return { type: 'CMD', content, command };
  }
  if (askOptionalMatch) {
    return { type: 'ASK', content, question: askOptionalMatch[1].trim(), required: false };
  }
  if (askMatch) {
    return { type: 'ASK', content, question: askMatch[1].trim(), required: true };
  }
  if (msgMatch) {
    return { type: 'MESSAGE', content, message: msgMatch[1].trim() };
  }
  if (doneMatch) {
    return { type: 'DONE', content, message: doneMatch[1].trim() || 'Task completed' };
  }

  // Memory tags
  const storeMatch = content.match(/^\[STORE\]\s*MEMORY_(.+?)\.md\s*([\s\S]*)$/ims);
  const retrieveMatch = content.match(/^\[RETRIEVE\]\s*MEMORY_(.+?)\.md$/ims);
  const listMatch = content.match(/^\[LIST_MEMORY\]$/im);
  const appendMatch = content.match(/^\[APPEND_MEMORY\]\s*MEMORY_(.+?)\.md\s*([\s\S]*)$/ims);
  const deleteMatch = content.match(/^\[DELETE_MEMORY\]\s*MEMORY_(.+?)\.md$/ims);

  if (storeMatch) {
    return { type: 'STORE', filename: `MEMORY_${storeMatch[1]}.md`, content: storeMatch[2].trim() };
  }
  if (retrieveMatch) {
    return { type: 'RETRIEVE', filename: `MEMORY_${retrieveMatch[1]}.md` };
  }
  if (listMatch) {
    return { type: 'LIST_MEMORY' };
  }
  if (appendMatch) {
    return { type: 'APPEND_MEMORY', filename: `MEMORY_${appendMatch[1]}.md`, content: appendMatch[2].trim() };
  }
  if (deleteMatch) {
    return { type: 'DELETE_MEMORY', filename: `MEMORY_${deleteMatch[1]}.md` };
  }

  // GET-FILE
  const getFileMatch = content.match(/^\[GET-FILE\]\s*(.+?)$/ims);
  if (getFileMatch) {
    return { type: 'GET-FILE', path: getFileMatch[1].trim() };
  }

  // Fallback: treat first line as command
  console.warn('[agent] Unknown response format, treating as command');
  let command = content.split('\n')[0].trim();
  command = command.replace(/^```[a-z]*\s*|\s*```$/g, '').trim();
  if (command) {
    return { type: 'CMD', content: `[CMD] ${command}`, command };
  }

  return { type: 'UNKNOWN', content, error: 'Empty or invalid AI response' };
}

// ─── File Handler ─────────────────────────────────────────────────────

const ALLOWED_EXTENSIONS = [
  '.md', '.txt', '.js', '.ts', '.jsx', '.tsx', '.json', '.yaml', '.yml',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.xml', '.svg',
  '.py', '.rb', '.php', '.java', '.c', '.cpp', '.h', '.hpp', '.cs',
  '.go', '.rs', '.swift', '.kt', '.scala', '.sh', '.bash', '.zsh',
  '.ps1', '.bat', '.cmd', '.sql', '.graphql', '.prisma', '.mts', '.cts'
];

const ALLOWED_FILENAMES = [
  '.env', '.env.example', '.env.local', '.env.development', '.env.production',
  '.gitignore', '.dockerignore', '.editorconfig', '.eslintrc', '.prettierrc',
  '.eslintrc.json', '.prettierrc.json', '.babelrc', '.nvmrc', '.npmrc',
  'dockerfile', 'makefile', 'readme', 'license', 'changelog', 'contributing',
  '.gitattributes', '.gitmodules'
];

export async function handleGetFile(filePath, projectRoot = null) {
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  const basenameNoExt = path.basename(filePath, ext).toLowerCase();

  const isAllowed = ALLOWED_EXTENSIONS.includes(ext) ||
    ALLOWED_FILENAMES.includes(basename) ||
    ALLOWED_FILENAMES.includes(basenameNoExt);

  if (!isAllowed) {
    return `File error:\nOnly text files are allowed. Extension '${ext || 'none'}' not in whitelist.`;
  }

  const root = projectRoot || path.resolve(__dirname, '..');
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);

  try {
    const content = await fs.readFile(fullPath, 'utf8');
    return `File content:\n${content}`;
  } catch (e) {
    return `File error:\n${e.code === 'ENOENT' ? 'File not found' : e.message}`;
  }
}
