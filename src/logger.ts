import * as fs from 'fs';
import { config } from './config.js';

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

export class Logger {
  private context: string;
  private static logStream: fs.WriteStream | null = null;
  private static logStreamInitialized = false;

  constructor(context: string) {
    this.context = context;
    Logger.initLogStream();
  }

  private static initLogStream() {
    if (Logger.logStreamInitialized) return;
    Logger.logStreamInitialized = true;

    if (config.logFile) {
      try {
        Logger.logStream = fs.createWriteStream(config.logFile, { flags: 'a' });
        Logger.logStream.on('error', (err) => {
          console.error(`[Logger] Failed to write to log file: ${err.message}`);
        });
      } catch (err) {
        console.error(`[Logger] Failed to open log file ${config.logFile}: ${err}`);
      }
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[config.logLevel];
  }

  private formatMessage(level: string, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level}] [${this.context}]`;

    if (data !== undefined) {
      const serialized = this.safeStringify(data);
      return `${prefix} ${message}\n${serialized}`;
    }
    return `${prefix} ${message}`;
  }

  private safeStringify(data: any, maxDepth: number = 4): string {
    try {
      const seen = new WeakSet();
      return JSON.stringify(data, (key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        // Truncate very long strings in debug output
        if (typeof value === 'string' && value.length > 2000) {
          return value.substring(0, 2000) + `... [truncated, total ${value.length} chars]`;
        }
        // Truncate Buffer-like objects
        if (value?.type === 'Buffer' && Array.isArray(value.data)) {
          return `[Buffer: ${value.data.length} bytes]`;
        }
        return value;
      }, 2);
    } catch {
      return String(data);
    }
  }

  private writeLog(formatted: string, consoleFn: (...args: any[]) => void) {
    consoleFn(formatted);
    if (Logger.logStream) {
      Logger.logStream.write(formatted + '\n');
    }
  }

  trace(message: string, data?: any) {
    if (!this.shouldLog('trace')) return;
    this.writeLog(this.formatMessage('TRACE', message, data), console.log);
  }

  debug(message: string, data?: any) {
    if (!this.shouldLog('debug')) return;
    this.writeLog(this.formatMessage('DEBUG', message, data), console.log);
  }

  info(message: string, data?: any) {
    if (!this.shouldLog('info')) return;
    this.writeLog(this.formatMessage('INFO', message, data), console.log);
  }

  warn(message: string, data?: any) {
    if (!this.shouldLog('warn')) return;
    this.writeLog(this.formatMessage('WARN', message, data), console.warn);
  }

  error(message: string, error?: any) {
    if (!this.shouldLog('error')) return;
    const errorData = error instanceof Error ? {
      errorMessage: error.message,
      stack: error.stack,
      name: error.name,
      ...(error as any),
    } : error;
    this.writeLog(this.formatMessage('ERROR', message, errorData), console.error);
  }

  /** Create a child logger with additional context prefix */
  child(subContext: string): Logger {
    return new Logger(`${this.context}:${subContext}`);
  }
}
