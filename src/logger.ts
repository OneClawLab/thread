import * as fs from 'node:fs';
import * as path from 'node:path';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  close(): Promise<void>;
}

function formatLogLine(level: LogLevel, message: string): string {
  const iso = new Date().toISOString();
  return `[${iso}] [${level}] ${message}`;
}

function formatRotationTimestamp(date: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const Y = date.getUTCFullYear();
  const M = pad(date.getUTCMonth() + 1);
  const D = pad(date.getUTCDate());
  const h = pad(date.getUTCHours());
  const m = pad(date.getUTCMinutes());
  const s = pad(date.getUTCSeconds());
  return `${Y}${M}${D}-${h}${m}${s}`;
}

function countLines(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.length === 0) return 0;
    const lines = content.split('\n');
    return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

/**
 * Creates a file-based Logger that writes to <threadDir>/logs/thread.log.
 * On initialization, checks line count; if > 10000, rotates the log file.
 */
export async function createFileLogger(threadDir: string): Promise<Logger> {
  const logsDir = path.join(threadDir, 'logs');
  const logFile = path.join(logsDir, 'thread.log');

  // Ensure logs directory exists
  fs.mkdirSync(logsDir, { recursive: true });

  // Check if rotation is needed
  const lineCount = countLines(logFile);
  if (lineCount > 10000) {
    const ts = formatRotationTimestamp(new Date());
    const rotatedFile = path.join(logsDir, `thread-${ts}.log`);
    fs.renameSync(logFile, rotatedFile);
  }

  // Open (or create) thread.log in append mode
  const stream = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf8' });

  await new Promise<void>((resolve, reject) => {
    stream.on('open', () => resolve());
    stream.on('error', reject);
  });

  function writeLine(level: LogLevel, message: string): void {
    stream.write(formatLogLine(level, message) + '\n');
  }

  return {
    info(message: string) { writeLine('INFO', message); },
    warn(message: string) { writeLine('WARN', message); },
    error(message: string) { writeLine('ERROR', message); },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        stream.end((err?: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

/**
 * Creates a stderr-based Logger. close() is a no-op.
 */
export function createStderrLogger(): Logger {
  function writeLine(level: LogLevel, message: string): void {
    process.stderr.write(formatLogLine(level, message) + '\n');
  }

  return {
    info(message: string) { writeLine('INFO', message); },
    warn(message: string) { writeLine('WARN', message); },
    error(message: string) { writeLine('ERROR', message); },
    close(): Promise<void> { return Promise.resolve(); },
  };
}
