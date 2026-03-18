import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createFileLogger } from '../../src/logger.js';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-logger-test-'));
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('createFileLogger — file location', () => {
  it('writes to <threadDir>/logs/thread.log', async () => {
    const dir = makeTmpDir();
    const logger = await createFileLogger(dir);
    logger.info('hello');
    await logger.close();
    expect(fs.existsSync(path.join(dir, 'logs', 'thread.log'))).toBe(true);
  });

  it('creates logs directory if it does not exist', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-logger-nodir-'));
    tmpDirs.push(dir);
    // No logs/ subdir created
    const logger = await createFileLogger(dir);
    logger.info('test');
    await logger.close();
    expect(fs.existsSync(path.join(dir, 'logs', 'thread.log'))).toBe(true);
  });
});

describe('createFileLogger — log format', () => {
  it('writes INFO lines in [ISO8601] [INFO] message format', async () => {
    const dir = makeTmpDir();
    const logger = await createFileLogger(dir);
    logger.info('test message');
    await logger.close();
    const content = fs.readFileSync(path.join(dir, 'logs', 'thread.log'), 'utf8');
    expect(content).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\] \[INFO\] test message\n/);
  });

  it('writes WARN lines in [ISO8601] [WARN] message format', async () => {
    const dir = makeTmpDir();
    const logger = await createFileLogger(dir);
    logger.warn('warn msg');
    await logger.close();
    const content = fs.readFileSync(path.join(dir, 'logs', 'thread.log'), 'utf8');
    expect(content).toMatch(/\[WARN\] warn msg/);
  });

  it('writes ERROR lines in [ISO8601] [ERROR] message format', async () => {
    const dir = makeTmpDir();
    const logger = await createFileLogger(dir);
    logger.error('err msg');
    await logger.close();
    const content = fs.readFileSync(path.join(dir, 'logs', 'thread.log'), 'utf8');
    expect(content).toMatch(/\[ERROR\] err msg/);
  });

  it('each log call appends a newline-terminated line', async () => {
    const dir = makeTmpDir();
    const logger = await createFileLogger(dir);
    logger.info('line1');
    logger.info('line2');
    await logger.close();
    const lines = fs.readFileSync(path.join(dir, 'logs', 'thread.log'), 'utf8').split('\n');
    // Last element is empty string after trailing newline
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[lines.length - 1]).toBe('');
  });
});

describe('createFileLogger — rotation', () => {
  it('does not rotate when log has ≤ 10000 lines', async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'logs', 'thread.log'), 'x\n'.repeat(10000), 'utf8');
    const logger = await createFileLogger(dir);
    await logger.close();
    const rotated = fs.readdirSync(path.join(dir, 'logs')).filter(f => f.startsWith('thread-') && f.endsWith('.log'));
    expect(rotated).toHaveLength(0);
  });

  it('rotates when log exceeds 10000 lines on init', async () => {
    const dir = makeTmpDir();
    const logFile = path.join(dir, 'logs', 'thread.log');
    fs.writeFileSync(logFile, 'x\n'.repeat(10001), 'utf8');
    const logger = await createFileLogger(dir);
    logger.info('new entry');
    await logger.close();
    // Rotated file exists
    const rotated = fs.readdirSync(path.join(dir, 'logs')).filter(f => f.startsWith('thread-') && f.endsWith('.log'));
    expect(rotated).toHaveLength(1);
    expect(rotated[0]).toMatch(/^thread-\d{8}-\d{6}\.log$/);
  });

  it('new log file starts fresh after rotation', async () => {
    const dir = makeTmpDir();
    const logFile = path.join(dir, 'logs', 'thread.log');
    fs.writeFileSync(logFile, 'x\n'.repeat(10001), 'utf8');
    const logger = await createFileLogger(dir);
    logger.info('fresh start');
    await logger.close();
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\[INFO\] fresh start/);
  });

  it('rotated file retains original content', async () => {
    const dir = makeTmpDir();
    const logFile = path.join(dir, 'logs', 'thread.log');
    const original = 'x\n'.repeat(10001);
    fs.writeFileSync(logFile, original, 'utf8');
    const logger = await createFileLogger(dir);
    await logger.close();
    const rotated = fs.readdirSync(path.join(dir, 'logs')).find(f => f.startsWith('thread-') && f.endsWith('.log'))!;
    const rotatedContent = fs.readFileSync(path.join(dir, 'logs', rotated), 'utf8');
    expect(rotatedContent).toBe(original);
  });
});
