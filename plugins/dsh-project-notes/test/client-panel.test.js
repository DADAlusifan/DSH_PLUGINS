/**
 * Behaviour suite for the Client half's panel.
 *
 * The wiring suite (`client.test.js`) proves registration; this one drives the
 * component through its real states and asserts what reaches the screen. Each
 * case below corresponds to a defect found while reviewing the plugin:
 * `MarkdownText` called without its required `labels` (any note with a code
 * fence crashed the preview), and a failed listing rendered as "no notes".
 *
 * The React stub is a minimal but honest hook runtime: state writes schedule a
 * re-render and effects run in order with dependency comparison, so the panel
 * walks from its fetch results to its rendered tree exactly as it would in the
 * browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

/** Specs the bundle registered, by module id. */
const registered = new Map();
/** Style tags the plugin injected. */
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

/** The primitives stub: the panel must pass real props to these. */
const primitives = {
  // eslint-disable-next-line no-unused-vars -- the stub never renders children.
  MarkdownText: function MarkdownText() {
    return null;
  },
  MarkdownDelegateProvider: function MarkdownDelegateProvider(props) {
    return props.children ?? null;
  },
};

await import('../client.js');

/**
 * Whether two dependency arrays are equal under `Object.is`.
 * @param left - the previous array, if any.
 * @param right - the next array.
 * @returns true when the effect may be skipped.
 */
function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
}

/**
 * A minimal hook runtime: one component, index-addressed hook slots, effects
 * with dependency comparison, and re-render on every state write.
 * @returns the renderer.
 */
function createRenderer() {
  const slots = [];
  let cursor = 0;
  let pendingEffects = [];
  let mounted = null;
  let tree = null;
  let scheduled = false;
  let flushing = false;

  const schedule = () => {
    if (flushing) {
      scheduled = true;
      return;
    }
    flush();
  };

  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    memo: (component) => component,
    useRef: (initial) => {
      const at = cursor++;
      slots[at] ??= { current: initial };
      return slots[at];
    },
    useState: (initial) => {
      const at = cursor++;
      slots[at] ??= { value: typeof initial === 'function' ? initial() : initial };
      const slot = slots[at];
      return [
        slot.value,
        (next) => {
          const resolved = typeof next === 'function' ? next(slot.value) : next;
          if (Object.is(resolved, slot.value)) return;
          slot.value = resolved;
          schedule();
        },
      ];
    },
    useEffect: (callback, deps) => {
      const at = cursor++;
      pendingEffects.push({ at, callback, deps });
    },
    useMemo: (factory, deps) => {
      const at = cursor++;
      const slot = slots[at];
      if (slot === undefined || !sameDeps(slot.deps, deps)) slots[at] = { deps, value: factory() };
      return slots[at].value;
    },
    useCallback: (callback, deps) => {
      const at = cursor++;
      const slot = slots[at];
      if (slot === undefined || !sameDeps(slot.deps, deps)) slots[at] = { deps, value: callback };
      return slots[at].value;
    },
    useDeferredValue: (value) => value,
  };

  /** Run this render's effects in call order, skipping unchanged dependencies. */
  function runEffects() {
    const effects = pendingEffects;
    pendingEffects = [];
    for (const effect of effects) {
      const slot = slots[effect.at];
      if (slot !== undefined && sameDeps(slot.deps, effect.deps)) continue;
      if (typeof slot?.cleanup === 'function') slot.cleanup();
      const cleanup = effect.callback();
      slots[effect.at] = { deps: effect.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
    }
  }

  function flush() {
    if (flushing) {
      scheduled = true;
      return;
    }
    flushing = true;
    try {
      do {
        scheduled = false;
        cursor = 0;
        pendingEffects = [];
        tree = mounted.component(mounted.props);
        runEffects();
      } while (scheduled);
    } finally {
      flushing = false;
    }
  }

  return {
    React,
    /**
     * Mount one component and render to a stable tree.
     * @param component - the component function.
     * @param props - its props.
     * @returns the rendered tree.
     */
    mount(component, props) {
      mounted = { component, props };
      flush();
      return tree;
    },
    /**
     * Let pending promise callbacks land, then render whatever they scheduled.
     * @param turns - microtask turns to drain.
     */
    async settle(turns = 12) {
      for (let index = 0; index < turns; index += 1) {
        await Promise.resolve();
        flush();
      }
    },
    /** @returns the current tree. */
    get tree() {
      return tree;
    },
  };
}

/**
 * Every element of one rendered tree, depth first.
 * @param node - the rendered node.
 * @returns the elements and strings found, in document order.
 */
function flatten(node) {
  const out = [];
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || value === undefined || typeof value === 'boolean') return;
    if (typeof value === 'string' || typeof value === 'number') {
      out.push(value);
      return;
    }
    if (typeof value !== 'object') return;
    out.push(value);
    walk(value.children);
  };
  walk(node);
  return out;
}

/**
 * All visible text of one rendered tree.
 * @param node - the rendered node.
 * @returns the concatenated text.
 */
function textOf(node) {
  return flatten(node)
    .filter((value) => typeof value === 'string')
    .join(' ');
}

/**
 * Every rendered element of one element type across a tree.
 * @param node - the rendered node.
 * @param type - the element type to collect.
 * @returns the matching elements.
 */
function elementsOfType(node, type) {
  return flatten(node).filter((value) => typeof value === 'object' && value.type === type);
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
        log.registrations.push({ name: options.name, key: options.id ?? options.key, component });
        return () => {};
      },
    },
  };
  return { ctx, log };
}

/**
 * A `useWorkspaces` standard seat over one fixed registry projection.
 *
 * The panel reads the workspace list from this seat rather than fetching it
 * (the framework owns that data), so the double answers the same snapshot shape
 * the renderer would: a stable object per state, `items` in registry order.
 * @param options - registry rows and the snapshot's phase/state.
 * @returns the hook.
 */
function workspaceSeat({ rows = [{ workspaceId: 'w1', path: 'D:\\ws', title: 'ws' }], phase = 'ready', state = 'idle' } = {}) {
  const snapshot = { items: rows, phase, state, error: null };
  return () => snapshot;
}

/**
 * The note payload a successful `/note` answers with.
 * @param text - the note's source.
 * @returns the JSON body.
 */
function noteBody(text) {
  return { path: 'a.md', name: 'a.md', text, size: text.length, truncated: false, limitBytes: 524288 };
}

/**
 * Mount the panel over a stub fetch, then drive it to a loaded note.
 * @param options - the note source, how `/notes` answers, and the workspace seat.
 * @returns the renderer, the panel tree, and every requested URL.
 */
async function mountPanel({ text = '# Title\n\nbody\n', notesFails = false, seat = workspaceSeat() } = {}) {
  const requested = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    requested.push(target);
    if (target.includes('/notes')) {
      if (notesFails) return { ok: false, status: 500, json: async () => ({ error: 'internal' }) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ workspace: 'w1', notes: [{ path: 'a.md', name: 'a.md', dir: '' }], truncated: false, limit: 800 }),
      };
    }
    return { ok: true, status: 200, json: async () => noteBody(text) };
  };

  const spec = registered.get('@local/dsh-project-notes');
  const renderer = createRenderer();
  const module = spec.factory((id) => {
    if (id === 'react') return renderer.React;
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`module not available: ${id}`);
  });
  const { ctx, log } = clientContext();
  module.apply(ctx);

  const registration = log.registrations.find((row) => row.name === 'main');
  assert.ok(registration !== undefined, 'the bundle must register its main panel');
  renderer.mount(registration.component, { useWorkspaces: seat });
  await renderer.settle();
  return { renderer, requested, ctx, log };
}

/**
 * Select the first note row in a rendered tree.
 * @param renderer - the renderer holding the tree.
 * @returns the selected path.
 */
async function selectFirstNote(renderer) {
  const row = flatten(renderer.tree).find(
    (value) => typeof value === 'object' && typeof value.props?.onSelect === 'function' && typeof value.props?.path === 'string',
  );
  assert.ok(row !== undefined, 'the loaded listing must render a selectable row');
  row.props.onSelect(row.props.path);
  await renderer.settle();
  return row.props.path;
}

test('the preview hands MarkdownText the required labels, so a code fence cannot crash it', async () => {
  const { renderer } = await mountPanel({ text: '# Title\n\n```js\nconst x = 1;\n```\n\n[^n]: footnote body\n' });
  await selectFirstNote(renderer);

  const [markdown] = elementsOfType(renderer.tree, primitives.MarkdownText);
  assert.ok(markdown !== undefined, 'a loaded note must render through the shipped MarkdownText');
  const labels = markdown.props.labels;
  assert.ok(labels !== undefined && labels !== null, 'MarkdownText requires labels; without them renderCode throws');
  assert.equal(typeof labels.code?.copyLabel, 'string');
  assert.ok(labels.code.copyLabel !== '', 'the copy label must resolve to visible text');
  assert.equal(typeof labels.code?.copiedLabel, 'string');
  assert.equal(typeof labels.code?.toolbarLabels?.codeLabel, 'string');
  assert.equal(typeof labels.code?.toolbarLabels?.wrapLabel, 'string');
  assert.equal(typeof labels.code?.toolbarLabels?.unwrapLabel, 'string');
  assert.equal(typeof labels.footnotes, 'string');
  assert.ok(labels.footnotes !== '', 'the footnotes label must resolve to visible text');
  assert.equal(markdown.props.text.includes('const x = 1;'), true, 'the note source still reaches the renderer');
});

test('the labels object keeps its identity across re-renders and follows a locale switch', async () => {
  const { renderer } = await mountPanel();
  await selectFirstNote(renderer);
  const first = elementsOfType(renderer.tree, primitives.MarkdownText)[0].props.labels;

  // An unrelated state write (the filter) must not mint a new labels object:
  // MarkdownText memoizes on it, so churn would rebuild its component table.
  const input = flatten(renderer.tree).find((value) => typeof value === 'object' && value.type === 'input');
  input.props.onChange({ target: { value: 'a' } });
  await renderer.settle();
  const second = elementsOfType(renderer.tree, primitives.MarkdownText)[0].props.labels;
  assert.equal(second, first, 'an unchanged locale must reuse one labels object');

  // Rebinding through a locale service re-resolves the shared common keys.
  const spec = registered.get('@local/dsh-project-notes');
  const renderer2 = createRenderer();
  const module = spec.factory((id) => {
    if (id === 'react') return renderer2.React;
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`module not available: ${id}`);
  });
  const { ctx: boundCtx, log } = clientContext();
  boundCtx.get = (key) =>
    key === 'locale'
      ? {
          register: () => () => {},
          bind: () => (name) => (name === 'copy' ? 'Kopieren' : name),
        }
      : undefined;
  module.apply(boundCtx);
  const registration = log.registrations.find((row) => row.name === 'main');
  renderer2.mount(registration.component, { useWorkspaces: workspaceSeat() });
  await renderer2.settle();
  await selectFirstNote(renderer2);
  const bound = elementsOfType(renderer2.tree, primitives.MarkdownText)[0].props.labels;
  assert.equal(bound.code.copyLabel, 'Kopieren', 'the labels must come from the bound locale namespace');
  assert.notEqual(bound.code.copyLabel, first.code.copyLabel);
});

test('a failed listing reports the failure instead of claiming the workspace has no notes', async () => {
  const { renderer } = await mountPanel({ notesFails: true });
  const text = textOf(renderer.tree);

  assert.equal(
    text.includes('当前工作区没有 Markdown 文件'),
    false,
    'a listing that never ran must not be reported as an empty workspace',
  );
  assert.ok(text.includes('加载失败'), `the failure must reach the screen, saw: ${text}`);
  const retry = flatten(renderer.tree).find(
    (value) => typeof value === 'object' && value.props?.label === '重试',
  );
  assert.ok(retry !== undefined, 'the failure state must offer a retry');
});

test('a workspace with no Markdown files still reports the empty workspace, not a failure', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ workspace: 'w1', notes: [], truncated: false, limit: 800 }),
  });
  const spec = registered.get('@local/dsh-project-notes');
  const renderer = createRenderer();
  const module = spec.factory((id) => {
    if (id === 'react') return renderer.React;
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`module not available: ${id}`);
  });
  const { ctx, log } = clientContext();
  module.apply(ctx);
  renderer.mount(log.registrations.find((row) => row.name === 'main').component, { useWorkspaces: workspaceSeat() });
  await renderer.settle();

  const text = textOf(renderer.tree);
  assert.ok(text.includes('当前工作区没有 Markdown 文件'), `an empty workspace is not a failure, saw: ${text}`);
  assert.equal(text.includes('加载失败'), false, 'an empty listing must not report a load failure');
});

test('an empty registry reports no workspace, and a failed one reports the failure', async () => {
  const empty = await mountPanel({ seat: workspaceSeat({ rows: [] }) });
  assert.ok(
    textOf(empty.renderer.tree).includes('没有已注册的工作区'),
    'a registry with no Workspace must say so rather than showing a bare list',
  );

  const failed = await mountPanel({ seat: workspaceSeat({ phase: 'pending', state: 'error' }) });
  const text = textOf(failed.renderer.tree);
  assert.ok(text.includes('加载失败'), `a failed registry read must surface, saw: ${text}`);
  assert.equal(text.includes('没有已注册的工作区'), false, 'a failure is not an empty registry');
});

test('the workspace list comes from the framework seat, not from a request of our own', async () => {
  const { renderer, requested } = await mountPanel();
  await selectFirstNote(renderer);
  assert.equal(
    requested.some((url) => url.includes('/state')),
    false,
    'the panel must not fetch a workspace list the renderer already supplies',
  );
  assert.deepEqual(
    [...new Set(requested.map((url) => new URL(url).pathname))].sort(),
    ['/api/project-notes/note', '/api/project-notes/notes'],
    'the panel reads only the two endpoints it owns',
  );
});
