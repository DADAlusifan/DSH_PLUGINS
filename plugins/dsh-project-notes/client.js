/**
 * @local/dsh-project-notes — Client half (browser bundle).
 *
 * Occupies two root-scoped seats of the Harness Web client:
 *   * `sidebar.panellist` — the 项目笔记 entry in the left sidebar, whose id
 *     addresses the matching `main` key, so the shell's own row handles
 *     selection (`ctx.layout.selectPanel`);
 *   * `main` key `project-notes` — the panel: the Markdown files of the
 *     current workspace on the left, the selected note previewed on the right.
 *
 * The panel reads its data from the Host half over the same origin
 * (`/api/project-notes/...`): exact routes on the shared authenticated `/api`
 * channel, so the connection fence admits every request. The workspace list is
 * not a request at all — the `main` slot's `useWorkspaces` seat supplies it.
 *
 * Markdown is rendered by the shipped `MarkdownText` primitive when the module
 * table exposes it (the web shell always loads `@deepseek-ai/dsh-client-ui-primitives`),
 * with the bundled renderer kept as a fallback. Wrapping it in
 * `MarkdownDelegateProvider` turns local `[note](./other.md)` destinations into
 * in-panel navigation.
 *
 * In-page navigation is panel-owned, because `MarkdownText` renders a
 * fragment-only destination as plain text: the outline rail and the heading
 * index extracted from the source drive `scrollIntoView`, and `[label](#anchor)`
 * is rewritten before rendering into the `<path>#L<n>` shape the renderer does
 * keep clickable, carrying the target heading's line number.
 *
 * Styling lives in one injected stylesheet written in `--dsw-alias-*` theme
 * tokens, so hover/focus/active states are CSS instead of per-row React state
 * and the panel follows light and dark themes.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-project-notes',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Sidebar entry id; also the `main` keyed-slot key. */
    const PANEL_ID = 'project-notes';
    /** Locale namespace for the panel's visible text. */
    const NS = 'projectNotes';
    /** Host API prefix: exact routes on the shared authenticated `/api` channel. */
    const API = '/api/project-notes';
    /** Id of this panel's injected stylesheet. */
    const STYLE_ID = 'dsh-project-notes-style';
    /** Give up on a stalled request rather than showing a spinner forever. */
    const REQUEST_TIMEOUT_MS = 15000;

    // The shipped primitives package is a static module-table entry, so this
    // resolves without being declared as a dependency. A missing or older
    // module must not break the panel: fall back to the bundled renderer.
    const primitives = (() => {
      try {
        const loaded = require('@deepseek-ai/dsh-client-ui-primitives');
        return loaded !== null && typeof loaded === 'object' ? loaded : null;
      } catch {
        return null;
      }
    })();
    const MarkdownText = primitives !== null && typeof primitives.MarkdownText === 'function' ? primitives.MarkdownText : null;
    const MarkdownDelegateProvider =
      primitives !== null && typeof primitives.MarkdownDelegateProvider === 'function' ? primitives.MarkdownDelegateProvider : null;

    const DICT = {
      zh: {
        title: '项目笔记',
        subtitle: '当前工作区的 Markdown 文件',
        refresh: '刷新',
        filter: '筛选文件…',
        files: '个文件',
        loading: '加载中…',
        previewEmpty: '从左侧选择一个 Markdown 文件进行预览',
        noNotes: '当前工作区没有 Markdown 文件',
        noMatches: '没有匹配的文件',
        noWorkspace: '没有已注册的工作区',
        truncated: '内容过长，仅显示前 {limit}',
        listTruncated: '文件过多，仅显示前 {limit} 个',
        listTruncatedDeep: '目录层级过深，部分文件未列出',
        notFound: '文件已不存在',
        unknownWorkspace: '工作区不可用',
        notANote: '不是可预览的 Markdown 文件',
        outsideWorkspace: '该文件位于工作区之外',
        unauthorized: '请求被拒绝，请刷新页面后重试',
        timeout: '请求超时',
        retry: '重试',
        loadFailed: '加载失败',
        workspace: '工作区',
        outline: '大纲',
        expandAll: '全部展开',
        collapseAll: '全部折叠',
      },
      en: {
        title: 'Project notes',
        subtitle: 'Markdown files of the current workspace',
        refresh: 'Refresh',
        filter: 'Filter files…',
        files: 'files',
        loading: 'Loading…',
        previewEmpty: 'Select a Markdown file on the left to preview it',
        noNotes: 'No Markdown file in this workspace',
        noMatches: 'No file matches the filter',
        noWorkspace: 'No registered workspace',
        truncated: 'Too long — showing the first {limit}',
        listTruncated: 'Too many files — showing the first {limit}',
        listTruncatedDeep: 'Directories nested too deep — some files are not listed',
        notFound: 'The file no longer exists',
        unknownWorkspace: 'Workspace unavailable',
        notANote: 'Not a previewable Markdown file',
        outsideWorkspace: 'That file lives outside the workspace',
        unauthorized: 'Request refused — reload the page and try again',
        timeout: 'The request timed out',
        retry: 'Retry',
        loadFailed: 'Failed to load',
        workspace: 'Workspace',
        outline: 'Outline',
        expandAll: 'Expand all',
        collapseAll: 'Collapse all',
      },
    };

    /**
     * Markdown chrome copy, keyed by the framework's shared `common`
     * vocabulary. These are deliberately NOT part of `DICT`: a bound locale
     * resolves them from the shipped `common` namespace (and any language pack
     * that overrides it), and this map only backs the no-locale-service path.
     */
    const CHROME = {
      zh: { copy: '复制', copied: '复制成功', 'codeBlock.title': '代码块', 'codeBlock.wrap': '自动换行', 'codeBlock.unwrap': '取消自动换行', 'markdown.footnotes': '脚注' },
      en: { copy: 'Copy', copied: 'Copied', 'codeBlock.title': 'Code block', 'codeBlock.wrap': 'Wrap lines', 'codeBlock.unwrap': 'Do not wrap lines', 'markdown.footnotes': 'Footnotes' },
    };

    /**
     * Fill `{name}` placeholders in one template.
     * @param template - the dictionary entry.
     * @param params - placeholder values.
     * @returns the visible text.
     */
    function interpolate(template, params) {
      if (params === undefined || params === null) return template;
      return String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    }

    /** Visible text lookup; rebound to the locale service during `apply`. */
    let t = (key, params) => interpolate(DICT.zh[key] ?? CHROME.zh[key] ?? key, params);

    // --------------------------------------------------------------- styles
    const CSS = `
.dsh-pn-root{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;color:var(--dsw-alias-label-primary,#e8e8e8);font:inherit;padding-top:var(--dsh-frame-top-clearance,0px)}
.dsh-pn-header{display:flex;align-items:center;gap:12px;padding:14px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));flex:0 0 auto}
.dsh-pn-heading{min-width:0}
.dsh-pn-title{font-size:15px;font-weight:600}
.dsh-pn-subtitle{font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa0a6);margin-top:2px}
.dsh-pn-spacer{flex:1 1 auto}
.dsh-pn-field{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa0a6)}
.dsh-pn-count{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa0a6);white-space:nowrap}
.dsh-pn-control{height:28px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.07));color:inherit;font:inherit;font-size:12.5px;padding:0 8px}
.dsh-pn-button{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));background:transparent;color:inherit;font:inherit;font-size:12.5px;cursor:pointer;transition:background 120ms ease}
.dsh-pn-button:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.13))}
.dsh-pn-button:focus-visible,.dsh-pn-control:focus-visible,.dsh-pn-input:focus-visible,.dsh-pn-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}
.dsh-pn-body{display:flex;flex:1 1 auto;min-height:0}
.dsh-pn-list{flex:0 0 268px;min-width:0;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25))}
.dsh-pn-list-head{padding:10px 12px 6px;flex:0 0 auto}
.dsh-pn-list-head-row{display:flex;align-items:center;gap:6px}
.dsh-pn-folder{display:flex;align-items:center;gap:6px;width:100%;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);font:inherit;font-size:11.5px;font-weight:600;letter-spacing:.2px;padding:5px 10px;margin:1px 0;border-radius:6px;cursor:pointer;overflow:hidden}
.dsh-pn-folder:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.07));color:var(--dsw-alias-label-primary,#e8e8e8)}
.dsh-pn-folder:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-2px}
.dsh-pn-folder-chevron{flex:0 0 auto;width:10px;font-size:9px;opacity:.85}
.dsh-pn-folder-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-pn-folder-count{flex:0 0 auto;font-weight:400;font-variant-numeric:tabular-nums}
.dsh-pn-input{box-sizing:border-box;height:28px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.07));color:inherit;font:inherit;font-size:12.5px;padding:0 9px;outline:none}
.dsh-pn-list-head-row .dsh-pn-input{flex:1 1 auto;min-width:0;width:auto}
.dsh-pn-scroll{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:0 8px 12px;min-height:0}
.dsh-pn-row{display:block;width:100%;text-align:left;padding:6px 10px;margin:1px 0;border-radius:7px;border:0;background:transparent;color:var(--dsw-alias-label-primary,#e8e8e8);font:inherit;font-size:12.5px;cursor:pointer}
.dsh-pn-row:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.07))}
.dsh-pn-row[aria-current=true]{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.13));box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary,#4d6bfe)}
.dsh-pn-row-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-pn-row-dir{display:block;color:var(--dsw-alias-label-secondary,#9aa0a6);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-pn-note{flex:1 1 auto;min-width:0;min-height:0;display:flex}
.dsh-pn-scrollpane{flex:1 1 auto;min-width:0;min-height:0;overflow-y:auto;display:flex;flex-direction:column}
.dsh-pn-outline{flex:0 0 176px;min-width:0;border-left:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));overflow-y:auto;padding:14px 10px 28px}
.dsh-pn-outline-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#9aa0a6);letter-spacing:.2px;padding:0 6px 6px}
.dsh-pn-outline-item{display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);font:inherit;font-size:11.5px;line-height:1.55;padding:3px 6px;border-radius:6px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-pn-outline-item:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.07));color:var(--dsw-alias-label-primary,#e8e8e8)}
.dsh-pn-outline-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}
.dsh-pn-outline-item[aria-current=true]{color:var(--dsw-alias-label-primary,#e8e8e8);background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.13))}
.dsh-pn-doc-head-actions{display:flex;align-items:center;gap:8px;white-space:nowrap}
.dsh-pn-doc [class*=fileLink],.dsh-pn-doc [class*=fileMention]{display:inline;border:0;background:none;padding:0;color:var(--dsw-alias-brand-primary,#4d6bfe);font:inherit;font-size:inherit;line-height:inherit;cursor:pointer;text-decoration:none}
.dsh-pn-doc [class*=fileLink]:hover,.dsh-pn-doc [class*=fileMention]:hover{text-decoration:underline}
.dsh-pn-doc [class*=fileLink] svg,.dsh-pn-doc [class*=fileMention] svg{display:none}
.dsh-pn-doc{padding:18px 26px 40px;max-width:860px;width:100%;box-sizing:border-box;margin:0 auto}
.dsh-pn-doc-head{display:flex;align-items:baseline;gap:10px;padding-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));margin-bottom:6px}
.dsh-pn-doc-path{font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-pn-doc-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa0a6);white-space:nowrap}
.dsh-pn-banner{margin:8px 0 0;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.13));color:var(--dsw-alias-label-secondary,#9aa0a6);font-size:11.5px}
.dsh-pn-footer{padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0a6)}
.dsh-pn-message{margin:auto;padding:0 20px;color:var(--dsw-alias-label-secondary,#9aa0a6);font-size:13px;text-align:center}
.dsh-pn-error{color:var(--dsw-alias-state-error-primary,#e05252)}
.dsh-pn-link{color:var(--dsw-alias-brand-primary,#4d6bfe);text-decoration:none;cursor:pointer}
.dsh-pn-fallback{line-height:1.75}
`;

    /** Identifies the stylesheet tag this bundle instance owns. */
    const styleToken = `pn-${Math.random().toString(36).slice(2)}`;

    /**
     * Install the panel stylesheet, refreshing it on every (re)load so an edit
     * is picked up by hot reload. The disposer only removes the tag when this
     * instance still owns it, so a reload's predecessor cannot delete the
     * stylesheet its successor just wrote — while a real uninstall still
     * cleans up after itself.
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

    // ----------------------------------------------------------------- data
    /**
     * Call one Host endpoint, cancellable and time-bounded.
     * @param endpoint - path below the API prefix.
     * @param params - optional query parameters.
     * @param signal - the caller's abort signal.
     * @returns the parsed JSON body.
     */
    async function api(endpoint, params, signal) {
      const url = new URL(`${API}${endpoint}`, window.location.origin);
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
      const timeout =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;
      const combined =
        timeout !== undefined && signal !== undefined && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([signal, timeout])
          : (signal ?? timeout);
      let response;
      try {
        response = await fetch(url.toString(), { headers: { accept: 'application/json' }, signal: combined });
      } catch (failure) {
        if (signal?.aborted === true) throw failure;
        throw new Error(failure instanceof Error && failure.name === 'TimeoutError' ? 'timeout' : 'loadFailed');
      }
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        const code = body !== null && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
        throw new Error(code);
      }
      return body ?? {};
    }

    /** Map a Host error code to visible text. */
    function messageOf(error) {
      const raw = error instanceof Error ? error.message : String(error);
      const known = {
        'unknown-workspace': 'unknownWorkspace',
        'not-found': 'notFound',
        'missing-path': 'notFound',
        'not-a-note': 'notANote',
        'outside-workspace': 'outsideWorkspace',
        unauthorized: 'unauthorized',
        timeout: 'timeout',
        unreadable: 'loadFailed',
        internal: 'loadFailed',
        loadFailed: 'loadFailed',
      };
      const key = known[raw];
      return key === undefined ? (raw === '' ? t('loadFailed') : raw) : t(key);
    }

    /** Compact byte size. */
    function formatSize(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    /**
     * Resolve a Markdown link destination against the note that contains it.
     * @param from - the current note's workspace-relative path.
     * @param target - the raw href.
     * @returns the workspace-relative target, or null when it is not a local note.
     */
    function resolveRelativeNote(from, target) {
      const value = String(target ?? '').trim();
      if (value === '' || value.startsWith('#') || value.startsWith('//')) return null;
      if (/^[a-z][a-z\d+.-]*:/i.test(value)) return null;
      const clean = value.split('#')[0].split('?')[0];
      const base = value.startsWith('/') || from === null ? [] : (from.includes('/') ? from.slice(0, from.lastIndexOf('/')).split('/') : []);
      const parts = clean.replace(/^\/+/, '').split('/');
      const out = [];
      for (const part of base.concat(parts)) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
          if (out.length === 0) return null;
          out.pop();
          continue;
        }
        out.push(part);
      }
      return out.length === 0 ? null : out.join('/');
    }

    /**
     * Whether a link target is one the preview may navigate to itself.
     * @param value - the raw href.
     * @returns true for local destinations.
     */
    function isLocalTarget(value) {
      return value !== '' && !/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith('#') && !value.startsWith('//');
    }

    // --------------------------------------------------- anchors and outline
    /**
     * Decode one percent-encoded fragment.
     * @param value - the raw fragment.
     * @returns the decoded fragment.
     */
    function decodeAnchor(value) {
      try {
        return decodeURIComponent(value);
      } catch {
        return String(value ?? '');
      }
    }

    /**
     * Normalize a heading or an `#anchor` into one comparable key.
     *
     * Close to the GitHub anchor shape, but tolerant: punctuation is dropped
     * and CJK survives, so `#安装`, `#安装-1` and a hand-written
     * `#%E5%AE%89%E8%A3%85` all still match their heading.
     * @param value - heading text or anchor.
     * @returns the comparison key.
     */
    function anchorKey(value) {
      return String(value ?? '')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_~]/g, '')
        .trim()
        .toLowerCase()
        .replace(/[\s\u3000]+/g, '-')
        .replace(/[^\p{L}\p{N}\-_]/gu, '');
    }

    /**
     * Collect the ATX headings of one note, skipping fenced code.
     * @param source - the note text.
     * @returns heading rows in document order, each with its duplicate ordinal.
     */
    function parseOutline(source) {
      const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
      const headings = [];
      let fenced = false;
      let marker = '';
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const fence = /^\s*(```+|~~~+)/.exec(line);
        if (fence !== null) {
          const character = fence[1][0];
          if (!fenced) {
            fenced = true;
            marker = character;
          } else if (character === marker) {
            fenced = false;
          }
          continue;
        }
        if (fenced) continue;
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading === null) continue;
        const text = heading[2].replace(/\s+#+\s*$/, '').trim();
        const key = anchorKey(text);
        headings.push({
          depth: heading[1].length,
          text,
          line: index + 1,
          index: headings.length,
          ordinal: headings.filter((row) => anchorKey(row.text) === key).length,
        });
      }
      return headings;
    }

    /**
     * Resolve an `#anchor` to one heading, including GitHub's `-1` duplicates.
     * @param headings - the parsed outline.
     * @param anchor - the raw fragment.
     * @returns the matching heading, or null.
     */
    function resolveAnchor(headings, anchor) {
      const wanted = anchorKey(decodeAnchor(anchor));
      if (wanted === '') return null;
      const direct = headings.find((candidate) => anchorKey(candidate.text) === wanted);
      if (direct !== undefined) return direct;
      const suffix = /^(.*)-(\d+)$/.exec(wanted);
      if (suffix !== null) {
        const base = headings.filter((candidate) => anchorKey(candidate.text) === suffix[1]);
        const found = base[Number(suffix[2]) - 1];
        if (found !== undefined) return found;
      }
      const loose = wanted.replace(/-/g, '');
      return headings.find((candidate) => anchorKey(candidate.text).replace(/-/g, '') === loose) ?? null;
    }

    /**
     * The heading elements of one rendered document, both renderers included.
     * @param box - the scroll container.
     * @returns the heading elements in document order.
     */
    function headingNodes(box) {
      return box === null ? [] : [...box.querySelectorAll('h1,h2,h3,h4,h5,h6,.dsh-pn-h')];
    }

    // ------------------------------------------------------------ note tree
    /** Note counts above this start with every folder collapsed. */
    const AUTO_COLLAPSE_ABOVE = 80;

    /**
     * Build the directory tree of one note listing.
     * @param rows - note rows carrying `dir` and `name`.
     * @returns the root node, whose `depth` is -1.
     */
    function buildTree(rows) {
      const root = { name: '', path: '', depth: -1, dirs: new Map(), files: [], total: rows.length };
      for (const row of rows) {
        const parts = row.dir === '' ? [] : row.dir.split('/');
        let node = root;
        let prefix = '';
        for (const part of parts) {
          prefix = prefix === '' ? part : `${prefix}/${part}`;
          let child = node.dirs.get(part);
          if (child === undefined) {
            child = { name: part, path: prefix, depth: node.depth + 1, dirs: new Map(), files: [], total: 0 };
            node.dirs.set(part, child);
          }
          child.total += 1;
          node = child;
        }
        node.files.push(row);
      }
      return root;
    }

    /**
     * Every folder path of one listing.
     * @param rows - note rows carrying `dir`.
     * @returns the folder paths.
     */
    function folderPaths(rows) {
      const paths = new Set();
      for (const row of rows) {
        if (row.dir === '') continue;
        let prefix = '';
        for (const part of row.dir.split('/')) {
          prefix = prefix === '' ? part : `${prefix}/${part}`;
          paths.add(prefix);
        }
      }
      return paths;
    }

    /**
     * The folders that contain one note path.
     * @param relative - a workspace-relative note path.
     * @returns the ancestor folder paths, outermost first.
     */
    function ancestorPaths(relative) {
      const parts = String(relative ?? '').split('/');
      const out = [];
      let prefix = '';
      for (let at = 0; at < parts.length - 1; at += 1) {
        prefix = prefix === '' ? parts[at] : `${prefix}/${parts[at]}`;
        out.push(prefix);
      }
      return out;
    }

    /**
     * Rewrite `[label](#anchor)` so the shipped renderer keeps it clickable.
     *
     * `MarkdownText` renders a fragment-only destination as plain text, but it
     * does turn `<path>#L<n>` into a file link and hand it to `openFile`. The
     * target heading's own line number is therefore the carrier that survives
     * the renderer, and fenced code plus inline code stay untouched.
     * @param source - the note text.
     * @param headings - the parsed outline.
     * @param selfName - the current note's name relative to its own directory.
     * @returns the text to render.
     */
    function transformAnchors(source, headings, selfName) {
      if (headings.length === 0 || selfName === '') return source;
      const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
      let fenced = false;
      let marker = '';
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const fence = /^\s*(```+|~~~+)/.exec(line);
        if (fence !== null) {
          const character = fence[1][0];
          if (!fenced) {
            fenced = true;
            marker = character;
          } else if (character === marker) {
            fenced = false;
          }
          continue;
        }
        if (fenced || !line.includes('](#')) continue;
        lines[index] = line.replace(/\]\(#([^)\s]*)\)/g, (match, anchor, offset) => {
          if ((line.slice(0, offset).split('`').length - 1) % 2 === 1) return match;
          const resolved = resolveAnchor(headings, anchor);
          return resolved === null ? match : `](${encodeURIComponent(selfName)}#L${resolved.line})`;
        });
      }
      return lines.join('\n');
    }

    // ------------------------------------------------------------- markdown
    /** Last labels object and the copy key that produced it. */
    const labelsCache = { key: null, value: null };

    /**
     * The `MarkdownText` chrome for the active locale.
     *
     * The identity is stable while the resolved copy is unchanged: the renderer
     * memoizes on `labels`, so a fresh object per render would rebuild its
     * component table. The cache key is the resolved copy itself, so a locale
     * switch (or a late dictionary) mints exactly one new object.
     * @returns labels for code fences and footnotes.
     */
    function markdownLabels() {
      const copyLabel = t('copy');
      const copiedLabel = t('copied');
      const codeLabel = t('codeBlock.title');
      const wrapLabel = t('codeBlock.wrap');
      const unwrapLabel = t('codeBlock.unwrap');
      const footnotes = t('markdown.footnotes');
      const key = [copyLabel, copiedLabel, codeLabel, wrapLabel, unwrapLabel, footnotes].join('\u0000');
      if (labelsCache.key !== key) {
        labelsCache.key = key;
        labelsCache.value = {
          code: { copyLabel, copiedLabel, toolbarLabels: { codeLabel, wrapLabel, unwrapLabel } },
          footnotes,
        };
      }
      return labelsCache.value;
    }

    const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|~~[^~]+~~|\[[^\]]*\]\([^)\s]*\))/g;

    /**
     * Accept only link targets a preview may follow.
     * @param target - raw link target.
     * @returns the href, or null when the scheme is not allowed.
     */
    function safeHref(target) {
      const value = String(target).trim();
      return /^(https?:\/\/|mailto:|#|\/)/i.test(value) ? value : null;
    }

    /**
     * Render one line of inline Markdown as React nodes.
     * @param text - the source line.
     * @param seed - key prefix.
     * @returns React children.
     */
    function renderInline(text, seed) {
      const nodes = [];
      let cursor = 0;
      let index = 0;
      const pattern = new RegExp(INLINE.source, 'g');
      let match;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
        const token = match[0];
        const key = `${seed}-${index++}`;
        if (token.startsWith('`')) {
          nodes.push(h('code', { key, style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '0.92em', background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.13))', borderRadius: 4, padding: '1px 4px' } }, token.slice(1, -1)));
        } else if (token.startsWith('**') || token.startsWith('__')) {
          nodes.push(h('strong', { key }, token.slice(2, -2)));
        } else if (token.startsWith('~~')) {
          nodes.push(h('del', { key, style: { opacity: 0.68 } }, token.slice(2, -2)));
        } else if (token.startsWith('*') || token.startsWith('_')) {
          nodes.push(h('em', { key }, token.slice(1, -1)));
        } else {
          const split = token.indexOf('](');
          const label = token.slice(1, split);
          const target = token.slice(split + 2, -1);
          const href = safeHref(target);
          if (href !== null && href.startsWith('#')) {
            nodes.push(h('a', { key, className: 'dsh-pn-link', href }, label));
          } else if (href !== null) {
            nodes.push(h('a', { key, className: 'dsh-pn-link', href, target: '_blank', rel: 'noreferrer' }, label));
          } else if (isLocalTarget(target)) {
            nodes.push(h('a', { key, className: 'dsh-pn-link', href: target, title: target }, label));
          } else {
            nodes.push(label);
          }
        }
        cursor = match.index + token.length;
      }
      if (cursor < text.length) nodes.push(text.slice(cursor));
      return nodes.length === 0 ? '' : nodes;
    }

    /** Split a table row into cells. */
    function splitRow(line) {
      return line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim());
    }

    const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

    /**
     * Parse one list block, including sub-lists nested by indentation.
     * @param lines - source lines.
     * @param start - index of the list's first item.
     * @returns the ordered flag, the entries, and the next unread line.
     */
    function parseList(lines, start) {
      const head = LIST_ITEM.exec(lines[start]);
      const baseIndent = head[1].length;
      const ordered = /\d/.test(head[2][0]);
      const entries = [];
      let i = start;
      while (i < lines.length) {
        const item = LIST_ITEM.exec(lines[i]);
        if (item === null) {
          const continuation = entries.length > 0 && /^\s+\S/.test(lines[i]);
          if (!continuation) break;
          entries[entries.length - 1].text += ` ${lines[i].trim()}`;
          i++;
          continue;
        }
        const indent = item[1].length;
        if (indent < baseIndent) break;
        if (indent > baseIndent) {
          const nested = parseList(lines, i);
          if (entries.length > 0) entries[entries.length - 1].nested.push(nested);
          i = nested.next;
          continue;
        }
        if (/\d/.test(item[2][0]) !== ordered) break;
        entries.push({ text: item[3], nested: [] });
        i++;
      }
      return { ordered, entries, next: i };
    }

    /**
     * Build a list element from a parsed list.
     * @param parsed - the parsed list.
     * @param seed - React key prefix.
     * @returns the list element.
     */
    function buildList(parsed, seed) {
      return h(
        parsed.ordered ? 'ol' : 'ul',
        { key: seed, style: { margin: '8px 0', paddingLeft: 22, lineHeight: 1.7 } },
        parsed.entries.map((entry, at) =>
          h(
            'li',
            { key: at, style: { margin: '2px 0' } },
            renderInline(entry.text, `${seed}-${at}`),
            entry.nested.length === 0 ? null : entry.nested.map((child, at2) => buildList(child, `${seed}-${at}-${at2}`)),
          ),
        ),
      );
    }

    /** Whether a line opens a block (and so ends a paragraph). */
    function opensBlock(line) {
      return (
        /^\s*(```|~~~)/.test(line) ||
        /^(#{1,6})\s+/.test(line) ||
        /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
        /^\s*>/.test(line) ||
        /^\s*([-*+]|\d+[.)])\s+/.test(line)
      );
    }

    /**
     * Render Markdown source as React nodes.
     *
     * Used only when the shipped `MarkdownText` primitive is unavailable; the
     * panel prefers the platform renderer whenever the module table has it.
     * @param source - the note text.
     * @returns React children.
     */
    function renderMarkdown(source) {
      const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
      const blocks = [];
      let key = 0;
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (/^\s*$/.test(line)) {
          i++;
          continue;
        }
        const fence = /^\s*(```+|~~~+)\s*(.*)$/.exec(line);
        if (fence !== null) {
          const marker = fence[1][0];
          const closing = new RegExp(`^\\s*${marker}{3,}\\s*$`);
          const body = [];
          i++;
          while (i < lines.length && !closing.test(lines[i])) {
            body.push(lines[i]);
            i++;
          }
          i++;
          blocks.push(
            h(
              'pre',
              { key: `b${key++}`, style: { background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.13))', border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))', borderRadius: 8, padding: '10px 12px', overflowX: 'auto', margin: '10px 0' } },
              h('code', { style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12.5, lineHeight: 1.55 } }, body.join('\n')),
            ),
          );
          continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading !== null) {
          const level = heading[1].length;
          const size = [24, 20, 17, 15, 13.5, 13][level - 1];
          blocks.push(
            h(
              'div',
              {
                key: `b${key++}`,
                className: 'dsh-pn-h',
                style: {
                  fontSize: size,
                  fontWeight: level <= 3 ? 650 : 600,
                  margin: level <= 2 ? '18px 0 8px' : '14px 0 6px',
                  paddingBottom: level <= 2 ? 6 : 0,
                  borderBottom: level <= 2 ? '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))' : 'none',
                  lineHeight: 1.35,
                },
              },
              renderInline(heading[2].replace(/\s+#+\s*$/, ''), `h${key}`),
            ),
          );
          i++;
          continue;
        }
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          blocks.push(h('hr', { key: `b${key++}`, style: { border: 'none', borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))', margin: '16px 0' } }));
          i++;
          continue;
        }
        if (/^\s*>/.test(line)) {
          const body = [];
          while (i < lines.length && /^\s*>/.test(lines[i])) {
            body.push(lines[i].replace(/^\s*>\s?/, ''));
            i++;
          }
          blocks.push(
            h(
              'blockquote',
              { key: `b${key++}`, style: { borderLeft: '3px solid var(--dsw-alias-border-l2, rgba(128,128,128,.42))', margin: '10px 0', padding: '2px 0 2px 12px', color: 'var(--dsw-alias-label-secondary, #9aa0a6)' } },
              renderMarkdown(body.join('\n')),
            ),
          );
          continue;
        }
        const bullet = LIST_ITEM.exec(line);
        if (bullet !== null) {
          const parsed = parseList(lines, i);
          blocks.push(buildList(parsed, `b${key++}`));
          i = parsed.next;
          continue;
        }
        if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
          const header = splitRow(line);
          i += 2;
          const rows = [];
          while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
            rows.push(splitRow(lines[i]));
            i++;
          }
          const cell = { border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))', padding: '6px 10px', textAlign: 'left', verticalAlign: 'top' };
          blocks.push(
            h(
              'div',
              { key: `b${key++}`, style: { overflowX: 'auto', margin: '10px 0' } },
              h(
                'table',
                { style: { borderCollapse: 'collapse', fontSize: 13 } },
                h(
                  'thead',
                  null,
                  h('tr', null, header.map((value, at) => h('th', { key: at, style: { ...cell, background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.13))', fontWeight: 600 } }, renderInline(value, `th${at}`)))),
                ),
                h(
                  'tbody',
                  null,
                  rows.map((row, at) =>
                    h('tr', { key: at }, header.map((_, column) => h('td', { key: column, style: cell }, renderInline(row[column] ?? '', `td${at}-${column}`)))),
                  ),
                ),
              ),
            ),
          );
          continue;
        }
        const paragraph = [line];
        i++;
        while (i < lines.length && !/^\s*$/.test(lines[i]) && !opensBlock(lines[i])) {
          paragraph.push(lines[i]);
          i++;
        }
        blocks.push(h('p', { key: `b${key++}`, style: { margin: '9px 0', lineHeight: 1.75 } }, renderInline(paragraph.join(' '), `p${key}`)));
      }
      return blocks;
    }

    // -------------------------------------------------------------- controls
    /** A token-styled button. */
    function IconButton({ label, onClick }) {
      return h('button', { type: 'button', className: 'dsh-pn-button', title: label, 'aria-label': label, onClick }, label);
    }

    /**
     * The sidebar glyph: a note with lines.
     *
     * The owner also passes `active`, which shipped panel icons deliberately
     * ignore — the sidebar row owns the selected/hover/focus treatment.
     * @param props - the icon owner props.
     * @returns the glyph.
     */
    function NotesIcon({ size = 16 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M4 2.25h4.9L12.5 5.9v7.85a.75.75 0 0 1-.75.75h-7.5a.75.75 0 0 1-.75-.75V3a.75.75 0 0 1 .75-.75Z',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M8.75 2.4v3.6h3.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round' }),
        h('path', { d: 'M5.9 9.1h4.2M5.9 11.4h4.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
      );
    }

    /** One row of the note list, indented by its depth in the tree. */
    const NoteRow = React.memo(function NoteRow({ path, name, dir, depth = 0, showDir = false, active, onSelect }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-pn-row',
          style: { paddingLeft: 10 + depth * 12 },
          'aria-current': active ? 'true' : undefined,
          onClick: () => onSelect(path),
          title: path,
        },
        h('span', { className: 'dsh-pn-row-name' }, name),
        showDir && dir !== '' ? h('span', { className: 'dsh-pn-row-dir' }, dir) : null,
      );
    });

    // ----------------------------------------------------------------- panel
    /** Panel memory that outlives a switch to another main panel. */
    const remembered = { workspace: null, path: null, filter: '', outline: true };

    /** The `main` panel: note list plus Markdown preview. */
    function NotesPanel({ useWorkspaces }) {
      const [workspace, setWorkspace] = React.useState(remembered.workspace);
      const [notes, setNotes] = React.useState([]);
      const [listPhase, setListPhase] = React.useState('loading');
      const [listError, setListError] = React.useState(null);
      const [listLimit, setListLimit] = React.useState(null);
      const [listTruncated, setListTruncated] = React.useState(false);
      const [filter, setFilter] = React.useState(remembered.filter);
      const [selected, setSelected] = React.useState(remembered.path);
      const [note, setNote] = React.useState(null);
      const [notePhase, setNotePhase] = React.useState('idle');
      const [tick, setTick] = React.useState(0);
      const [showOutline, setShowOutline] = React.useState(remembered.outline);
      const [activeHeading, setActiveHeading] = React.useState(0);
      /** Folder paths the user folded away. */
      const [collapsed, setCollapsed] = React.useState(() => new Set());
      /** The scrolling pane holding the rendered document. */
      const scrollRef = React.useRef(null);
      /** A heading line to reach once a freshly opened note has rendered. */
      const pendingLine = React.useRef(null);

      const deferredFilter = React.useDeferredValue(filter);

      React.useEffect(() => {
        remembered.filter = filter;
      }, [filter]);
      React.useEffect(() => {
        remembered.path = selected;
      }, [selected]);
      React.useEffect(() => {
        remembered.workspace = workspace;
      }, [workspace]);

      // The workspace list is framework data, not ours to fetch: the `main`
      // slot's `useWorkspaces` seat carries the live registry projection in its
      // own display order, so a rename, a reorder, an add, or a removal lands
      // here without a request and without a stale dropdown. Each row's
      // `workspaceId` is the same durable id the Host registry accepts.
      const workspaceSnapshot = useWorkspaces((state) => state);
      const workspaces = React.useMemo(
        () =>
          workspaceSnapshot.items.map((row) => ({
            key: String(row.workspaceId),
            title: typeof row.title === 'string' && row.title !== '' ? row.title : String(row.path ?? ''),
            path: row.path,
          })),
        [workspaceSnapshot.items],
      );

      // Selection follows the registry: keep the remembered workspace while it
      // still exists, otherwise take the first registered one.
      React.useEffect(() => {
        setWorkspace((current) => {
          if (current !== null && workspaces.some((row) => row.key === current)) return current;
          return workspaces.length === 0 ? null : workspaces[0].key;
        });
      }, [workspaces]);

      // Derived, not synced: the snapshot is the authority on whether the
      // registry is still loading, empty, or failed.
      const phase =
        workspaceSnapshot.phase !== 'ready'
          ? workspaceSnapshot.state === 'error' ? 'error' : 'loading'
          : workspaces.length === 0 ? 'empty' : 'ready';

      React.useEffect(() => {
        if (workspace === null) {
          setNotes([]);
          setListLimit(null);
          setListTruncated(false);
          setListError(null);
          setListPhase('ready');
          return undefined;
        }
        const controller = new AbortController();
        setListPhase('loading');
        setListError(null);
        api('/notes', { workspace }, controller.signal)
          .then((body) => {
            if (controller.signal.aborted) return;
            const rows = Array.isArray(body.notes) ? body.notes : [];
            setNotes(rows);
            setListLimit(typeof body.limit === 'number' ? body.limit : null);
            setListTruncated(body.truncated === true);
            setListError(null);
            setListPhase('ready');
            setSelected((current) => (current !== null && rows.some((row) => row.path === current) ? current : null));
          })
          .catch((failure) => {
            if (controller.signal.aborted) return;
            setNotes([]);
            setListLimit(null);
            setListTruncated(false);
            // The listing carries its own failure text, so an empty `notes`
            // cannot fall through to the `noNotes` arm below and claim the
            // workspace holds no notes when the walk never ran.
            setListError(messageOf(failure));
            setListPhase('error');
          });
        return () => controller.abort();
      }, [workspace, tick]);

      React.useEffect(() => {
        if (selected === null || workspace === null) {
          setNote(null);
          setNotePhase('idle');
          return undefined;
        }
        const controller = new AbortController();
        setNotePhase('loading');
        api('/note', { workspace, path: selected }, controller.signal)
          .then((body) => {
            if (controller.signal.aborted) return;
            setNote(body);
            setNotePhase('ready');
          })
          .catch((failure) => {
            if (controller.signal.aborted) return;
            setNote({ error: messageOf(failure) });
            setNotePhase('error');
          });
        return () => controller.abort();
      }, [selected, workspace, tick]);

      React.useEffect(() => {
        remembered.outline = showOutline;
      }, [showOutline]);

      const noteText = note !== null && typeof note.text === 'string' ? note.text : null;
      const outline = React.useMemo(() => parseOutline(noteText ?? ''), [noteText]);
      /** Chrome copy for the shipped renderer; stable while the locale holds. */
      const labels = markdownLabels();

      /**
       * Scroll one rendered heading into view.
       * @param heading - the outline row to reach.
       */
      const scrollToHeading = React.useCallback((heading) => {
        const box = scrollRef.current;
        if (box === null || heading === undefined) return;
        const nodes = headingNodes(box);
        const wanted = anchorKey(heading.text);
        const matches = nodes.filter((node) => anchorKey(node.textContent ?? '') === wanted);
        const node = matches[heading.ordinal] ?? nodes[heading.index] ?? matches[0] ?? null;
        if (node !== null) node.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }, []);

      /**
       * Scroll to the heading that owns one source line.
       * @param line - the 1-based source line.
       */
      const scrollToLine = React.useCallback(
        (line) => {
          let owner = null;
          for (const heading of outline) {
            if (heading.line <= line && (owner === null || heading.line > owner.line)) owner = heading;
          }
          if (owner !== null) scrollToHeading(owner);
        },
        [outline, scrollToHeading],
      );

      /**
       * Scroll to the heading named by an `#anchor`.
       * @param anchor - the raw fragment.
       */
      const scrollToAnchor = React.useCallback(
        (anchor) => {
          const resolved = resolveAnchor(outline, anchor);
          if (resolved !== null) scrollToHeading(resolved);
        },
        [outline, scrollToHeading],
      );

      // A link that changed notes carries the heading line to reach once the
      // new document is on screen.
      React.useEffect(() => {
        if (notePhase !== 'ready' || pendingLine.current === null) return;
        const line = pendingLine.current;
        pendingLine.current = null;
        scrollToLine(line);
      }, [notePhase, note, scrollToLine]);

      /**
       * Open a note named by a link inside the previewed document, or scroll
       * to the heading a rewritten in-page anchor points at.
       * @param target - the raw link destination.
       * @param options - the delegate's optional `{ line }`.
       */
      const openRelated = React.useCallback(
        (target, options) => {
          if (selected === null) return;
          const wanted = resolveRelativeNote(selected, target);
          if (wanted === null) return;
          const line = options !== undefined && Number.isSafeInteger(options?.line) ? options.line : null;
          const match = notes.find((row) => row.path.toLowerCase() === wanted.toLowerCase());
          if (match === undefined) return;
          if (match.path === selected) {
            if (line !== null) scrollToLine(line);
            return;
          }
          pendingLine.current = line;
          setSelected(match.path);
        },
        [selected, notes, scrollToLine],
      );

      /** Anchors and local destinations the renderers leave to the panel. */
      const onPreviewClick = React.useCallback(
        (event) => {
          const target = event.target;
          const anchor = target instanceof Element ? target.closest('a[href]') : null;
          if (anchor === null) return;
          const href = anchor.getAttribute('href') ?? '';
          if (href.startsWith('#')) {
            event.preventDefault();
            scrollToAnchor(href.slice(1));
            return;
          }
          if (!isLocalTarget(href)) return;
          event.preventDefault();
          openRelated(href, undefined);
        },
        [openRelated, scrollToAnchor],
      );

      /** Keep the outline's active row in step with the scroll position. */
      const onPreviewScroll = React.useCallback(() => {
        const box = scrollRef.current;
        if (box === null) return;
        const nodes = headingNodes(box);
        if (nodes.length !== outline.length) return;
        const top = box.getBoundingClientRect().top + 16;
        let active = 0;
        nodes.forEach((node, at) => {
          if (node.getBoundingClientRect().top <= top) active = at;
        });
        setActiveHeading(active);
      }, [outline]);

      const markdown = React.useMemo(() => {
        if (noteText === null) return null;
        if (MarkdownText === null) return renderMarkdown(noteText);
        const name = selected === null ? '' : selected.slice(selected.lastIndexOf('/') + 1);
        const body = h(MarkdownText, {
          text: transformAnchors(noteText, outline, name),
          labels,
          variant: 'body',
        });
        return MarkdownDelegateProvider === null ? body : h(MarkdownDelegateProvider, { openFile: openRelated }, body);
      }, [noteText, outline, selected, openRelated, labels]);

      const needle = deferredFilter.trim().toLowerCase();
      const shown = needle === '' ? notes : notes.filter((row) => row.path.toLowerCase().includes(needle));

      const tree = React.useMemo(() => buildTree(shown), [shown]);
      const folders = React.useMemo(() => folderPaths(notes), [notes]);
      const allCollapsed = folders.size > 0 && [...folders].every((path) => collapsed.has(path));

      // A large listing starts folded, so the panel shows structure rather
      // than a wall of files; a small one opens, because folding it would only
      // add clicks.
      React.useEffect(() => {
        setCollapsed(notes.length > AUTO_COLLAPSE_ABOVE ? folderPaths(notes) : new Set());
      }, [notes]);

      // Opening a note always reveals it in the tree.
      React.useEffect(() => {
        if (selected === null) return;
        const parents = ancestorPaths(selected);
        if (parents.length === 0) return;
        setCollapsed((current) => {
          if (!parents.some((path) => current.has(path))) return current;
          const next = new Set(current);
          for (const path of parents) next.delete(path);
          return next;
        });
      }, [selected]);

      const toggleFolder = React.useCallback((path) => {
        setCollapsed((current) => {
          const next = new Set(current);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
      }, []);

      /**
       * Render one directory level: its sub-folders first, then its own notes.
       * @param node - the tree node.
       * @returns the rows of that level and of every open descendant.
       */
      const renderLevel = (node) => {
        const items = [];
        const children = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        for (const child of children) {
          const open = !collapsed.has(child.path);
          items.push(
            h(
              'button',
              {
                key: `d:${child.path}`,
                type: 'button',
                className: 'dsh-pn-folder',
                style: { paddingLeft: 8 + child.depth * 12 },
                title: child.path,
                'aria-expanded': open ? 'true' : 'false',
                onClick: () => toggleFolder(child.path),
              },
              h('span', { className: 'dsh-pn-folder-chevron', 'aria-hidden': true }, open ? '▾' : '▸'),
              h('span', { className: 'dsh-pn-folder-name' }, child.name),
              h('span', { className: 'dsh-pn-folder-count' }, String(child.total)),
            ),
          );
          if (open) items.push(...renderLevel(child));
        }
        for (const row of node.files) {
          items.push(
            h(NoteRow, {
              key: `f:${row.path}`,
              path: row.path,
              name: row.name,
              dir: row.dir,
              depth: node.depth + 1,
              active: row.path === selected,
              onSelect: setSelected,
            }),
          );
        }
        return items;
      };

      const currentWorkspace = workspaces.find((row) => row.key === workspace) ?? null;
      const reload = () => setTick((value) => value + 1);

      const header = h(
        'div',
        { className: 'dsh-pn-header' },
        h(
          'div',
          { className: 'dsh-pn-heading' },
          h('div', { className: 'dsh-pn-title' }, t('title')),
          h('div', { className: 'dsh-pn-subtitle' }, currentWorkspace !== null ? currentWorkspace.title : t('subtitle')),
        ),
        h('div', { className: 'dsh-pn-spacer' }),
        workspaces.length > 1
          ? h(
              'label',
              { className: 'dsh-pn-field' },
              t('workspace'),
              h(
                'select',
                {
                  className: 'dsh-pn-control',
                  value: workspace ?? '',
                  'aria-label': t('workspace'),
                  onChange: (event) => {
                    setSelected(null);
                    setWorkspace(event.target.value);
                  },
                },
                workspaces.map((row) => h('option', { key: row.key, value: row.key }, row.title)),
              ),
            )
          : null,
        h('span', { className: 'dsh-pn-count' }, `${notes.length} ${t('files')}`),
        h(IconButton, { label: t('refresh'), onClick: reload }),
      );

      let listBody;
      if (phase === 'error') {
        // The workspace projection carries no message of its own; the panel can
        // only report that the registry is unavailable.
        listBody = h(
          'div',
          { className: 'dsh-pn-message dsh-pn-error' },
          t('loadFailed'),
          h('div', { style: { marginTop: 10 } }, h(IconButton, { label: t('retry'), onClick: reload })),
        );
      } else if (phase === 'empty') {
        listBody = h('div', { className: 'dsh-pn-message' }, t('noWorkspace'));
      } else if (listPhase === 'error') {
        // Without this arm an empty `notes` falls through to `noNotes`, telling
        // the user the workspace holds no notes when the listing never ran.
        listBody = h(
          'div',
          { className: 'dsh-pn-message dsh-pn-error' },
          listError ?? t('loadFailed'),
          h('div', { style: { marginTop: 10 } }, h(IconButton, { label: t('retry'), onClick: reload })),
        );
      } else if (listPhase === 'loading' && notes.length === 0) {
        listBody = h('div', { className: 'dsh-pn-message' }, t('loading'));
      } else if (shown.length === 0) {
        listBody = h('div', { className: 'dsh-pn-message' }, notes.length === 0 ? t('noNotes') : t('noMatches'));
      } else if (needle !== '') {
        // Filtering answers "where is it": a flat, scannable match list.
        listBody = shown.map((row) =>
          h(NoteRow, {
            key: row.path,
            path: row.path,
            name: row.name,
            dir: row.dir,
            showDir: true,
            active: row.path === selected,
            onSelect: setSelected,
          }),
        );
      } else {
        // Browsing answers "what is here": the directory tree.
        listBody = renderLevel(tree);
      }

      const list = h(
        'div',
        { className: 'dsh-pn-list' },
        h(
          'div',
          { className: 'dsh-pn-list-head' },
          h(
            'div',
            { className: 'dsh-pn-list-head-row' },
            h('input', {
              className: 'dsh-pn-input',
              value: filter,
              placeholder: t('filter'),
              'aria-label': t('filter'),
              onChange: (event) => setFilter(event.target.value),
            }),
            needle === '' && folders.size > 0
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-pn-button',
                    title: allCollapsed ? t('expandAll') : t('collapseAll'),
                    'aria-label': allCollapsed ? t('expandAll') : t('collapseAll'),
                    onClick: () => setCollapsed(allCollapsed ? new Set() : new Set(folders)),
                  },
                  allCollapsed ? '⊞' : '⊟',
                )
              : null,
          ),
        ),
        h('div', { className: 'dsh-pn-scroll' }, listBody),
        listPhase === 'ready' && listTruncated
          ? h(
              'div',
              { className: 'dsh-pn-footer' },
              listLimit !== null && notes.length < listLimit
                ? t('listTruncatedDeep')
                : t('listTruncated', { limit: listLimit ?? notes.length }),
            )
          : null,
      );

      let preview;
      if (selected === null) {
        preview = h('div', { className: 'dsh-pn-message' }, t('previewEmpty'));
      } else if (notePhase === 'loading' && note === null) {
        preview = h('div', { className: 'dsh-pn-message' }, t('loading'));
      } else if (note !== null && typeof note.error === 'string') {
        preview = h('div', { className: 'dsh-pn-message dsh-pn-error' }, note.error);
      } else if (noteText !== null) {
        const canOutline = outline.length >= 2;
        preview = [
          h(
            'div',
            { className: 'dsh-pn-scrollpane', key: 'pane', ref: scrollRef, onScroll: onPreviewScroll },
            h(
              'div',
              { className: 'dsh-pn-doc' },
              h(
                'div',
                { className: 'dsh-pn-doc-head' },
                h('div', { className: 'dsh-pn-doc-path' }, note.path ?? ''),
                h('div', { className: 'dsh-pn-spacer' }),
                h(
                  'div',
                  { className: 'dsh-pn-doc-head-actions' },
                  canOutline ? h(IconButton, { label: t('outline'), onClick: () => setShowOutline((value) => !value) }) : null,
                  h('div', { className: 'dsh-pn-doc-meta' }, formatSize(note.size)),
                ),
              ),
              note.truncated === true
                ? h('div', { className: 'dsh-pn-banner' }, t('truncated', { limit: formatSize(note.limitBytes) || `${note.limitBytes} B` }))
                : null,
              h('div', { className: MarkdownText === null ? 'dsh-pn-fallback' : undefined, onClickCapture: onPreviewClick }, markdown),
            ),
          ),
          canOutline && showOutline
            ? h(
                'div',
                { className: 'dsh-pn-outline', key: 'outline' },
                h('div', { className: 'dsh-pn-outline-title' }, t('outline')),
                outline.map((heading) =>
                  h(
                    'button',
                    {
                      key: `${heading.line}-${heading.index}`,
                      type: 'button',
                      className: 'dsh-pn-outline-item',
                      style: { paddingLeft: 6 + (heading.depth - 1) * 10 },
                      'aria-current': heading.index === activeHeading ? 'true' : undefined,
                      title: heading.text,
                      onClick: () => scrollToHeading(heading),
                    },
                    heading.text,
                  ),
                ),
              )
            : null,
        ];
      } else {
        preview = h('div', { className: 'dsh-pn-message' }, t('previewEmpty'));
      }

      return h(
        'div',
        { className: 'dsh-pn-root' },
        header,
        h('div', { className: 'dsh-pn-body' }, list, h('div', { className: 'dsh-pn-note' }, preview)),
      );
    }

    // ----------------------------------------------------------------- plug
    /**
     * Register the sidebar entry and its main panel.
     * @param ctx - Client root context.
     */
    function apply(ctx) {
      ctx.effect(() => insertStyles(), 'project-notes: styles');

      const locale = ctx.get('locale');
      if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
        ctx.effect(() => locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'project-notes: dictionaries');
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

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => t('title') },
              NotesIcon,
            ),
          ),
        'project-notes: sidebar entry',
      );

      ctx.effect(
        () => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, NotesPanel)),
        'project-notes: main panel',
      );
    }

    return { inject: ['slots'], apply };
  },
});
