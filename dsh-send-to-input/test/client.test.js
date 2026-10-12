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
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
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

test('the bundle registers itself under the package id', () => {
  assert.ok(registered.has('@local/dsh-send-to-input'), 'the module loader must receive our id');
});

test('the factory loads with and without the shipped primitives', () => {
  const spec = registered.get('@local/dsh-send-to-input');
  const fallback = spec.factory(requireStub({ react: reactStub() }));
  assert.deepEqual(fallback.inject, ['slots']);
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

test('the whole-file button reads through the file API until eof', async () => {
  const spec = registered.get('@local/dsh-send-to-input');
  const module = spec.factory(requireStub({ react: reactStub() }));
  const { ctx, log } = clientContext();
  const compose = inputActionsDouble();
  const pages = [
    { text: 'a\nb\n', lines: 2, eof: false },
    { text: 'c\n', lines: 1, eof: true },
  ];
  const reads = [];
  ctx.get = (key) =>
    key === 'remote'
      ? {
          workspaceFiles: {
            read: (sessionId, path, range, signal) => {
              reads.push({ sessionId, path, offset: range.offset, cancellable: signal !== undefined });
              return Promise.resolve(pages.shift());
            },
          },
        }
      : undefined;
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
      { sessionId: 's1', path: 'D:\\ws\\a.json', offset: 0, cancellable: true },
      { sessionId: 's1', path: 'D:\\ws\\a.json', offset: 2, cancellable: true },
    ],
    'pages are read until eof, advancing by the reported line count',
  );
  assert.equal(compose.calls.length, 1);
  assert.ok(compose.calls[0].text.includes('```json'), 'the fence follows the file extension');
  assert.ok(compose.calls[0].text.includes('a\nb\nc'), 'every page lands in the payload');
});

test('a read failure is reported instead of sending a half-empty payload', async () => {
  const spec = registered.get('@local/dsh-send-to-input');
  const module = spec.factory(requireStub({ react: reactStub() }));
  const { ctx, log } = clientContext();
  const compose = inputActionsDouble();
  const failure = Object.assign(new Error('nope'), { code: 'not-text' });
  module.apply(ctx);
  const readFile = () => Promise.reject(failure);

  const cell = flatten(
    log.registrations[0].component({ inputActions: compose, sessionId: 's1', absolutePath: 'D:\\ws\\a.png', readFile }),
  );
  const buttons = cell.filter((node) => node.type === 'button');
  await buttons[1].props.onClick();
  assert.equal(compose.calls.length, 0, 'a failed read sends nothing');
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
