import { execFileSync } from 'node:child_process';
import path from 'node:path';

const cache = new Map<string, Date | undefined>();
let shallow: boolean | undefined;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Last commit date for a file, or undefined when it can't be known. A shallow clone gives every
 * file the same date, so that case also returns undefined rather than a misleading value.
 */
export function getLastModified(file: string): Date | undefined {
  const absolute = path.resolve(file);
  if (cache.has(absolute)) return cache.get(absolute);

  let result: Date | undefined;
  try {
    const cwd = path.dirname(absolute);
    shallow ??= git(['rev-parse', '--is-shallow-repository'], cwd) === 'true';
    if (!shallow) {
      const iso = git(['log', '-1', '--format=%cI', '--', absolute], cwd);
      const date = new Date(iso);
      if (iso && !Number.isNaN(date.getTime())) result = date;
    }
  } catch {
    result = undefined;
  }

  cache.set(absolute, result);
  return result;
}
