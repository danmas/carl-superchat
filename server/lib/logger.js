/**
 * Centralized logging system for carl-superchat server
 *
 * Features:
 * - File-based logging with date rotation
 * - Combined logs (all levels) and error logs (errors only)
 * - Console interception - all console output goes to files
 * - Synchronous file writes for reliability
 * - Automatic log directory creation
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/**
 * Get current date string for log file naming
 * Format: YYYY-MM-DD
 */
function getDateString() {
  const now = new Date();
  return now.toISOString().split('T')[0];
}

/**
 * Format log entry with timestamp
 */
function formatLogEntry(level, context, message, data) {
  const timestamp = new Date().toISOString();
  let entry = `${timestamp} [${level}] [${context}] ${message}`;
  
  if (data !== undefined) {
    if (data instanceof Error) {
      entry += ` ${data.stack || data.message}`;
    } else if (typeof data === 'object') {
      try {
        entry += ` ${JSON.stringify(data)}`;
      } catch (e) {
        entry += ` [Object]`;
      }
    } else {
      entry += ` ${String(data)}`;
    }
  }
  
  return entry + '\n';
}

/**
 * Write log entry to file
 */
function writeToFile(level, context, message, data) {
  const dateStr = getDateString();
  const combinedFile = path.join(LOGS_DIR, `combined-${dateStr}.log`);
  const errorFile = path.join(LOGS_DIR, `error-${dateStr}.log`);
  
  const entry = formatLogEntry(level, context, message, data);
  
  try {
    // Write to combined log (all levels)
    fs.appendFileSync(combinedFile, entry);
    
    // Also write to error log if level is ERROR
    if (level === 'ERROR') {
      fs.appendFileSync(errorFile, entry);
    }
  } catch (err) {
    // Fallback to stderr if file write fails
    process.stderr.write(`Failed to write log: ${err.message}\n`);
    process.stderr.write(entry);
  }
}

/**
 * Create a logger instance for a specific context
 */
export function createLogger(context) {
  return {
    info(message, data) {
      writeToFile('INFO', context, message, data);
      // Also output to stdout
      console._originalLog?.(`[INFO] [${context}] ${message}`, data !== undefined ? data : '');
    },
    
    warn(message, data) {
      writeToFile('WARN', context, message, data);
      // Also output to stderr
      console._originalWarn?.(`[WARN] [${context}] ${message}`, data !== undefined ? data : '');
    },
    
    error(message, data) {
      writeToFile('ERROR', context, message, data);
      // Also output to stderr
      console._originalError?.(`[ERROR] [${context}] ${message}`, data !== undefined ? data : '');
    },
    
    debug(message, data) {
      writeToFile('DEBUG', context, message, data);
      // Also output to stdout in development
      if (process.env.NODE_ENV !== 'production') {
        console._originalLog?.(`[DEBUG] [${context}] ${message}`, data !== undefined ? data : '');
      }
    }
  };
}

/**
 * Intercept console methods to write to files
 * This should be called once at server startup
 */
export function interceptConsole() {
  // Store original methods
  console._originalLog = console.log;
  console._originalWarn = console.warn;
  console._originalError = console.error;
  
  // Override console.log
  console.log = (...args) => {
    const message = args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg);
        } catch (e) {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');
    
    writeToFile('INFO', 'SERVER', message);
    console._originalLog(...args);
  };
  
  // Override console.warn
  console.warn = (...args) => {
    const message = args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg);
        } catch (e) {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');
    
    writeToFile('WARN', 'SERVER', message);
    console._originalWarn(...args);
  };
  
  // Override console.error
  console.error = (...args) => {
    const message = args.map(arg => {
      if (arg instanceof Error) {
        return arg.stack || arg.message;
      }
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg);
        } catch (e) {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');
    
    writeToFile('ERROR', 'SERVER', message);
    console._originalError(...args);
  };
}

/**
 * Write a log entry from external source (e.g., browser UI)
 */
export function writeClientLog(level, context, message, data) {
  // Validate level
  const validLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
  const upperLevel = level.toUpperCase();
  if (!validLevels.includes(upperLevel)) {
    level = 'INFO';
  } else {
    level = upperLevel;
  }
  
  // Sanitize context
  const safeContext = String(context || 'CLIENT').replace(/[\[\]]/g, '').substring(0, 50);
  
  writeToFile(level, safeContext, message, data);
}

/**
 * Get logs directory path
 */
export function getLogsDir() {
  return LOGS_DIR;
}

export default {
  createLogger,
  interceptConsole,
  writeClientLog,
  getLogsDir
};
