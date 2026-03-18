import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Command } from 'commander';
import { register } from '../../src/commands/init.js';

// Helper: create a fresh commander program with init registered
function makeProgram(): Command {
  const program = new Command();
  program.exitOverride(); // prevent commander from calling process.exit on errors
  register(program);
  return program;
}

// Helper: run the init command with given args
function runInit(args: string[]): void {
  const program = makeProgram();
  program.parse(['node', 'thread', 'init', ...args]);
}

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-init-cmd-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('thread init — new directory', () => {
  it('creates run/ and logs/ subdirectories', () => {
    const base = makeTmpDir();
    const target = path.join(base, 'new-thread');

    runInit([target]);

    expect(fs.existsSync(path.join(target, 'run'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'logs'))).toBe(true);
  });

  it('creates events.db', () => {
    const base = makeTmpDir();
    const target = path.join(base, 'new-thread');

    runInit([target]);

    expect(fs.existsSync(path.join(target, 'events.db'))).toBe(true);
  });

  it('creates empty events.jsonl', () => {
    const base = makeTmpDir();
    const target = path.join(base, 'new-thread');

    runInit([target]);

    const jsonlPath = path.join(target, 'events.jsonl');
    expect(fs.existsSync(jsonlPath)).toBe(true);
    expect(fs.readFileSync(jsonlPath, 'utf8')).toBe('');
  });

  it('writes success message to stdout', () => {
    const base = makeTmpDir();
    const target = path.join(base, 'new-thread');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    runInit([target]);

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Initialized thread at'));
  });

  it('does not call process.exit', () => {
    const base = makeTmpDir();
    const target = path.join(base, 'new-thread');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    expect(() => runInit([target])).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('thread init — existing non-thread directory (no events.db)', () => {
  it('succeeds and creates missing structure inside existing dir', () => {
    const target = makeTmpDir(); // already exists, no events.db

    runInit([target]);

    expect(fs.existsSync(path.join(target, 'run'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'logs'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'events.db'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'events.jsonl'))).toBe(true);
  });

  it('does not call process.exit', () => {
    const target = makeTmpDir();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    expect(() => runInit([target])).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('does not overwrite existing events.jsonl', () => {
    const target = makeTmpDir();
    const jsonlPath = path.join(target, 'events.jsonl');
    fs.writeFileSync(jsonlPath, 'existing content', 'utf8');

    runInit([target]);

    expect(fs.readFileSync(jsonlPath, 'utf8')).toBe('existing content');
  });
});

describe('thread init — already a valid thread directory (has events.db)', () => {
  it('calls process.exit(1)', () => {
    const target = makeTmpDir();
    // Pre-create events.db to mark it as a valid thread dir
    fs.writeFileSync(path.join(target, 'events.db'), '');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error(`process.exit(${_code})`);
    });

    expect(() => runInit([target])).toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes error message to stderr', () => {
    const target = makeTmpDir();
    fs.writeFileSync(path.join(target, 'events.db'), '');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    try { runInit([target]); } catch { /* expected */ }

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Error:'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('已是有效的 thread 目录'));
  });
});
