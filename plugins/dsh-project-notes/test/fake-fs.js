/**
 * A `ctx.fs` test double backed by the real filesystem.
 *
 * It mirrors the contract the shipped `dsh-fs-local` backend publishes:
 * `resolve()` returns a realpath-derived `targetKey`, `contains()` compares
 * those keys, `lstat()` reports `symlink` as its own type, and
 * `readByteRange()` returns exactly the requested window (shorter at EOF).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Resolve one path the way the local backend does.
 * @param value - the path to resolve.
 * @param cwd - resolution base.
 * @returns the target with its canonical key.
 */
async function targetOf(value, cwd) {
  const full = path.resolve(cwd, value);
  let key;
  try {
    key = await fs.realpath(full);
  } catch {
    key = full;
  }
  return { targetKey: key, displayPath: full };
}

/**
 * Classify one stat result into the service's type vocabulary.
 * @param stat - a node stat result.
 * @returns the service type.
 */
function typeOf(stat) {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  return 'other';
}

/** The test double. */
export const fakeFs = {
  async resolve(value, opts) {
    return targetOf(value, opts?.cwd ?? process.cwd());
  },
  contains(parent, child) {
    const relative = path.relative(parent.targetKey, child.targetKey);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  },
  async lstat(value, opts) {
    const full = path.resolve(opts?.cwd ?? process.cwd(), value);
    const stat = await fs.lstat(full);
    return { version: String(stat.mtimeMs), type: typeOf(stat), size: stat.size };
  },
  async stat(target) {
    const stat = await fs.stat(target.targetKey);
    return { version: String(stat.mtimeMs), type: typeOf(stat), size: stat.size };
  },
  async readByteRange(target, range) {
    const length = Math.max(0, Math.trunc(range?.length ?? 0));
    const handle = await fs.open(target.targetKey, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, Math.trunc(range?.offset ?? 0)));
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  },
};

/**
 * A fake Host plugin context.
 * @param services - the services `ctx.get` should answer with.
 * @returns the context.
 */
export function fakeContext(services) {
  return {
    get: (key) => services[key],
    logger: { warn: () => {} },
  };
}
