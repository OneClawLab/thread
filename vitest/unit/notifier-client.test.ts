import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildTaskId } from '../../src/notifier-client.js';

// Helper: extract the slug part (strip 'dispatch-' prefix)
function slug(threadDir: string): string {
  const taskId = buildTaskId(threadDir);
  expect(taskId.startsWith('dispatch-')).toBe(true);
  return taskId.slice('dispatch-'.length);
}

describe('buildTaskId — format', () => {
  it('returns a string starting with "dispatch-"', () => {
    expect(buildTaskId('/home/user/mythread')).toMatch(/^dispatch-/);
  });

  it('slug contains only alphanumeric characters and hyphens', () => {
    const s = slug('/home/user/my-thread_dir');
    expect(s).toMatch(/^[a-zA-Z0-9-]+$/);
  });
});

describe('buildTaskId — short paths (≤ 40 chars after replacement)', () => {
  it('uses replacement result directly when slug ≤ 40 chars', () => {
    // '/abc' → '-abc' (4 chars, well under 40)
    const dir = '/abc';
    const expected = dir.replace(/[^a-zA-Z0-9]/g, '-');
    expect(expected.length).toBeLessThanOrEqual(40);
    expect(slug(dir)).toBe(expected);
  });

  it('replaces non-alphanumeric chars with hyphens', () => {
    const dir = '/home/user/mythread';
    const s = slug(dir);
    expect(s).toBe('-home-user-mythread');
  });

  it('short path slug length equals replacement length', () => {
    const dir = '/short';
    const s = slug(dir);
    expect(s.length).toBe(dir.replace(/[^a-zA-Z0-9]/g, '-').length);
  });
});

describe('buildTaskId — long paths (> 40 chars after replacement)', () => {
  it('slug length is exactly 39 chars (32 + 1 + 6)', () => {
    // Construct a path whose replacement is > 40 chars
    const dir = '/home/user/very-long-project-directory-name/subdir';
    const replaced = dir.replace(/[^a-zA-Z0-9]/g, '-');
    expect(replaced.length).toBeGreaterThan(40);
    const s = slug(dir);
    expect(s.length).toBe(39); // 32 + '-' + 6
  });

  it('slug length is ≤ 40 chars', () => {
    const dir = '/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t';
    const s = slug(dir);
    expect(s.length).toBeLessThanOrEqual(40);
  });

  it('slug starts with first 32 chars of replacement', () => {
    const dir = '/home/user/very-long-project-directory-name/subdir';
    const replaced = dir.replace(/[^a-zA-Z0-9]/g, '-');
    const s = slug(dir);
    expect(s.startsWith(replaced.slice(0, 32))).toBe(true);
  });

  it('slug ends with sha1 prefix of original path', () => {
    const dir = '/home/user/very-long-project-directory-name/subdir';
    const hash = createHash('sha1').update(dir).digest('hex');
    const s = slug(dir);
    expect(s.endsWith(hash.slice(0, 6))).toBe(true);
  });

  it('slug format is <32chars>-<6hexchars>', () => {
    const dir = '/home/user/very-long-project-directory-name/subdir';
    const s = slug(dir);
    expect(s).toMatch(/^[a-zA-Z0-9-]{32}-[0-9a-f]{6}$/);
  });
});

describe('buildTaskId — edge cases', () => {
  it('path of exactly 40 replacement chars is not truncated', () => {
    // Build a path whose replacement is exactly 40 chars
    // 40 alphanumeric chars → no replacement needed
    const dir = 'a'.repeat(40);
    const s = slug(dir);
    expect(s).toBe(dir);
    expect(s.length).toBe(40);
  });

  it('path of exactly 41 replacement chars triggers truncation', () => {
    const dir = 'a'.repeat(41);
    const s = slug(dir);
    expect(s.length).toBe(39);
  });

  it('all-special-char path produces only hyphens then hash', () => {
    const dir = '/' + '!'.repeat(50);
    const s = slug(dir);
    expect(s).toMatch(/^[a-zA-Z0-9-]+$/);
    expect(s.length).toBeLessThanOrEqual(40);
  });

  it('same path always produces same task id (deterministic)', () => {
    const dir = '/home/user/project';
    expect(buildTaskId(dir)).toBe(buildTaskId(dir));
  });
});
