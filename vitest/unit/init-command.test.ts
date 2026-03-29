import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as nodeFs from 'node:fs';
import * as os from 'node:os';
import { Command } from 'commander';
import { register } from '../../src/commands/init.js';
import { path } from '../../src/repo-utils/path.js';
import * as fs from '../../src/repo-utils/fs.js';

// Helper: create a fresh commander program with init registered
function makeProgram(): Command {
  const program = new Command();
  program.exitOverride(); // prevent commander from calling process.exit on errors
  register(program);
  return program;
}

// Helper: run the init command with given args (async, supports async action handlers)
async function runInit(args: string[]): Promise<void> {
  const program = makeProgram();
  await program.parseAsync(['node', 'thread', 'init', ...args]);
}

const tmpDirs: string[] = [];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(path.toPosixPath(os.tmpdir()), 'thread-init-cmd-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    nodeFs.rmSync(path.toNative(dir), { recursive: true, force: true });
  }
});

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

describe('thread init — new directory', () => {
  it('creates run/ and logs/ subdirectories', async () => {
    const base = makeTmpDir();
    const target = path.join(base, 'new-thread');

    await runInit([target]);

    expect(fs.existsSync(path.join(target, 'run'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'logs'))).toBe(true);
  });

  it('creates events.db', async () => {
    const base = makeTmpDir();
    const target = path.join(base, 'new-thread');

    await runInit([target]);

    expect(fs.existsSync(path.join(target, 'events.db'))).toBe(true);
  });

  it('creates empty events.jsonl', async () => {
    const base = makeTmpDir();
    const target = path.join(base, 'new-thread');

    await runInit([target]);

    const jsonlPath = path.join(target, 'events.jsonl');
    expect(fs.existsSync(jsonlPath)).toBe(true);
    expect(fs.readFileSync(jsonlPath, 'utf8')).toBe('');
  });

  it('writes success message to stdout', async () => {
    const base = makeTmpDir();
    const target = path.join(base, 'new-thread');

    await runInit([target]);

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Initialized thread at'));
  });

  it('does not call process.exit', async () => {
    const base = makeTmpDir();
    const target = path.join(base, 'new-thread');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInit([target])).resolves.not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('thread init — existing non-thread directory (no events.db)', () => {
  it('succeeds and creates missing structure inside existing dir', async () => {
    const target = makeTmpDir(); // already exists, no events.db

    await runInit([target]);

    expect(fs.existsSync(path.join(target, 'run'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'logs'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'events.db'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'events.jsonl'))).toBe(true);
  });

  it('does not call process.exit', async () => {
    const target = makeTmpDir();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInit([target])).resolves.not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('does not overwrite existing events.jsonl', async () => {
    const target = makeTmpDir();
    const jsonlPath = path.join(target, 'events.jsonl');
    fs.writeFileSync(jsonlPath, 'existing content', 'utf8');

    await runInit([target]);

    expect(fs.readFileSync(jsonlPath, 'utf8')).toBe('existing content');
  });
});

describe('thread init — already a valid thread directory (has events.db)', () => {
  it('calls process.exit(1)', async () => {
    const target = makeTmpDir();
    // Pre-create events.db to mark it as a valid thread dir
    fs.writeFileSync(path.join(target, 'events.db'), '');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null) => {
      throw new Error(`process.exit(${_code})`);
    });

    await expect(runInit([target])).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes error message to stderr', async () => {
    const target = makeTmpDir();
    fs.writeFileSync(path.join(target, 'events.db'), '');

    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInit([target])).rejects.toThrow();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Error:'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('已是有效的 thread 目录'));
  });
});
