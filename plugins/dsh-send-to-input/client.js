/**
 * @local/dsh-send-to-input — Client half (browser bundle).
 *
 * Adds one cell to the document preview's header toolbar, in the session-scoped
 * list slot `sidebar.right.tab.document.actions` (the shipped `open-in-app`
 * button lives in the same slot):
 *
 *   * 发送选中内容 — the text currently selected in the preview;
 *   * 发送整篇文件 — the previewed file's text, read through the session-scoped
 *     `remote.workspaceFiles` face (the Host's own confined file API).
 *
 * Both end up in the composer through the `inputActions` slot prop, which is
 * the platform's only public way to write into the draft:
 *
 *     const span = inputActions.captureInsertion();   // caret + draft revision
 *     inputActions.insertText(text, span);            // false when stale/busy
 *
 * The span must be captured in the same tick as the insert, and the selection
 * has to be remembered before the click, because pressing a button can drop the
 * DOM selection. `sendToInput.selection` exposes the same action as a keyboard
 * shortcut, which needs no selection menu at all.
 *
 * The Host half of this package is an intentional no-op: nothing here needs a
 * Host service, and the file read goes through the API the Host already guards.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-send-to-input',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** This plugin's cell key in the preview header toolbar. */
    const CELL_ID = 'send-to-input';
    /** The preview header toolbar slot. */
    const SLOT = 'sidebar.right.tab.document.actions';
    /** Locale namespace for the visible text. */
    const NS = 'sendToInput';
    /** Marker on the injected `<style>`, so only its own owner removes it. */
    const STYLE_ID = 'dsh-send-to-input-style';
    /** This load's claim on the stylesheet tag; a reload takes it over. */
    const styleToken = String(Math.random());
    /** The plugin stylesheet, rewritten on every load. */
    const CSS = `
.dsh-sti-group{display:inline-flex;align-items:center;gap:2px}
.dsh-sti-button{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);font:inherit;cursor:pointer}
.dsh-sti-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#e8e8e8)}
.dsh-sti-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}
.dsh-sti-button:disabled{opacity:.45;cursor:default}
.dsh-sti-glyph{font-size:14px;line-height:1}
.dsh-sti-hint{font-size:11px;white-space:nowrap;color:var(--dsw-alias-label-secondary,#9aa0a6)}
`;
    /** At most this much file text goes into one message. */
    const MAX_FILE_CHARS = 40000;
    /** Lines asked of the file API per page. */
    const PAGE_LINES = 5000;
    /** Hard cap on pages, so a huge file still answers quickly. */
    const MAX_PAGES = 12;
    /** How long a transient hint stays on screen. */
    const HINT_MS = 2600;

    /** Bundled dictionaries; the locale service overrides them when present. */
    const DICT = {
      zh: {
        sendSelection: '发送选中内容到输入框',
        sendFile: '发送整篇文件到输入框',
        sent: '已发送',
        truncated: '已发送（已截断）',
        noSelection: '请先选中内容',
        noPreview: '请先打开文件预览',
        noComposer: '没有可用的输入框',
        busy: '输入框正在提交',
        unavailable: '文件读取不可用',
        readFailed: '读取文件失败',
        noFile: '这个预览没有对应文件',
        empty: '文件没有文本内容',
      },
      en: {
        sendSelection: 'Send the selection to the input box',
        sendFile: 'Send the whole file to the input box',
        sent: 'Sent',
        truncated: 'Sent (truncated)',
        noSelection: 'Select some text first',
        noPreview: 'Open a file preview first',
        noComposer: 'No input box available',
        busy: 'The input box is submitting',
        unavailable: 'File reading is unavailable',
        readFailed: 'Could not read the file',
        noFile: 'This preview has no file behind it',
        empty: 'The file has no text content',
      },
    };

    /**
     * Fill `{name}` placeholders of one dictionary entry.
     * @param template - the entry text.
     * @param params - placeholder values.
     * @returns the rendered text.
     */
    function interpolate(template, params) {
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match));
    }

    /** Translate one key, falling back to the bundled Chinese dictionary. */
    let t = (key, params) => interpolate(DICT.zh[key] ?? key, params);

    /**
     * Load a shipped primitives export without making it a hard requirement.
     * @param requireFn - the bundle's `require`.
     * @param name - the export name.
     * @returns the export, or `null` when the module table has no such export.
     */
    function optionalExport(requireFn, name) {
      try {
        const table = requireFn('@deepseek-ai/dsh-client-ui-primitives');
        if (table === null || typeof table !== 'object') return null;
        const value = table[name];
        return value === undefined ? null : value;
      } catch {
        return null;
      }
    }

    const IconSend = optionalExport(require, 'IconSendOutlineRegular');
    const IconFile = optionalExport(require, 'IconDeliverDocRegular');

    /** The last non-empty selection made outside a form field or the composer. */
    let lastSelection = '';
    /**
     * The composer handle published by the mounted button. `inputActions` is a
     * slot prop rather than a service, so the keyboard shortcut reads the same
     * handle through this module-scope reference.
     */
    let liveComposer = null;

    // ------------------------------------------------------------- selection
    /**
     * The element a DOM node sits in.
     * @param node - a selection anchor or focus node.
     * @returns the owning element, or `null`.
     */
    function elementOf(node) {
      if (node === null || node === undefined) return null;
      if (typeof Element !== 'undefined' && node instanceof Element) return node;
      return node.parentElement ?? null;
    }

    /** Fields that are never a source: the composer and plain form controls. */
    const FORM_FIELDS = 'input, textarea, [contenteditable="true"]';

    /**
     * Classify the current DOM selection.
     *
     * `excluded` is deliberately distinct from `none`: a live pick inside the
     * composer means "the user is pointing somewhere else", and falling back to
     * an older preview selection then would send text they no longer mean.
     * @returns `{ kind: 'none' }`, `{ kind: 'excluded' }`, or `{ kind: 'text', text }`.
     */
    function selectionState() {
      if (typeof document === 'undefined' || typeof document.getSelection !== 'function') return { kind: 'none' };
      const selection = document.getSelection();
      if (selection === null || selection.rangeCount === 0) return { kind: 'none' };
      const text = selection.toString();
      if (text === '') return { kind: 'none' };
      const element = elementOf(selection.anchorNode);
      if (element !== null && typeof element.closest === 'function' && element.closest(FORM_FIELDS) !== null) {
        return { kind: 'excluded' };
      }
      return { kind: 'text', text };
    }

    /**
     * The current selection, ignoring the composer and other form fields.
     * @returns the selected text, empty when there is nothing usable.
     */
    function ownSelection() {
      const state = selectionState();
      return state.kind === 'text' ? state.text : '';
    }

    /**
     * The selection to send: the live one when it is usable, the last usable one
     * when the live selection is gone (a click can drop it), and nothing when the
     * user has since selected something this action must not touch.
     * @returns the text to send.
     */
    function rememberedSelection() {
      const state = selectionState();
      if (state.kind === 'text') return state.text;
      if (state.kind === 'excluded') return '';
      return lastSelection;
    }

    // --------------------------------------------------------------- payload
    /**
     * Wrap text as a fenced block headed by the file it came from, so the model
     * sees both the code and where it lives.
     * @param text - the text to send.
     * @param absolutePath - the previewed file, when the tab has one.
     * @returns the draft text.
     */
    function payloadFor(text, absolutePath) {
      const body = String(text).replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '');
      const path = typeof absolutePath === 'string' ? absolutePath : '';
      const match = /\.([A-Za-z0-9]{1,12})$/.exec(path);
      const info = match === null ? '' : match[1].toLowerCase();
      const head = path === '' ? '' : `${path}\n\n`;
      return `${head}\`\`\`${info}\n${body}\n\`\`\`\n`;
    }

    /**
     * Put one payload into the composer of a session.
     * @param handle - `{ inputActions, file }` of the mounted preview.
     * @param payload - the draft text.
     * @returns the dictionary key naming the outcome, `'sent'` on success.
     */
    function deliver(handle, payload) {
      if (handle === null || handle === undefined) return 'noComposer';
      const { inputActions } = handle;
      if (
        inputActions === undefined ||
        typeof inputActions.captureInsertion !== 'function' ||
        typeof inputActions.insertText !== 'function'
      ) {
        return 'noComposer';
      }
      try {
        // Same tick on purpose: the span carries the draft revision it was
        // taken at, and a mismatch makes `insertText` refuse the write.
        const span = inputActions.captureInsertion();
        return inputActions.insertText(payload, span) === false ? 'busy' : 'sent';
      } catch {
        return 'busy';
      }
    }

    /**
     * Read one previewed file through the session-scoped file API.
     * @param ctx - Client root context.
     * @param sessionId - the session that owns the preview.
     * @param absolutePath - the file to read.
     * @returns `{ text, truncated }`, or `{ error }` when it could not be read.
     */
    async function readFileText(ctx, sessionId, absolutePath) {
      const remote = ctx.get('remote');
      const files = remote === undefined ? undefined : remote.workspaceFiles;
      if (files === undefined || typeof files.read !== 'function') return { error: 'unavailable' };
      const controller = new AbortController();
      let text = '';
      let lines = 0;
      try {
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const chunk = await files.read(sessionId, absolutePath, { offset: lines, limit: PAGE_LINES }, controller.signal);
          if (chunk === null || chunk === undefined) break;
          text += typeof chunk.text === 'string' ? chunk.text : '';
          lines += typeof chunk.lines === 'number' ? chunk.lines : 0;
          if (chunk.eof === true || text.length >= MAX_FILE_CHARS) break;
        }
      } catch (failure) {
        const code = failure !== null && typeof failure === 'object' ? failure.code : undefined;
        return { error: typeof code === 'string' ? code : 'readFailed' };
      }
      const truncated = text.length > MAX_FILE_CHARS;
      return { text: truncated ? text.slice(0, MAX_FILE_CHARS) : text, truncated };
    }

    // ---------------------------------------------------------------- styles
    /**
     * Inject this plugin's stylesheet, refreshing it on every (re)load so an
     * edit is picked up by hot reload. The disposer only removes the tag while
     * this instance still owns it, so a reload's predecessor cannot delete the
     * stylesheet its successor just wrote — while a real uninstall still cleans
     * up after itself.
     * @returns the disposer releasing this instance's claim.
     */
    function insertStyles() {
      if (typeof document === 'undefined') return () => {};
      let element = document.getElementById(STYLE_ID);
      if (element === null) {
        element = document.createElement('style');
        element.id = STYLE_ID;
        document.head.append(element);
      }
      element.textContent = CSS;
      element.dataset.owner = styleToken;
      return () => {
        if (element.dataset.owner === styleToken) element.remove();
      };
    }

    // ------------------------------------------------------------- component
    /**
     * One header button.
     * @param props - `label` (also the tooltip), `icon`, `onClick`, `disabled`.
     * @returns the button element.
     */
    function iconButton({ label, icon, onClick, disabled }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-sti-button',
          title: label,
          'aria-label': label,
          disabled: disabled === true,
          onClick,
        },
        icon === null ? h('span', { className: 'dsh-sti-glyph', 'aria-hidden': true }, '→') : h(icon, { size: 16 }),
      );
    }

    /**
     * The preview header cell: send the selection, or send the whole file.
     * @param props - slot props: `inputActions` and `sessionId` from the slot's
     *   standard set, `absolutePath` from the preview owner (present exactly
     *   when the preview knows its file), and the `readFile` reader this plugin
     *   injects at registration.
     * @returns the rendered group.
     */
    function SendActions({ inputActions, sessionId, absolutePath, readFile }) {
      const [hint, setHint] = React.useState('');
      const [reading, setReading] = React.useState(false);
      const timer = React.useRef(null);

      React.useEffect(
        () => () => {
          if (timer.current !== null) clearTimeout(timer.current);
        },
        [],
      );

      const say = React.useCallback((key) => {
        setHint(t(key));
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setHint(''), HINT_MS);
      }, []);

      const hasFile = typeof absolutePath === 'string' && absolutePath !== '';
      const handle = inputActions === undefined ? null : { inputActions, file: hasFile ? absolutePath : null };

      // `inputActions` is a slot prop, not a service: the mounted button is the
      // only place that has it, so it publishes the handle for the shortcut.
      React.useEffect(() => {
        liveComposer = handle;
        return () => {
          if (liveComposer === handle) liveComposer = null;
        };
      }, [inputActions, sessionId, absolutePath]);

      /** Send what the user selected in the preview. */
      const sendSelection = React.useCallback(() => {
        const text = rememberedSelection();
        if (text.trim() === '') {
          say('noSelection');
          return;
        }
        const outcome = deliver(handle, payloadFor(text, absolutePath));
        if (outcome !== 'sent') say(outcome);
      }, [handle, absolutePath, say]);

      /** Send the whole previewed file, bounded by `MAX_FILE_CHARS`. */
      const sendFile = React.useCallback(async () => {
        if (!hasFile) {
          say('noFile');
          return;
        }
        if (typeof readFile !== 'function') {
          say('unavailable');
          return;
        }
        setReading(true);
        let result;
        try {
          result = await readFile(sessionId, absolutePath);
        } catch {
          // The reader reports its own failures; this only guards a foreign one.
          result = { error: 'readFailed' };
        }
        setReading(false);
        if (result.error !== undefined) {
          say(result.error === 'unavailable' ? 'unavailable' : 'readFailed');
          return;
        }
        if (result.text.trim() === '') {
          say('empty');
          return;
        }
        const outcome = deliver(handle, payloadFor(result.text, absolutePath));
        if (outcome !== 'sent') say(outcome);
        else if (result.truncated) say('truncated');
      }, [handle, hasFile, absolutePath, sessionId, readFile, say]);

      return h(
        'span',
        { className: 'dsh-sti-group' },
        iconButton({ label: t('sendSelection'), icon: IconSend, onClick: sendSelection, disabled: handle === null }),
        iconButton({ label: t('sendFile'), icon: IconFile, onClick: sendFile, disabled: handle === null || reading || !hasFile }),
        hint === '' ? null : h('span', { className: 'dsh-sti-hint', role: 'status' }, hint),
      );
    }

    // ------------------------------------------------------------------ plug
    /**
     * Mount the header cell, the selection tracker, and the shortcut.
     * @param ctx - Client root context.
     */
    function apply(ctx) {
      ctx.effect(() => insertStyles(), 'send-to-input: styles');

      const locale = ctx.get('locale');
      if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
        ctx.effect(() => locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'send-to-input: dictionaries');
        const bound = locale.bind(NS);
        t = (key, params) => {
          try {
            const value = bound(key, params);
            if (typeof value === 'string' && value !== '' && value !== key) return value;
          } catch {
            /* fall back to the bundled dictionary */
          }
          return interpolate(DICT.zh[key] ?? key, params);
        };
      }

      // Remember every usable selection, because the click that follows may
      // arrive after the browser has dropped it.
      ctx.effect(() => {
        const onChange = () => {
          const text = ownSelection();
          if (text !== '') lastSelection = text;
        };
        document.addEventListener('selectionchange', onChange);
        return () => document.removeEventListener('selectionchange', onChange);
      }, 'send-to-input: selection tracking');

      ctx.effect(
        () =>
          ctx.slots.inject(SLOT, () =>
            ctx.slots.register(
              {
                name: SLOT,
                id: CELL_ID,
                // A component cannot see the context its owner was mounted
                // with, so the file reader travels in the same way `inputActions`
                // does: as a slot prop.
                inject: () => ({ readFile: (sessionId, path) => readFileText(ctx, sessionId, path) }),
              },
              SendActions,
            ),
          ),
        'send-to-input: preview action',
      );

      ctx.inject(['shortcuts'], (shortcutCtx) => {
        shortcutCtx.effect(() => {
          try {
            return shortcutCtx.shortcuts.register({
              id: 'sendToInput.selection',
              label: () => t('sendSelection'),
              aliases: ['send selection to input', 'send to input'],
              defaults: {
                'desktop:macos': { code: 'KeyI', modifiers: ['primary', 'alt'] },
                'desktop:windows': { code: 'KeyI', modifiers: ['primary', 'alt'] },
                'desktop:linux': { code: 'KeyI', modifiers: ['primary', 'alt'] },
                'web:macos': { code: 'KeyI', modifiers: ['primary', 'alt'] },
                'web:windows': { code: 'KeyI', modifiers: ['primary', 'alt'] },
                'web:linux': { code: 'KeyI', modifiers: ['primary', 'alt'] },
              },
              regions: ['page', 'editable', 'terminal'],
              modals: [],
              resolve: () => {
                if (liveComposer === null) return { status: 'blocked', reason: t('noPreview') };
                const text = rememberedSelection();
                if (text.trim() === '') return { status: 'blocked', reason: t('noSelection') };
                return {
                  status: 'handled',
                  run: () => {
                    deliver(liveComposer, payloadFor(text, liveComposer.file));
                  },
                };
              },
            });
          } catch {
            // A shortcut that cannot register must not cost the user the button.
            return () => {};
          }
        }, 'send-to-input: shortcut');
      });
    }

    return { inject: ['slots'], apply };
  },
});
