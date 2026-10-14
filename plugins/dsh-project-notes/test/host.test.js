/**
 * Regression suite for the Host half.
 *
 * Every case below corresponds to a defect found while reviewing the plugin:
 * the symlink escape, the unbounded read, the mojibake at the truncation
 * boundary, the `updatedAt` workspace guess, and the unauthenticated route.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  API_ROUTE,
  collectNotes,
  createFetchRoutes,
  decodeNoteBytes,
  ENDPOINTS,
  normalizeConfig,
  readNote,
  readWorkspaces,
  resolveWorkspace,
} from '../lib/host.js';
import { fakeContext, fakeFs } from './fake-fs.js';

const CAP = 512 * 1024;

/**
 * Create a temporary workspace that is removed after the test.
 * @param t - the test context.
 * @returns the absolute root.
 */
async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-ws-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/**
 * Write one file, creating parent directories.
 * @param root - workspace root.
 * @param relative - slash-separated relative path.
 * @param content - file content.
 */
async function put(root, relative, content) {
  const full = path.join(root, ...relative.split('/'));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  return full;
}

// ---------------------------------------------------------------- readNote

test('readNote refuses a path that escapes the workspace root', async (t) => {
  const root = await workspace(t);
  const outside = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'pn-out-')), 'secret.md');
  await fs.writeFile(outside, 'SECRET');
  await put(root, 'notes/a.md', '# a');

  const result = await readNote(fakeFs, root, '../' + path.basename(path.dirname(outside)) + '/secret.md', normalizeConfig(), undefined);
  assert.equal(result.error, 'outside-workspace');
  await fs.rm(path.dirname(outside), { recursive: true, force: true });
});

test('readNote refuses a symlink pointing outside the workspace (the reported leak)', async (t) => {
  const root = await workspace(t);
  const secretDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-secret-'));
  const secret = path.join(secretDir, 'outside.md');
  await fs.writeFile(secret, 'TOP-SECRET-OUTSIDE-WORKSPACE');
  try {
    await fs.symlink(secret, path.join(root, 'innocent.md'), 'file');
  } catch (error) {
    t.skip(`symlink creation is not permitted here: ${error.code}`);
    await fs.rm(secretDir, { recursive: true, force: true });
    return;
  }

  const result = await readNote(fakeFs, root, 'innocent.md', normalizeConfig(), undefined);
  assert.equal(result.error, 'outside-workspace', 'realpath containment must reject the escape');
  assert.equal(result.text, undefined, 'no content may be returned');
  await fs.rm(secretDir, { recursive: true, force: true });
});

test('readNote refuses a symlink even when it points back inside the workspace', async (t) => {
  const root = await workspace(t);
  await put(root, 'notes/real.md', '# real');
  try {
    await fs.symlink(path.join(root, 'notes', 'real.md'), path.join(root, 'link.md'), 'file');
  } catch (error) {
    t.skip(`symlink creation is not permitted here: ${error.code}`);
    return;
  }

  const result = await readNote(fakeFs, root, 'link.md', normalizeConfig(), undefined);
  assert.equal(result.error, 'not-a-note');
});

test('readNote refuses a non-Markdown path and a missing note', async (t) => {
  const root = await workspace(t);
  await put(root, 'notes/a.md', '# a');
  assert.equal((await readNote(fakeFs, root, 'notes/a.txt', normalizeConfig(), undefined)).error, 'not-a-note');
  assert.equal((await readNote(fakeFs, root, 'notes/gone.md', normalizeConfig(), undefined)).error, 'not-found');
});

test('readNote reads a huge file through a bounded window and cuts at a line boundary', async (t) => {
  const root = await workspace(t);
  const line = '中文字符测试内容\n';
  const body = line.repeat(60000);
  await put(root, 'big.md', body);

  const result = await readNote(fakeFs, root, 'big.md', normalizeConfig(), undefined);
  assert.equal(result.truncated, true);
  assert.equal(result.limitBytes, CAP);
  assert.ok(result.text.length > 0);
  assert.ok(result.text.endsWith('\n'), 'a truncated window ends on the last complete line');
  assert.ok(result.text.length <= CAP, 'no more than the byte cap was decoded');
  assert.ok(!result.text.includes('\uFFFD'), 'no replacement character may appear at the cut');
  assert.equal(result.size, Buffer.byteLength(body));
});

test('readNote never leaves a partial UTF-8 sequence when one line exceeds the cap', async (t) => {
  const root = await workspace(t);
  const body = '中'.repeat(200000); // 600000 bytes, no newline anywhere
  await put(root, 'oneline.md', body);

  const result = await readNote(fakeFs, root, 'oneline.md', normalizeConfig(), undefined);
  assert.equal(result.truncated, true);
  assert.ok(!result.text.includes('\uFFFD'), 'the trailing partial character must be dropped');
  assert.ok(result.text.length > 0);
});

test('readNote leaves a file at or under the cap untouched', async (t) => {
  const root = await workspace(t);
  const body = 'x'.repeat(4096);
  await put(root, 'small.md', body);

  const result = await readNote(fakeFs, root, 'small.md', normalizeConfig(), undefined);
  assert.equal(result.truncated, false);
  assert.equal(result.text, body);
  assert.equal(result.size, 4096);
});

test('readNote reports an empty file as an empty note', async (t) => {
  const root = await workspace(t);
  await put(root, 'empty.md', '');

  const result = await readNote(fakeFs, root, 'empty.md', normalizeConfig(), undefined);
  assert.equal(result.text, '');
  assert.equal(result.truncated, false);
});

test('decodeNoteBytes drops the partial sequence at a truncated window end', () => {
  const bytes = Buffer.from('中'.repeat(10));
  const cut = bytes.subarray(0, 11); // 3-byte characters: byte 11 splits one
  const text = decodeNoteBytes(cut, true);
  assert.ok(!text.includes('\uFFFD'));
  assert.equal(text, '中'.repeat(3));
});

// ------------------------------------------------------------ collectNotes

test('collectNotes skips dot directories, skip-listed directories, and symlinked directories', async (t) => {
  const root = await workspace(t);
  await put(root, 'README.md', '# root');
  await put(root, 'notes/a.md', '# a');
  await put(root, 'notes/deep/b.markdown', '# b');
  await put(root, 'notes/skip.txt', 'no');
  await put(root, '.hidden/secret.md', '# hidden');
  await put(root, 'node_modules/pkg/dep.md', '# dep');

  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-link-'));
  await fs.writeFile(path.join(outsideDir, 'escaped.md'), '# escaped');
  try {
    await fs.symlink(outsideDir, path.join(root, 'linked'), 'junction');
  } catch {
    /* the walk must ignore it either way; the assertion below still holds */
  }

  const listing = await collectNotes(root, normalizeConfig());
  const paths = listing.notes.map((note) => note.path);
  assert.deepEqual(paths, ['README.md', 'notes/a.md', 'notes/deep/b.markdown']);
  assert.equal(listing.truncated, false);
  await fs.rm(outsideDir, { recursive: true, force: true });
});

test('collectNotes stops at maxNotes and reports truncation', async (t) => {
  const root = await workspace(t);
  for (let index = 0; index < 5; index += 1) await put(root, `n${index}.md`, '# n');

  const listing = await collectNotes(root, normalizeConfig({ maxNotes: 2 }));
  assert.equal(listing.notes.length, 2);
  assert.equal(listing.truncated, true);
});

test('collectNotes honours maxDepth and reports truncation', async (t) => {
  const root = await workspace(t);
  await put(root, 'top.md', '# top');
  await put(root, 'one/mid.md', '# mid');
  await put(root, 'one/two/deep.md', '# deep');

  const listing = await collectNotes(root, normalizeConfig({ maxDepth: 1 }));
  assert.deepEqual(
    listing.notes.map((note) => note.path),
    ['top.md', 'one/mid.md'],
  );
  assert.equal(listing.truncated, true);
});

test('collectNotes carries name and directory for the list rows', async (t) => {
  const root = await workspace(t);
  await put(root, 'docs/guide/x.md', '# x');

  const listing = await collectNotes(root, normalizeConfig());
  assert.deepEqual(listing.notes, [{ path: 'docs/guide/x.md', name: 'x.md', dir: 'docs/guide' }]);
});

test('collectNotes stops when the caller cancels, and does not report a listing', async (t) => {
  const root = await workspace(t);
  await put(root, 'a.md', '# a');
  await put(root, 'deep/b.md', '# b');

  // Abort lands while the first `readdir` is in flight: the walk must not
  // finish, and the partial rows it collected must never be handed back as a
  // complete listing.
  const controller = new AbortController();
  const listing = await collectNotes(
    root,
    normalizeConfig(),
    async (dir, options) => {
      controller.abort();
      return fs.readdir(dir, options);
    },
    controller.signal,
  );
  assert.equal(listing.aborted, true, 'a cancelled walk reports itself as cancelled');
  assert.deepEqual(listing.notes, [], 'and carries no rows the caller cancelled');
});

test('a cancelled listing answers 499 rather than a partial list', async (t) => {
  const root = await workspace(t);
  await put(root, 'a.md', '# a');
  await put(root, 'deep/b.md', '# b');
  const controller = new AbortController();
  controller.abort();

  const answer = await call(routesFor(servicesFor(root)), 'notes', 'workspace=w1', 'GET', controller.signal);
  assert.equal(answer.status, 499);
  assert.deepEqual(answer.json(), { error: 'aborted' });
  assert.equal(answer.json().notes, undefined, 'no partial rows may reach the client');
});

// ------------------------------------------------------------------ config

test('normalizeConfig clamps or falls back on bad input', () => {
  const defaults = normalizeConfig();
  assert.deepEqual(defaults.extensions, ['.md', '.markdown', '.mdx']);
  assert.equal(defaults.maxNotes, 800);

  assert.equal(normalizeConfig({ maxNotes: 0 }).maxNotes, 800, 'out-of-range falls back');
  assert.equal(normalizeConfig({ maxNotes: 1e9 }).maxNotes, 800, 'absurd values fall back');
  assert.equal(normalizeConfig({ maxNotes: 12.7 }).maxNotes, 12);
  assert.equal(normalizeConfig({ maxDepth: 0 }).maxDepth, 0, 'zero depth is legitimate');
  assert.equal(normalizeConfig({ maxNoteBytes: 'big' }).maxNoteBytes, CAP);
  assert.deepEqual(normalizeConfig({ extensions: ['md', '.TXT'] }).extensions, ['.md', '.txt']);
  assert.deepEqual(normalizeConfig({ extensions: [] }).extensions, ['.md', '.markdown', '.mdx']);
  assert.deepEqual(normalizeConfig({ skipDirectories: ['  Build '] }).skipDirectories, ['build']);
  assert.deepEqual(normalizeConfig(null).extensions, ['.md', '.markdown', '.mdx']);
});

// -------------------------------------------------------------- workspaces

const REGISTRY = [
  { id: 'w-old', path: 'D:\\old', title: 'old', updatedAt: '2020-01-01T00:00:00.000Z' },
  { id: 'w-new', path: 'D:\\new', title: 'new', updatedAt: '2030-01-01T00:00:00.000Z' },
];

test('readWorkspaces keeps the registry display order instead of sorting by updatedAt', () => {
  const ctx = fakeContext({ workspaceRegistry: { list: () => REGISTRY } });
  const state = readWorkspaces(ctx);
  assert.deepEqual(
    state.workspaces.map((row) => row.key),
    ['w-old', 'w-new'],
    'the newest updatedAt must not be promoted over the sidebar order',
  );
  assert.equal(state.defaultKey, 'w-old', 'the default is the first registered workspace');
  assert.equal(state.workspaces[1].path, 'D:\\new');
  assert.equal(state.workspaces[1].title, 'new');
});

test('readWorkspaces degrades to an empty projection without a registry', () => {
  assert.deepEqual(readWorkspaces(fakeContext({})), { workspaces: [], defaultKey: null });
});

test('resolveWorkspace accepts the durable id and the directory path, and nothing else', () => {
  const ctx = fakeContext({ workspaceRegistry: { list: () => REGISTRY } });
  assert.equal(resolveWorkspace(ctx, 'w-new').id, 'w-new');
  assert.equal(resolveWorkspace(ctx, 'D:\\new').id, 'w-new');
  assert.equal(resolveWorkspace(ctx, 'd:\\NEW').id, 'w-new', 'path matching follows platform case rules');
  assert.equal(resolveWorkspace(ctx, 'D:\\elsewhere'), undefined);
  assert.equal(resolveWorkspace(ctx, ''), undefined);
  assert.equal(resolveWorkspace(ctx, undefined), undefined);
});

// ------------------------------------------------------------ fetch routes

/**
 * The Fetch routes one context exposes, keyed by endpoint.
 * @param services - services for `ctx.get`.
 * @param config - plugin config.
 * @returns endpoint to route.
 */
function routesFor(services, config = normalizeConfig()) {
  const routes = createFetchRoutes(fakeContext(services), config);
  assert.deepEqual(
    routes.map(({ route }) => route.path),
    ENDPOINTS.map((endpoint) => `${API_ROUTE}/${endpoint}`),
    'every endpoint is registered on the shared channel',
  );
  return new Map(routes.map(({ route }) => [route.path, route]));
}

/**
 * Call one route the way the shared channel does: the fence already admitted,
 * the handler owns its own Response.
 * @param routes - routes from `routesFor`.
 * @param endpoint - endpoint name.
 * @param query - query string, without the leading `?`.
 * @param method - HTTP method.
 * @param signal - caller cancellation, as the channel supplies it.
 * @returns the status, headers, and parsed body.
 */
async function call(routes, endpoint, query = '', method = 'GET', signal) {
  const route = routes.get(`${API_ROUTE}/${endpoint}`);
  assert.ok(route !== undefined, `route for ${endpoint}`);
  const url = query === '' ? `http://127.0.0.1:19387${route.path}` : `http://127.0.0.1:19387${route.path}?${query}`;
  const response = await route.fetch(new Request(url, { method, ...(signal === undefined ? {} : { signal }) }));
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: () => JSON.parse(text),
  };
}

/**
 * Build the standard service set for one workspace root.
 * @param root - workspace root.
 * @returns the services.
 */
function servicesFor(root) {
  return {
    workspaceRegistry: { list: () => [{ id: 'w1', path: root, title: 'ws', updatedAt: '2020-01-01T00:00:00.000Z' }] },
    fs: fakeFs,
  };
}

test('every route is an exact GET/HEAD route on the shared channel', async (t) => {
  const root = await workspace(t);
  const routes = routesFor(servicesFor(root));
  for (const route of routes.values()) {
    assert.deepEqual(route.methods, ['GET', 'HEAD'], 'the fence carries read-only methods');
    assert.equal(route.requestBody, 'buffered');
    assert.equal(typeof route.fetch, 'function');
    // The registry validates a route path with the same rule the shared channel
    // resolves endpoints by: it must sit below `/api` and every segment must be
    // a plain token. A path that fails this throws at load, so assert it here.
    assert.ok(route.path.startsWith('/api/'), 'a shared-channel route lives below /api');
    for (const segment of route.path.slice('/api/'.length).split('/')) {
      assert.match(segment, /^[A-Za-z0-9_$.-]+$/, `segment ${JSON.stringify(segment)} must be a plain token`);
    }
  }
});

test('the routes carry no admission logic of their own', async (t) => {
  // The shared channel admits before dispatch, so a route must answer even
  // without a `connection` service in the context: the fence is not the
  // handler's job. A regression here would mean the plugin quietly re-added a
  // private gate that the `connection/request` waterfall cannot see.
  const root = await workspace(t);
  await put(root, 'a.md', '# a');
  const routes = routesFor({ workspaceRegistry: { list: () => [] }, fs: fakeFs });
  const answer = await call(routes, 'state');
  assert.equal(answer.status, 200, 'no private gate may refuse an already-admitted request');
});

test('the routes answer endpoint errors and declare only read methods', async (t) => {
  const root = await workspace(t);
  const routes = routesFor(servicesFor(root));

  // A non-GET/HEAD request never reaches a handler: the shared channel only
  // dispatches the methods a route declares, then falls through to its own
  // RPC dispatch. The declaration is therefore the method gate.
  for (const route of routes.values()) {
    assert.deepEqual(route.methods, ['GET', 'HEAD'], 'a write method must stay unowned');
  }

  const badWorkspace = await call(routes, 'notes', 'workspace=nope');
  assert.equal(badWorkspace.status, 404);
  assert.deepEqual(badWorkspace.json(), { error: 'unknown-workspace' });
});

test('the state endpoint reports the registry order and the route', async (t) => {
  const root = await workspace(t);
  const answer = await call(routesFor(servicesFor(root)), 'state');
  assert.equal(answer.status, 200);
  const body = answer.json();
  assert.equal(body.defaultKey, 'w1');
  assert.equal(body.order, 'registry');
  assert.equal(body.route, `${API_ROUTE}/state`);
  assert.equal(answer.headers.get('cache-control'), 'no-store');
  assert.equal(answer.headers.get('x-content-type-options'), 'nosniff');
});

test('a HEAD answer carries the headers but no body', async (t) => {
  const root = await workspace(t);
  const answer = await call(routesFor(servicesFor(root)), 'state', '', 'HEAD');
  assert.equal(answer.status, 200);
  assert.equal(answer.text, '', 'a HEAD response must not carry a body');
  assert.ok(Number(answer.headers.get('content-length')) > 0, 'and still advertises the length a GET would send');
});

test('the notes and note endpoints serve the workspace and refuse an escape', async (t) => {
  const root = await workspace(t);
  await put(root, 'notes/a.md', '# a');
  const routes = routesFor(servicesFor(root));

  const list = await call(routes, 'notes', 'workspace=w1');
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.json().notes.map((note) => note.path),
    ['notes/a.md'],
  );
  assert.equal(list.json().limit, 800);
  assert.equal(list.json().workspace, 'w1');

  const note = await call(routes, 'note', `workspace=w1&path=${encodeURIComponent('notes/a.md')}`);
  assert.equal(note.status, 200);
  assert.equal(note.json().text, '# a');

  const escape = await call(routes, 'note', `workspace=w1&path=${encodeURIComponent('../../secret.md')}`);
  assert.equal(escape.status, 400);
  assert.equal(escape.json().error, 'outside-workspace');
});

test('the 500 body never echoes the internal message', async (t) => {
  const root = await workspace(t);
  const boobyTrapped = {
    async readByteRange() {
      throw new Error('C:\\Users\\operator\\secret\\path');
    },
    async resolve() {
      throw new Error('C:\\Users\\operator\\secret\\path');
    },
  };
  const answer = await call(routesFor({ ...servicesFor(root), fs: boobyTrapped }), 'note', 'workspace=w1&path=a.md');
  assert.equal(answer.status, 404, 'a resolve failure is reported as not-found');
  assert.ok(!answer.text.includes('operator'), 'no host path may leak to the client');
});
