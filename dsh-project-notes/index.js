/**
 * @local/dsh-project-notes — Host half.
 *
 * Serves the read-only HTTP API the 项目笔记 browser panel reads:
 *
 *   GET /project-notes/api/state
 *     -> { workspaces, defaultKey, route }
 *   GET /project-notes/api/notes?workspace=<key>
 *     -> { workspace, root, notes, truncated }
 *   GET /project-notes/api/note?workspace=<key>&path=<relative path>
 *     -> { path, name, text, size, truncated, mtime }
 *
 * The current workspace is the durable Workspace record the workspace
 * registry reports as most recently updated; the panel can switch to any
 * other registered Workspace. Only Markdown files inside a registered
 * Workspace directory are listed, and the resolved path is re-checked
 * against that root before any read. Nothing here mutates files.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Route prefix owned by this plugin. */
const ROUTE = '/project-notes/api';

/** File extensions treated as notes. */
const NOTE_EXTENSIONS = ['.md', '.markdown', '.mdx'];

/** Directory names never walked. */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'target',
  '__pycache__',
  'venv',
]);

/** Bounds keeping one request cheap. */
const MAX_NOTES = 800;
const MAX_DEPTH = 8;
const MAX_NOTE_BYTES = 512 * 1024;

/** Required Host service: the browser HTTP carrier. */
export const inject = ['webServer'];

/** Plugin name for diagnostics. */
export const name = 'project-notes';

/**
 * Answer one request with JSON.
 * @param res - the node response.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * The registered Workspaces, most recently updated first.
 * @param ctx - Host plugin context.
 * @returns workspace rows plus the default key; empty without a registry.
 */
function readWorkspaces(ctx) {
  const registry = ctx.get('workspaceRegistry');
  if (registry === undefined || typeof registry.list !== 'function') {
    return { workspaces: [], defaultKey: null };
  }
  const rows = [];
  for (const workspace of registry.list()) {
    const root = typeof workspace.path === 'string' ? workspace.path : undefined;
    if (root === undefined || root === '') continue;
    const title =
      typeof workspace.title === 'string' && workspace.title !== ''
        ? workspace.title
        : path.basename(root);
    const stamp =
      workspace.updatedAt ?? workspace.updated ?? workspace.createdAt ?? workspace.created ?? '';
    rows.push({ key: root, title, path: root, updatedAt: String(stamp) });
  }
  rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return { workspaces: rows, defaultKey: rows.length > 0 ? rows[0].key : null };
}

/**
 * Resolve a requested workspace key against the live registry, so only
 * registered Workspace directories are ever listed or read.
 * @param ctx - Host plugin context.
 * @param key - the requested key (a workspace directory).
 * @returns the absolute root, or undefined when the key names no registration.
 */
function resolveWorkspace(ctx, key) {
  if (typeof key !== 'string' || key === '') return undefined;
  const wanted = path.resolve(key);
  const folded = process.platform === 'win32' ? wanted.toLowerCase() : wanted;
  for (const workspace of readWorkspaces(ctx).workspaces) {
    const candidate = path.resolve(workspace.path);
    const other = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (other === folded) return candidate;
  }
  return undefined;
}

/**
 * Walk one workspace root collecting Markdown files.
 * @param root - absolute workspace root.
 * @returns relative note rows and whether a cap cut the listing.
 */
async function collectNotes(root) {
  const notes = [];
  let truncated = false;
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    for (const entry of entries) {
      if (notes.length >= MAX_NOTES) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        if (SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue;
        if (current.depth >= MAX_DEPTH) {
          truncated = true;
          continue;
        }
        queue.push({ dir: absolute, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (!NOTE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
      let stat;
      try {
        stat = await fs.stat(absolute);
      } catch {
        continue;
      }
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const slash = relative.lastIndexOf('/');
      notes.push({
        path: relative,
        name: entry.name,
        dir: slash === -1 ? '' : relative.slice(0, slash),
        size: stat.size,
        mtime: stat.mtimeMs,
      });
    }
  }
  notes.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir.localeCompare(b.dir, undefined, { sensitivity: 'base' });
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return { notes, truncated };
}

/**
 * Read one note, refusing anything that escapes the workspace root.
 * @param root - absolute workspace root.
 * @param relative - workspace-relative note path.
 * @returns the note payload, or `{ error }`.
 */
async function readNote(root, relative) {
  const target = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(prefix)) return { error: 'outside-workspace' };
  if (!NOTE_EXTENSIONS.includes(path.extname(target).toLowerCase())) return { error: 'not-a-note' };
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    return { error: 'not-found' };
  }
  if (!stat.isFile()) return { error: 'not-a-note' };
  const raw = await fs.readFile(target);
  const truncated = raw.length > MAX_NOTE_BYTES;
  const slice = truncated ? raw.subarray(0, MAX_NOTE_BYTES) : raw;
  return {
    path: relative.split(path.sep).join('/'),
    name: path.basename(target),
    text: slice.toString('utf8'),
    size: stat.size,
    truncated,
    mtime: stat.mtimeMs,
  };
}

/**
 * Build the request handler for the plugin's route prefix.
 * @param ctx - Host plugin context.
 * @returns a node:http handler owning the full response.
 */
function createHandler(ctx) {
  return async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const endpoint = url.pathname.slice(ROUTE.length).replace(/^\/+|\/+$/g, '');
      if (endpoint === '' || endpoint === 'state') {
        sendJson(res, 200, { ...readWorkspaces(ctx), route: ROUTE });
        return;
      }
      if (endpoint === 'notes') {
        const root = resolveWorkspace(ctx, url.searchParams.get('workspace') ?? '');
        if (root === undefined) {
          sendJson(res, 404, { error: 'unknown-workspace' });
          return;
        }
        sendJson(res, 200, { workspace: root, root, ...(await collectNotes(root)) });
        return;
      }
      if (endpoint === 'note') {
        const root = resolveWorkspace(ctx, url.searchParams.get('workspace') ?? '');
        if (root === undefined) {
          sendJson(res, 404, { error: 'unknown-workspace' });
          return;
        }
        const relative = url.searchParams.get('path') ?? '';
        if (relative === '') {
          sendJson(res, 400, { error: 'missing-path' });
          return;
        }
        const note = await readNote(root, relative);
        if (note.error !== undefined) {
          sendJson(res, note.error === 'not-found' ? 404 : 400, note);
          return;
        }
        sendJson(res, 200, note);
        return;
      }
      sendJson(res, 404, { error: 'unknown-endpoint' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.(new Error(`project-notes: ${message}`));
      if (!res.headersSent) sendJson(res, 500, { error: 'internal', message });
      else res.destroy();
    }
  };
}

/**
 * Mount the notes API.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: createHandler(ctx) }),
    'project-notes: notes api',
  );
}
