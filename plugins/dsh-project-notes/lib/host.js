/**
 * @local/dsh-project-notes — Host logic.
 *
 * Everything the plugin's API needs, kept out of the entry point so it can be
 * unit-tested without a running Harness:
 *
 *   * `normalizeConfig`    — validate the optional plugin config;
 *   * `readWorkspaces`     — project the durable workspace registry;
 *   * `resolveWorkspace`   — accept a workspace id or path, never anything else;
 *   * `collectNotes`       — walk one workspace for Markdown files;
 *   * `readNote`           — read one note through the Host `fs` service;
 *   * `answerRequest`      — the three endpoints, carrier-independent;
 *   * `createFetchRoutes`  — those endpoints as exact `/api` Fetch routes.
 *
 * Security posture (mirrors the shipped `workspaceFiles` service):
 *   * the routes live on the shared `/api` channel, so the connection fence
 *     (Host/Origin plus browser authentication) admits every request before any
 *     handler runs — the plugin holds no admission logic of its own;
 *   * containment is `ctx.fs.resolve()` + `ctx.fs.contains()`, which compare
 *     realpath-derived target keys and so defeat `..` and symlinks alike;
 *   * a final symlink is refused outright, as the platform's own file reads do;
 *   * content is read as one bounded byte window, never the whole file.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * The endpoints on the shared authenticated `/api` channel. The connection
 * fence admits every request before dispatch, which is why this plugin carries
 * no admission logic.
 */
export const API_ROUTE = '/api/project-notes';

/** Built-in bounds, each overridable through the plugin's optional config. */
export const DEFAULT_CONFIG = {
  extensions: ['.md', '.markdown', '.mdx'],
  skipDirectories: ['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', '__pycache__', 'venv'],
  maxNotes: 800,
  maxDepth: 8,
  maxNoteBytes: 512 * 1024,
};

/** Bounds the config may not escape, so a bad row cannot exhaust the Host. */
const CONFIG_LIMITS = {
  maxNotes: [1, 20000],
  maxDepth: [0, 64],
  maxNoteBytes: [1024, 16 * 1024 * 1024],
};

/** Error code to HTTP status. */
const STATUS = {
  'unknown-workspace': 404,
  'missing-path': 400,
  'outside-workspace': 400,
  'not-a-note': 400,
  'not-found': 404,
  unreadable: 500,
  unauthorized: 403,
  internal: 500,
};

/**
 * Read a list of non-empty strings from config, or fall back.
 * @param value - the configured value.
 * @param fallback - the built-in default.
 * @returns the cleaned list.
 */
function stringList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const cleaned = value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return cleaned.length === 0 ? [...fallback] : cleaned;
}

/**
 * Read one bounded integer from config, or fall back.
 * @param value - the configured value.
 * @param min - smallest accepted value.
 * @param max - largest accepted value.
 * @param fallback - the built-in default.
 * @returns the accepted integer.
 */
function boundedInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

/**
 * Validate the plugin's optional config against the built-in defaults.
 * @param raw - the row's `config` object, if any.
 * @returns a complete, bounded configuration.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  return {
    extensions: stringList(input.extensions, DEFAULT_CONFIG.extensions).map((item) =>
      item.startsWith('.') ? item.toLowerCase() : `.${item.toLowerCase()}`,
    ),
    skipDirectories: stringList(input.skipDirectories, DEFAULT_CONFIG.skipDirectories).map((item) => item.toLowerCase()),
    maxNotes: boundedInt(input.maxNotes, ...CONFIG_LIMITS.maxNotes, DEFAULT_CONFIG.maxNotes),
    maxDepth: boundedInt(input.maxDepth, ...CONFIG_LIMITS.maxDepth, DEFAULT_CONFIG.maxDepth),
    maxNoteBytes: boundedInt(input.maxNoteBytes, ...CONFIG_LIMITS.maxNoteBytes, DEFAULT_CONFIG.maxNoteBytes),
  };
}

/**
 * The registered Workspaces, in the registry's own durable display order.
 *
 * The order is deliberately NOT re-sorted by `updatedAt`: `list()` already
 * returns the order the sidebar shows, and `updatedAt` only moves when a
 * Workspace record is written (title change, session attach/detach), which
 * says nothing about which Workspace the user is looking at.
 * @param ctx - Host plugin context.
 * @returns workspace rows plus a default key; empty without a registry.
 */
export function readWorkspaces(ctx) {
  const registry = ctx?.get?.('workspaceRegistry');
  if (registry === undefined || typeof registry.list !== 'function') {
    return { workspaces: [], defaultKey: null };
  }
  const rows = [];
  for (const workspace of registry.list()) {
    const root = typeof workspace?.path === 'string' ? workspace.path : '';
    if (root === '') continue;
    const id = typeof workspace?.id === 'string' && workspace.id !== '' ? workspace.id : root;
    rows.push({
      key: id,
      id,
      title:
        typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : path.basename(root),
      path: root,
      updatedAt: typeof workspace.updatedAt === 'string' ? workspace.updatedAt : '',
    });
  }
  return { workspaces: rows, defaultKey: rows.length > 0 ? rows[0].key : null };
}

/**
 * Compare two path spellings the way the running platform does.
 * @param value - a path.
 * @returns the comparison key.
 */
function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Resolve a requested workspace against the live registry, so only registered
 * Workspace directories can ever be listed or read. Both the durable id and
 * the directory path are accepted.
 * @param ctx - Host plugin context.
 * @param key - the requested workspace id or directory.
 * @returns the registry row, or undefined when the key names no registration.
 */
export function resolveWorkspace(ctx, key) {
  const registry = ctx?.get?.('workspaceRegistry');
  if (registry === undefined || typeof registry.list !== 'function') return undefined;
  if (typeof key !== 'string' || key === '') return undefined;
  const rows = registry.list();
  for (const workspace of rows) {
    if (typeof workspace?.id === 'string' && workspace.id === key) return workspace;
  }
  const wanted = pathKey(key);
  for (const workspace of rows) {
    if (typeof workspace?.path === 'string' && pathKey(workspace.path) === wanted) return workspace;
  }
  return undefined;
}

/**
 * Walk one workspace root collecting Markdown files.
 *
 * Directory entries come from `node:fs` rather than the Host `fs` service on
 * purpose: `Dirent` reports symlinks, so the walk can refuse to follow one,
 * while a service that resolves targets would happily descend through a
 * directory symlink pointing anywhere. No `stat` is issued per file — the
 * panel lists names, and size comes with the note itself.
 * @param root - absolute workspace root.
 * @param config - the resolved configuration.
 * @param readdir - injectable directory reader, for tests.
 * @param signal - caller cancellation, checked between directories.
 * @returns relative note rows and whether a cap cut the listing.
 */
export async function collectNotes(root, config, readdir = fs.readdir, signal) {
  const notes = [];
  let truncated = false;
  const queue = [{ dir: root, depth: 0 }];
  for (let head = 0; head < queue.length; head += 1) {
    if (signal?.aborted === true) return { notes, truncated, aborted: true };
    const current = queue[head];
    let entries;
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // The await is the long pole: re-check before doing any work with its result.
    if (signal?.aborted === true) return { notes, truncated, aborted: true };
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    let capped = false;
    for (const entry of entries) {
      if (signal?.aborted === true) return { notes, truncated, aborted: true };
      if (notes.length >= config.maxNotes) {
        capped = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        if (config.skipDirectories.includes(entry.name.toLowerCase())) continue;
        if (current.depth >= config.maxDepth) {
          truncated = true;
          continue;
        }
        queue.push({ dir: absolute, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (!config.extensions.includes(path.extname(entry.name).toLowerCase())) continue;
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const slash = relative.lastIndexOf('/');
      notes.push({
        path: relative,
        name: entry.name,
        dir: slash === -1 ? '' : relative.slice(0, slash),
      });
    }
    if (capped) {
      truncated = true;
      break;
    }
  }
  notes.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir.localeCompare(b.dir, undefined, { sensitivity: 'base' });
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return { notes, truncated };
}

/**
 * Decode a byte window as UTF-8, dropping one partial trailing sequence.
 * @param bytes - the window.
 * @returns the decoded text.
 */
function decodeTolerant(bytes) {
  for (let cut = 0; cut <= 3 && cut < bytes.length; cut += 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.length - cut));
    } catch {
      /* the window ends inside a multi-byte sequence: drop one byte and retry */
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Decode one note window, cutting a truncated window at a line boundary.
 * @param bytes - the bytes read.
 * @param truncated - whether the window is a prefix of a larger file.
 * @returns the decoded text.
 */
export function decodeNoteBytes(bytes, truncated) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!truncated) return decodeTolerant(buffer);
  const newline = buffer.lastIndexOf(0x0a);
  return decodeTolerant(newline === -1 ? buffer : buffer.subarray(0, newline + 1));
}

/**
 * Read one note through the Host `fs` service.
 * @param fsService - the `ctx.fs` service.
 * @param root - absolute workspace root.
 * @param relative - workspace-relative note path.
 * @param config - the resolved configuration.
 * @param signal - caller cancellation.
 * @returns the note payload, or `{ error }`.
 */
export async function readNote(fsService, root, relative, config, signal) {
  const requested = typeof relative === 'string' ? relative : '';
  if (requested === '') return { error: 'missing-path' };
  if (!config.extensions.includes(path.extname(requested).toLowerCase())) return { error: 'not-a-note' };

  let rootTarget;
  let target;
  try {
    rootTarget = await fsService.resolve(root);
    target = await fsService.resolve(requested, { cwd: root });
  } catch {
    return { error: 'not-found' };
  }
  if (rootTarget === undefined || target === undefined) return { error: 'not-found' };
  if (fsService.contains(rootTarget, target) !== true) return { error: 'outside-workspace' };

  let entry;
  try {
    entry = await fsService.lstat(requested, { cwd: root });
  } catch {
    return { error: 'not-found' };
  }
  if (entry === undefined) return { error: 'not-found' };
  if (entry.type === 'symlink') return { error: 'not-a-note' };
  if (entry.type !== 'file') return { error: 'not-a-note' };

  let info;
  try {
    info = await fsService.stat(target);
  } catch {
    return { error: 'not-found' };
  }
  if (info === undefined || info.type !== 'file') return { error: 'not-a-note' };

  const size = typeof info.size === 'number' && Number.isFinite(info.size) ? info.size : 0;
  const window = Math.min(size, config.maxNoteBytes + 1);
  let bytes;
  try {
    bytes = window === 0 ? new Uint8Array(0) : await fsService.readByteRange(target, { offset: 0, length: window }, signal);
  } catch {
    return { error: 'unreadable' };
  }
  const truncated = size > config.maxNoteBytes || bytes.length > config.maxNoteBytes;
  const slice = truncated ? bytes.subarray(0, config.maxNoteBytes) : bytes;
  return {
    path: requested.split(path.sep).join('/'),
    name: path.basename(requested),
    text: decodeNoteBytes(slice, truncated),
    size,
    truncated,
    limitBytes: config.maxNoteBytes,
  };
}

/** Response headers every answer carries. */
const RESPONSE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

/** The endpoints the shared channel serves, in registration order. */
export const ENDPOINTS = ['state', 'notes', 'note'];

/**
 * Answer one endpoint. The shared `/api` Fetch routes call this after the
 * connection fence admitted the request, so the endpoints, their bounds, and
 * their error vocabulary live in exactly one place.
 * @param ctx - Host plugin context.
 * @param config - the resolved configuration.
 * @param endpoint - one of `ENDPOINTS`.
 * @param params - request query parameters.
 * @param signal - caller cancellation, when the carrier supplies one.
 * @returns the status and JSON-serializable body.
 */
export async function answerRequest(ctx, config, endpoint, params, signal) {
  const fsService = ctx?.get?.('fs');
  if (fsService === undefined || typeof fsService.readByteRange !== 'function') {
    return { status: 503, body: { error: 'internal' } };
  }

  if (endpoint === 'state') {
    return { status: 200, body: { ...readWorkspaces(ctx), order: 'registry', route: `${API_ROUTE}/state` } };
  }

  if (endpoint === 'notes' || endpoint === 'note') {
    const workspace = resolveWorkspace(ctx, params.get('workspace') ?? '');
    if (workspace === undefined) return { status: 404, body: { error: 'unknown-workspace' } };
    const root = workspace.path;
    const id = typeof workspace.id === 'string' ? workspace.id : root;

    if (endpoint === 'notes') {
      const listing = await collectNotes(root, config, undefined, signal);
      // A walk cut short by the caller is not a listing: report it as cancelled
      // rather than answering with the partial rows it happened to collect.
      if (listing.aborted === true) return { status: 499, body: { error: 'aborted' } };
      return {
        status: 200,
        body: { workspace: id, root, notes: listing.notes, truncated: listing.truncated, limit: config.maxNotes },
      };
    }

    const note = await readNote(fsService, root, params.get('path') ?? '', config, signal);
    if (note.error !== undefined) return { status: STATUS[note.error] ?? 400, body: note };
    return { status: 200, body: note };
  }

  return { status: 404, body: { error: 'unknown-endpoint' } };
}

/**
 * The exact Fetch routes the shared `/api` channel owns for this plugin.
 *
 * The channel applies Connection's Host/Origin fence and browser
 * authentication before any of them runs, so none carries admission logic of
 * its own — exactly as the shipped `/api/file` route does. Registering here
 * also puts the plugin's traffic through the `connection/request` waterfall,
 * which a private `webServer` route bypasses.
 * @param ctx - Host plugin context.
 * @param config - the resolved configuration.
 * @returns one Fetch route per endpoint, with its label for effect diagnostics.
 */
export function createFetchRoutes(ctx, config) {
  return ENDPOINTS.map((endpoint) => ({
    label: `project-notes: GET /api/project-notes/${endpoint}`,
    route: {
      path: `${API_ROUTE}/${endpoint}`,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const head = request.method === 'HEAD';
        const url = new URL(request.url);
        let answer;
        try {
          answer = await answerRequest(ctx, config, endpoint, url.searchParams, request.signal);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx?.logger?.warn?.(new Error(`project-notes: ${message}`));
          answer = { status: 500, body: { error: 'internal' } };
        }
        return jsonResponse(answer.status, answer.body, head);
      },
    },
  }));
}

/**
 * One JSON response; a HEAD request carries the headers but no body.
 * @param status - HTTP status.
 * @param body - JSON-serializable body.
 * @param head - whether the request was a HEAD.
 * @returns the response.
 */
function jsonResponse(status, body, head) {
  const text = JSON.stringify(body);
  return new Response(head ? null : text, {
    status,
    headers: { ...RESPONSE_HEADERS, 'content-length': String(Buffer.byteLength(text)) },
  });
}
