/**
 * Wiring and behaviour test for the Client half.
 *
 * The bundle is registered through `window.__ModuleLoader__.load`, so a stub
 * loader, a stub DOM, and a stub React surface that runs hooks immediately are
 * enough to execute the factory, its `apply()`, and its component — which
 * catches a broken module id, a wrong slot or cell id, a lost payload, and a
 * shortcut that no longer answers.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

/** Specs the bundle registered, by module id. */
const registered = new Map();
/** Style tags the plugin injected. */
const styleTags = [];
/** `selectionchange` listeners currently installed. */
const selectionListeners = new Set();
/** What `document.getSelection()` answers, set per test. */
let selection = null;
/** Every value handed to a `useState` setter, so a hint can be asserted. */
const stateWrites = [];

globalThis.window = {
  __ModuleLoader__: { load: (spec) => registered.set(spec.id, spec) },
  location: { origin: 'http://127.0.0.1:19387' },
};
globalThis.document = {
  getElementById: (id) => styleTags.find((tag) => tag.id === id) ?? null,
  createElement: () => ({
    id: '',
    textContent: '',
    dataset: {},
    remove() {
      const at = styleTags.indexOf(this);
      if (at >= 0) styleTags.splice(at, 1);
    },
  }),
  addEventListener: (type, listener) => {
    if (type === 'selectionchange') selectionListeners.add(listener);
  },
  removeEventListener: (type, listener) => {
    if (type === 'selectionchange') selectionListeners.delete(listener);
  },
  getSelection: () => selection,
  head: { append: (tag) => styleTags.push(tag) },
};

await import('../client.js');

/**
 * A React surface whose hooks run during the call, so one function call is a
 * complete render and its effects are already in place.
 * @returns the stub.
 */
function reactStub() {
  return {
    Fragment: Symbol('Fragment'),
    createElement: (...args) => ({ type: args[0], props: args[1] ?? {}, children: args.slice(2) }),
    memo: (component) => component,
    useRef: (value) => ({ current: value }),
    useState: (initial) => [
      typeof initial === 'function' ? initial() : initial,
      (value) => stateWrites.push(value),
    ],
    useEffect: (callback) => callback(),
    useCallback: (callback) => callback,
  };
}

/**
 * A `require` that answers only the modules a test provides.
 * @param modules - id to module map.
 * @returns the resolver.
 */
function requireStub(modules) {
  return (id) => {
    if (Object.hasOwn(modules, id)) return modules[id];
    throw new Error(`module not available: ${id}`);
  };
}

/**
 * Every element of one rendered tree, depth first.
 * @param node - the rendered node.
 * @returns the elements found.
 */
function flatten(node) {
  const out = [];
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || value === undefined || typeof value !== 'object') return;
    out.push(value);
    walk(value.children);
  };
  walk(node);
  return out;
}

/**
 * A client context recording every registration.
 * @returns the context and its log.
 */
function clientContext() {
  const log = { effects: [], registrations: [], injected: [], shortcuts: [], disposers: [] };
  const ctx = {
    effect: (callback, label) => {
      log.effects.push(label);
      const dispose = callback();
      log.disposers.push(dispose);
      return dispose;
    },
    get: () => undefined,
    // Set per test: the injected `remote` namespace the reader goes through.
    remote: undefined,
    inject: (names, callback) => {
      log.injected.push(...names);
      callback(ctx);
    },
    slots: {
      inject: (name, callback) => {
        log.injected.push(name);
        return callback();
      },
      register: (options, component) => {
        assert.equal(typeof component, 'function', 'a slot registration needs a component');
        log.registrations.push({ name: options.name, key: options.id ?? options.key, inject: options.inject, component });
        return () => {};
      },
    },
    shortcuts: {
      register: (definition) => {
        log.shortcuts.push(definition);
        return () => {};
      },
    },
  };
  return { ctx, log };
}

/**
 * Load the bundle and mount it on a fresh context.
 * @param modules - extra modules the factory may require.
 * @returns the module, the context, and its log.
 */
function mount(modules = {}) {
  const spec = registered.get('@local/dsh-send-to-input');
  const module = spec.factory(requireStub({ react: reactStub(), ...modules }));
  const { ctx, log } = clientContext();
  module.apply(ctx);
  return { module, ctx, log };
}

/**
 * A composer double recording what reached it.
 * @param accepted - what `insertText` answers.
 * @returns the face and its log.
 */
function inputActionsDouble(accepted = true) {
  const calls = [];
  return {
    calls,
    captureInsertion: () => ({ draftRev: 7 }),
    insertText: (text, span) => {
      calls.push({ text, span });
      return accepted;
    },
  };
}

/**
 * The last hint the component put on screen.
 * @returns the hint text, or `undefined` when it never wrote one.
 */
function lastHint() {
  const strings = stateWrites.filter((value) => typeof value === 'string' && value !== '');
  return strings[strings.length - 1];
}

/**
 * Click the whole-file button with a Host file API that refuses every read the
 * way the real one does — a `RemoteResult` carrying the error, not a throw. The
 * plugin's own reader runs, so this covers the path from the refusal through
 * `readFileText` to the visible hint.
 * @param code - the `code` the Host refusal carries, or `null` for no Remote face.
 * @param thrown - an exception to throw instead, for the no-code path.
 * @returns the hint the component last set.
 */
async function hintWhenReadFails(code, thrown = null) {
  const spec = registered.get('@local/dsh-send-to-input');
  const module = spec.factory(requireStub({ react: reactStub() }));
  const { ctx, log } = clientContext();
  const compose = inputActionsDouble();
  if (code !== null || thrown !== null) {
    ctx.remote = {
      workspaceFiles: {
        read: () =>
          thrown === null ? Promise.resolve({ ok: false, error: { code } }) : Promise.reject(thrown),
      },
    };
  }
  module.apply(ctx);

  const { readFile } = log.registrations[0].inject();
  const cell = flatten(
    log.registrations[0].component({
      inputActions: compose,
      sessionId: 's1',
      absolutePath: 'D:\\ws\\note.md',
      readFile,
    }),
  );
  const buttons = cell.filter((node) => node.type === 'button');
  stateWrites.length = 0;
  await buttons[1].props.onClick();
  assert.equal(compose.calls.length, 0, 'a failed read must never send a payload');
  return lastHint();
}

test('the bundle registers itself under the package id', () => {
  assert.ok(registered.has('@local/dsh-send-to-input'), 'the module loader must receive our id');
});


test('the factory loads with and without the shipped primitives', () => {
  const spec = registered.get('@local/dsh-send-to-input');
  const fallback = spec.factory(requireStub({ react: reactStub() }));
  assert.deepEqual(
    fallback.inject,
    ['slots', 'remote', 'remote.workspaceFiles'],
    'the reader goes through an injected namespace, exactly as the shipped preview does',
  );
  assert.equal(typeof fallback.apply, 'function');

  const withIcons = spec.factory(
    requireStub({
      react: reactStub(),
      '@deepseek-ai/dsh-client-ui-primitives': {
        IconSendOutlineRegular: () => null,
        IconDeliverDocRegular: () => null,
      },
    }),
  );
  assert.equal(typeof withIcons.apply, 'function');
});

test('apply injects the stylesheet, tracks selections, and claims the header cell', () => {
  const { log } = mount();

  const styles = styleTags.find((tag) => tag.id === 'dsh-send-to-input-style');
  assert.ok(styles !== undefined, 'the plugin stylesheet must be injected');
  assert.ok(styles.textContent.includes('.dsh-sti-button:hover'), 'hover lives in CSS, not in React state');
  assert.ok(styles.textContent.includes('var(--dsw-alias-'), 'colors must come from theme tokens');

  assert.deepEqual(log.effects, [
    'send-to-input: styles',
    'send-to-input: selection tracking',
    'send-to-input: preview action',
    'send-to-input: shortcut',
  ]);
  assert.equal(selectionListeners.size, 1, 'selections are watched while the plugin is mounted');
  assert.deepEqual(
    log.registrations.map((row) => ({ name: row.name, key: row.key })),
    [{ name: 'sidebar.right.tab.document.actions', key: 'send-to-input' }],
  );
  assert.deepEqual(
    log.shortcuts.map((row) => row.id),
    ['sendToInput.selection'],
  );
});

test('the shortcut blocks without a mounted preview or a selection', () => {
  const { log } = mount();
  const definition = log.shortcuts[0];
  selection = null;
  assert.equal(definition.resolve().status, 'blocked', 'no preview means no handle to write into');
  assert.deepEqual(definition.defaults['desktop:windows'], { code: 'KeyI', modifiers: ['primary', 'alt'] });
  assert.deepEqual(definition.regions, ['page', 'editable', 'terminal']);
});

test('the header cell sends the remembered selection as a fenced block', () => {
  const { log } = mount();
  const compose = inputActionsDouble();
  selection = null;

  // The selection is remembered first, then dropped by the click.
  const anchor = { parentElement: null, closest: () => null };
  selection = { rangeCount: 1, toString: () => '# 标题\n正文', anchorNode: anchor };
  for (const listener of selectionListeners) listener();
  selection = null;

  const cell = flatten(
    log.registrations[0].component({ inputActions: compose, sessionId: 's1', absolutePath: 'D:\\ws\\note.md' }),
  );
  const buttons = cell.filter((node) => node.type === 'button');
  assert.equal(buttons.length, 2, 'the cell offers one button per action');
  assert.equal(buttons[0].props.disabled, false);

  buttons[0].props.onClick();
  assert.equal(compose.calls.length, 1, 'the selection must reach the composer');
  assert.equal(compose.calls[0].span.draftRev, 7, 'the span is captured in the same tick as the insert');
  assert.ok(compose.calls[0].text.includes('D:\\ws\\note.md'), 'the payload names the file it came from');
  assert.ok(compose.calls[0].text.includes('```md'), 'the payload is fenced with the file extension');
  assert.ok(compose.calls[0].text.includes('# 标题\n正文'), 'the payload carries the selected text');
});

test('the header cell refuses to send the composer own text back into itself', () => {
  const { log } = mount();
  const compose = inputActionsDouble();
  // A text node inside the composer: its parent is what `closest` is asked of.
  const inComposer = { parentElement: { closest: (selector) => (selector.includes('contenteditable') ? {} : null) } };
  selection = { rangeCount: 1, toString: () => '半成品草稿', anchorNode: inComposer };
  for (const listener of selectionListeners) listener();

  const cell = flatten(log.registrations[0].component({ inputActions: compose, sessionId: 's1', absolutePath: null }));
  const buttons = cell.filter((node) => node.type === 'button');
  buttons[0].props.onClick();
  assert.equal(compose.calls.length, 0, 'a composer selection is not a source');
  assert.equal(buttons[1].props.disabled, true, 'sending a whole file needs a file behind the preview');
});

test('the whole-file button pages with 1-based offsets and joins pages itself', async () => {
  const spec = registered.get('@local/dsh-send-to-input');
  const module = spec.factory(requireStub({ react: reactStub() }));
  const { ctx, log } = clientContext();
  const compose = inputActionsDouble();
  // Exactly what the Host answers: a RemoteResult whose page text joins its
  // lines with "\n" and carries no terminator after the last one.
  const pages = [
    { ok: true, value: { text: 'a\nb', lines: 2, eof: false } },
    { ok: true, value: { text: 'c', lines: 1, eof: true } },
  ];
  const reads = [];
  ctx.remote = {
    workspaceFiles: {
      read: (sessionId, path, range, signal) => {
        reads.push({
          sessionId,
          path,
          offset: range.offset,
          sendsLimit: Object.hasOwn(range, 'limit'),
          cancellable: signal !== undefined,
        });
        return Promise.resolve(pages.shift());
      },
    },
  };
  module.apply(ctx);

  // The reader reaches the component the same way the platform delivers props.
  const { readFile } = log.registrations[0].inject();
  const cell = flatten(
    log.registrations[0].component({ inputActions: compose, sessionId: 's1', absolutePath: 'D:\\ws\\a.json', readFile }),
  );
  const buttons = cell.filter((node) => node.type === 'button');
  await buttons[1].props.onClick();

  assert.deepEqual(
    reads,
    [
      { sessionId: 's1', path: 'D:\\ws\\a.json', offset: 1, sendsLimit: false, cancellable: true },
      { sessionId: 's1', path: 'D:\\ws\\a.json', offset: 3, sendsLimit: false, cancellable: true },
    ],
    'line numbers start at 1, and the next page resumes after the lines reported',
  );
  assert.equal(compose.calls.length, 1);
  assert.ok(compose.calls[0].text.includes('```json'), 'the fence follows the file extension');
  assert.ok(compose.calls[0].text.includes('a\nb\nc'), 'pages are joined with the newline the Host stripped');
});

test('a reader that throws outright still sends nothing and says the flat line', async () => {
  const spec = registered.get('@local/dsh-send-to-input');
  const module = spec.factory(requireStub({ react: reactStub() }));
  const { ctx, log } = clientContext();
  const compose = inputActionsDouble();
  module.apply(ctx);
  // A foreign reader, not the plugin's own: a transport failure never reaches
  // this code as a RemoteResult, so the component's own guard has to hold.
  const readFile = () => Promise.reject(Object.assign(new Error('nope'), { code: 'not-text' }));

  const cell = flatten(
    log.registrations[0].component({ inputActions: compose, sessionId: 's1', absolutePath: 'D:\\ws\\a.md', readFile }),
  );
  const buttons = cell.filter((node) => node.type === 'button');
  stateWrites.length = 0;
  await buttons[1].props.onClick();
  assert.equal(compose.calls.length, 0, 'a failed read sends nothing');
  assert.equal(lastHint(), '读取文件失败', 'a failure with no readable code keeps the flat message');
});

test('a read failure names the real reason instead of one flat message', async () => {
  assert.equal(
    await hintWhenReadFails('workspace-file/not-found'),
    '文件不存在，可能已被移动或删除',
    'a moved or deleted preview is fixed by reopening it, and must say so',
  );
  assert.equal(await hintWhenReadFails('workspace-file/not-text'), '这个文件不是文本，无法发送');
  assert.equal(await hintWhenReadFails('workspace-file/too-large'), '文件太大，无法发送');
  assert.equal(await hintWhenReadFails('workspace-file/not-regular-file'), '这不是普通文件，无法读取');
});

test('a bare or unknown code still lands somewhere the user can act on', async () => {
  assert.equal(
    await hintWhenReadFails('not-text'),
    '这个文件不是文本，无法发送',
    'matching is on the code tail, so an unnamespaced code still resolves',
  );
  assert.equal(
    await hintWhenReadFails('gateway/bad-request'),
    '读取文件失败（gateway/bad-request）',
    'an unmapped code keeps its text rather than hiding behind one message',
  );
  assert.equal(await hintWhenReadFails(null), '文件读取不可用', 'a missing Remote face is its own reason');
});

test('a failure with no Host code says what it actually was', async () => {
  assert.equal(
    await hintWhenReadFails(null, new TypeError('remote.workspaceFiles is undefined')),
    '读取文件失败（TypeError: remote.workspaceFiles is undefined）',
    'an unattributed failure must not hide behind the flat message again',
  );
  assert.equal(
    await hintWhenReadFails('Bad Request'),
    '读取文件失败（Bad Request）',
    'a string error is a reason too',
  );
  assert.equal(
    await hintWhenReadFails(null, new Error('')),
    '读取文件失败',
    'a nameless, messageless throw falls back to the flat line',
  );
});

test('a reload keeps the stylesheet alive, and the last owner removes it', () => {
  const spec = registered.get('@local/dsh-send-to-input');
  const one = clientContext();
  const two = clientContext();

  spec.factory(requireStub({ react: reactStub() })).apply(one.ctx);
  assert.equal(styleTags.length, 1, 'the first load injects one tag');
  spec.factory(requireStub({ react: reactStub() })).apply(two.ctx);
  assert.equal(styleTags.length, 1, 'a reload reuses the single tag');

  one.log.disposers[0](); // the predecessor is disposed after its successor claimed the tag
  assert.equal(styleTags.length, 1, 'a predecessor must not delete its successor stylesheet');

  two.log.disposers[0](); // a real uninstall
  assert.equal(styleTags.length, 0, 'the last owner removes the tag');

  // Each mount watches selections for exactly as long as it lives.
  const watched = selectionListeners.size;
  one.log.disposers[1]();
  assert.equal(selectionListeners.size, watched - 1, 'the selection tracker goes away with its owner');
});
