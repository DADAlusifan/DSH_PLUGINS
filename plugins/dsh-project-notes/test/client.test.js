/**
 * Wiring test for the Client half.
 *
 * The browser bundle is registered through `window.__ModuleLoader__.load`, so
 * a stub loader plus a minimal React stub is enough to execute the factory and
 * its `apply()` — which catches a broken module id, a missing helper, or a
 * wrong slot name without needing a browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

/** Specs the bundle registered, by module id. */
const registered = new Map();
/** Style tags the panel injected. */
const styleTags = [];

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
  head: { append: (tag) => styleTags.push(tag) },
};

await import('../client.js');

/** Minimal React surface the factory touches outside a render. */
function reactStub() {
  return {
    Fragment: Symbol('Fragment'),
    createElement: (...args) => ({ type: args[0], props: args[1], children: args.slice(2) }),
    memo: (component) => component,
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
 * A client context recording every registration.
 * @returns the context and its log.
 */
function clientContext() {
  const log = { effects: [], registrations: [], injected: [], disposers: [] };
  const ctx = {
    effect: (callback, label) => {
      log.effects.push(label);
      const dispose = callback();
      log.disposers.push(dispose);
      return dispose;
    },
    get: () => undefined,
    slots: {
      inject: (name, callback) => {
        log.injected.push(name);
        return callback();
      },
      register: (options, component) => {
        assert.equal(typeof component, 'function', 'a slot registration needs a component');
        log.registrations.push({ name: options.name, key: options.id ?? options.key, label: options.label });
        return () => {};
      },
    },
  };
  return { ctx, log };
}

test('the bundle registers itself under the package id', () => {
  assert.ok(registered.has('@local/dsh-project-notes'), 'the module loader must receive our id');
});

test('the factory loads with and without the shipped primitives', () => {
  const spec = registered.get('@local/dsh-project-notes');
  const fallback = spec.factory(requireStub({ react: reactStub() }));
  assert.deepEqual(fallback.inject, ['slots']);
  assert.equal(typeof fallback.apply, 'function');

  const withPrimitives = spec.factory(
    requireStub({
      react: reactStub(),
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null, MarkdownDelegateProvider: () => null },
    }),
  );
  assert.equal(typeof withPrimitives.apply, 'function');
});

test('apply installs the stylesheet, the sidebar entry, and the main panel', () => {
  const spec = registered.get('@local/dsh-project-notes');
  const module = spec.factory(requireStub({ react: reactStub() }));
  const { ctx, log } = clientContext();
  module.apply(ctx);

  const styles = styleTags.find((tag) => tag.id === 'dsh-project-notes-style');
  assert.ok(styles !== undefined, 'the panel stylesheet must be injected');
  assert.ok(styles.textContent.includes('.dsh-pn-row:hover'), 'hover lives in CSS, not in React state');
  assert.ok(styles.textContent.includes('var(--dsw-alias-'), 'colors must come from theme tokens');

  assert.deepEqual(log.effects, ['project-notes: styles', 'project-notes: sidebar entry', 'project-notes: main panel']);
  assert.deepEqual(log.injected, ['sidebar.panellist', 'main']);
  assert.deepEqual(
    log.registrations.map((row) => ({ name: row.name, key: row.key })),
    [
      { name: 'sidebar.panellist', key: 'project-notes' },
      { name: 'main', key: 'project-notes' },
    ],
  );
  assert.equal(typeof log.registrations[0].label, 'function', 'the sidebar carries a label thunk');
  assert.equal(typeof log.registrations[0].label(), 'string');
  assert.equal(log.registrations[1].label, undefined, 'the main panel needs no list label');
});

test('the sidebar label follows the locale service when one is present', () => {
  const spec = registered.get('@local/dsh-project-notes');
  const module = spec.factory(requireStub({ react: reactStub() }));
  const { ctx } = clientContext();
  const namespaces = [];
  let label;
  ctx.get = (key) =>
    key === 'locale'
      ? {
          register: (ns, dicts) => {
            namespaces.push({ ns, locales: Object.keys(dicts) });
            return () => {};
          },
          bind: (ns) => (key) => (key === 'title' ? `${ns}:translated` : key),
        }
      : undefined;
  ctx.slots.register = (options) => {
    if (options.name === 'sidebar.panellist') label = options.label;
    return () => {};
  };

  module.apply(ctx);
  assert.deepEqual(namespaces, [{ ns: 'projectNotes', locales: ['zh', 'en'] }]);
  assert.equal(label(), 'projectNotes:translated', 'the label must resolve through the bound namespace');
});

test('a reload keeps the stylesheet alive, and the last owner removes it', () => {
  const spec = registered.get('@local/dsh-project-notes');
  const first = spec.factory(requireStub({ react: reactStub() }));
  const second = spec.factory(requireStub({ react: reactStub() }));
  const one = clientContext();
  const two = clientContext();

  first.apply(one.ctx);
  assert.equal(styleTags.length, 1, 'the first load injects one tag');
  second.apply(two.ctx);
  assert.equal(styleTags.length, 1, 'a reload reuses the single tag');

  one.log.disposers[0](); // the predecessor is disposed after its successor claimed the tag
  assert.equal(styleTags.length, 1, 'a predecessor must not delete its successor stylesheet');

  two.log.disposers[0](); // a real uninstall
  assert.equal(styleTags.length, 0, 'the last owner removes the tag');
});
