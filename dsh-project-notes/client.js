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
 * (`/project-notes/api/...`). React comes from the browser module table; no
 * Harness Client package is imported, and every style is a `--dsw-alias-*`
 * theme token so the panel follows light and dark themes.
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
    /** Host API prefix registered by this package's node half. */
    const API = '/project-notes/api';

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
        noWorkspace: '没有已注册的工作区',
        truncated: '内容过长，仅显示前 512 KB',
        listTruncated: '文件过多，仅显示前 800 个',
        notFound: '文件已不存在',
        unknownWorkspace: '工作区不可用',
        retry: '重试',
        loadFailed: '加载失败',
        workspace: '工作区',
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
        noWorkspace: 'No registered workspace',
        truncated: 'Too long — showing the first 512 KB',
        listTruncated: 'Too many files — showing the first 800',
        notFound: 'The file no longer exists',
        unknownWorkspace: 'Workspace unavailable',
        retry: 'Retry',
        loadFailed: 'Failed to load',
        workspace: 'Workspace',
      },
    };

    /** Visible text lookup; replaced by the locale service during `apply`. */
    let t = (key) => DICT.zh[key] ?? key;

    // ---------------------------------------------------------------- theme
    const C = {
      text: 'var(--dsw-alias-label-primary, #e8e8e8)',
      muted: 'var(--dsw-alias-label-secondary, #9aa0a6)',
      border: 'var(--dsw-alias-border-l1, rgba(128,128,128,0.25))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.42))',
      layer1: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.07))',
      layer2: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.13))',
      brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      danger: 'var(--dsw-alias-state-error-primary, #e05252)',
    };
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    // ----------------------------------------------------------------- data
    /**
     * Call one Host endpoint.
     * @param endpoint - path below the API prefix.
     * @param params - optional query parameters.
     * @returns the parsed JSON body.
     */
    async function api(endpoint, params) {
      const url = new URL(`${API}${endpoint}`, window.location.origin);
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
      const response = await fetch(url.toString(), { headers: { accept: 'application/json' } });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        const code = body && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
        throw new Error(code);
      }
      return body ?? {};
    }

    /** Human-readable error text. */
    function messageOf(error) {
      const raw = error instanceof Error ? error.message : String(error);
      if (raw === 'unknown-workspace') return t('unknownWorkspace');
      if (raw === 'not-found') return t('notFound');
      return raw === '' ? t('loadFailed') : raw;
    }

    /** Compact byte size. */
    function formatSize(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    // ------------------------------------------------------------- markdown
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
      INLINE.lastIndex = 0;
      let match;
      while ((match = INLINE.exec(text)) !== null) {
        if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
        const token = match[0];
        const key = `${seed}-${index++}`;
        if (token.startsWith('`')) {
          nodes.push(h('code', { key, style: { fontFamily: MONO, fontSize: '0.92em', background: C.layer2, borderRadius: 4, padding: '1px 4px' } }, token.slice(1, -1)));
        } else if (token.startsWith('**') || token.startsWith('__')) {
          nodes.push(h('strong', { key }, token.slice(2, -2)));
        } else if (token.startsWith('~~')) {
          nodes.push(h('del', { key, style: { opacity: 0.68 } }, token.slice(2, -2)));
        } else if (token.startsWith('*') || token.startsWith('_')) {
          nodes.push(h('em', { key }, token.slice(1, -1)));
        } else {
          const split = token.indexOf('](');
          const label = token.slice(1, split);
          const href = safeHref(token.slice(split + 2, -1));
          nodes.push(
            href === null
              ? label
              : h('a', { key, href, target: '_blank', rel: 'noreferrer', style: { color: C.brand, textDecoration: 'none' } }, label),
          );
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
        { key: seed, style: { margin: '8px 0', paddingLeft: 22, color: C.text, lineHeight: 1.7 } },
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
              { key: `b${key++}`, style: { background: C.layer2, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', overflowX: 'auto', margin: '10px 0' } },
              h('code', { style: { fontFamily: MONO, fontSize: 12.5, lineHeight: 1.55, color: C.text } }, body.join('\n')),
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
                style: {
                  fontSize: size,
                  fontWeight: level <= 3 ? 650 : 600,
                  color: C.text,
                  margin: level <= 2 ? '18px 0 8px' : '14px 0 6px',
                  paddingBottom: level <= 2 ? 6 : 0,
                  borderBottom: level <= 2 ? `1px solid ${C.border}` : 'none',
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
          blocks.push(h('hr', { key: `b${key++}`, style: { border: 'none', borderTop: `1px solid ${C.border}`, margin: '16px 0' } }));
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
              { key: `b${key++}`, style: { borderLeft: `3px solid ${C.borderStrong}`, margin: '10px 0', padding: '2px 0 2px 12px', color: C.muted } },
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
          const cell = { border: `1px solid ${C.border}`, padding: '6px 10px', textAlign: 'left', verticalAlign: 'top' };
          blocks.push(
            h(
              'div',
              { key: `b${key++}`, style: { overflowX: 'auto', margin: '10px 0' } },
              h(
                'table',
                { style: { borderCollapse: 'collapse', fontSize: 13, color: C.text } },
                h(
                  'thead',
                  null,
                  h('tr', null, header.map((value, at) => h('th', { key: at, style: { ...cell, background: C.layer2, fontWeight: 600 } }, renderInline(value, `th${at}`)))),
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
        blocks.push(
          h('p', { key: `b${key++}`, style: { margin: '9px 0', lineHeight: 1.75, color: C.text } }, renderInline(paragraph.join(' '), `p${key}`)),
        );
      }
      return blocks;
    }

    // -------------------------------------------------------------- controls
    /** A token-styled icon button. */
    function IconButton({ label, onClick, children }) {
      const [hover, setHover] = React.useState(false);
      return h(
        'button',
        {
          type: 'button',
          title: label,
          'aria-label': label,
          onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 28,
            padding: '0 10px',
            borderRadius: 8,
            border: `1px solid ${C.border}`,
            background: hover ? C.layer2 : 'transparent',
            color: C.text,
            font: 'inherit',
            fontSize: 12.5,
            cursor: 'pointer',
            transition: 'background 120ms ease',
          },
        },
        children,
      );
    }

    /** The sidebar glyph: a note with lines. */
    function NotesIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16;
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

    /** One row of the note list. */
    function NoteRow({ note, active, onSelect }) {
      const [hover, setHover] = React.useState(false);
      return h(
        'button',
        {
          type: 'button',
          onClick: () => onSelect(note.path),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          title: note.path,
          style: {
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: '6px 10px',
            margin: '1px 0',
            borderRadius: 7,
            border: 'none',
            background: active ? C.layer2 : hover ? C.layer1 : 'transparent',
            color: active ? C.text : C.text,
            font: 'inherit',
            fontSize: 12.5,
            cursor: 'pointer',
            boxShadow: active ? `inset 2px 0 0 ${C.brand}` : 'none',
          },
        },
        h('span', { style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, note.name),
        note.dir === ''
          ? null
          : h('span', { style: { display: 'block', color: C.muted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, note.dir),
      );
    }

    // ---------------------------------------------------------------- panel
    /** The `main` panel: note list plus Markdown preview. */
    function NotesPanel() {
      const [phase, setPhase] = React.useState('loading');
      const [error, setError] = React.useState(null);
      const [workspaces, setWorkspaces] = React.useState([]);
      const [workspace, setWorkspace] = React.useState(null);
      const [notes, setNotes] = React.useState([]);
      const [listPhase, setListPhase] = React.useState('loading');
      const [listTruncated, setListTruncated] = React.useState(false);
      const [filter, setFilter] = React.useState('');
      const [selected, setSelected] = React.useState(null);
      const [note, setNote] = React.useState(null);
      const [notePhase, setNotePhase] = React.useState('idle');
      const [tick, setTick] = React.useState(0);

      React.useEffect(() => {
        let alive = true;
        setPhase('loading');
        setError(null);
        api('/state')
          .then((body) => {
            if (!alive) return;
            const list = Array.isArray(body.workspaces) ? body.workspaces : [];
            setWorkspaces(list);
            setWorkspace((current) => {
              if (current !== null && list.some((row) => row.key === current)) return current;
              return typeof body.defaultKey === 'string' ? body.defaultKey : null;
            });
            setPhase(list.length === 0 ? 'empty' : 'ready');
          })
          .catch((failure) => {
            if (!alive) return;
            setError(messageOf(failure));
            setPhase('error');
          });
        return () => {
          alive = false;
        };
      }, [tick]);

      React.useEffect(() => {
        if (workspace === null) {
          setNotes([]);
          setListPhase('ready');
          return undefined;
        }
        let alive = true;
        setListPhase('loading');
        api('/notes', { workspace })
          .then((body) => {
            if (!alive) return;
            setNotes(Array.isArray(body.notes) ? body.notes : []);
            setListTruncated(body.truncated === true);
            setListPhase('ready');
          })
          .catch((failure) => {
            if (!alive) return;
            setNotes([]);
            setListTruncated(false);
            setListPhase('error');
            setError(messageOf(failure));
          });
        return () => {
          alive = false;
        };
      }, [workspace, tick]);

      React.useEffect(() => {
        if (selected === null || workspace === null) {
          setNote(null);
          setNotePhase('idle');
          return undefined;
        }
        let alive = true;
        setNotePhase('loading');
        api('/note', { workspace, path: selected })
          .then((body) => {
            if (!alive) return;
            setNote(body);
            setNotePhase('ready');
          })
          .catch((failure) => {
            if (!alive) return;
            setNote({ error: messageOf(failure) });
            setNotePhase('error');
          });
        return () => {
          alive = false;
        };
      }, [selected, workspace, tick]);

      const needle = filter.trim().toLowerCase();
      const shown = needle === '' ? notes : notes.filter((row) => row.path.toLowerCase().includes(needle));

      const groups = [];
      for (const row of shown) {
        const last = groups[groups.length - 1];
        if (last !== undefined && last.dir === row.dir) last.rows.push(row);
        else groups.push({ dir: row.dir, rows: [row] });
      }

      const currentWorkspace = workspaces.find((row) => row.key === workspace) ?? null;
      const reload = () => setTick((value) => value + 1);

      const header = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 20px 12px',
            borderBottom: `1px solid ${C.border}`,
            flex: '0 0 auto',
          },
        },
        h(
          'div',
          { style: { minWidth: 0 } },
          h('div', { style: { fontSize: 15, fontWeight: 600, color: C.text } }, t('title')),
          h('div', { style: { fontSize: 11.5, color: C.muted, marginTop: 2 } }, t('subtitle')),
        ),
        h('div', { style: { flex: '1 1 auto' } }),
        workspaces.length > 1
          ? h(
              'label',
              { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.muted } },
              t('workspace'),
              h(
                'select',
                {
                  value: workspace ?? '',
                  onChange: (event) => {
                    setSelected(null);
                    setWorkspace(event.target.value);
                  },
                  style: {
                    height: 28,
                    maxWidth: 240,
                    borderRadius: 8,
                    border: `1px solid ${C.border}`,
                    background: C.layer1,
                    color: C.text,
                    font: 'inherit',
                    fontSize: 12.5,
                    padding: '0 6px',
                  },
                },
                workspaces.map((row) => h('option', { key: row.key, value: row.key }, row.title)),
              ),
            )
          : null,
        h('span', { style: { fontSize: 12, color: C.muted, whiteSpace: 'nowrap' } }, `${notes.length} ${t('files')}`),
        h(IconButton, { label: t('refresh'), onClick: reload }, t('refresh')),
      );

      let listBody;
      if (phase === 'error') {
        listBody = h('div', { style: { padding: 16, color: C.danger, fontSize: 12.5, lineHeight: 1.6 } }, error ?? t('loadFailed'), h('div', { style: { marginTop: 10 } }, h(IconButton, { label: t('retry'), onClick: reload }, t('retry'))));
      } else if (phase === 'empty') {
        listBody = h('div', { style: { padding: 16, color: C.muted, fontSize: 12.5 } }, t('noWorkspace'));
      } else if (listPhase === 'loading' && notes.length === 0) {
        listBody = h('div', { style: { padding: 16, color: C.muted, fontSize: 12.5 } }, t('loading'));
      } else if (shown.length === 0) {
        listBody = h('div', { style: { padding: 16, color: C.muted, fontSize: 12.5 } }, notes.length === 0 ? t('noNotes') : t('noNotes'));
      } else {
        listBody = groups.map((group) =>
          h(
            'div',
            { key: group.dir === '' ? '.' : group.dir },
            group.dir === ''
              ? null
              : h('div', { style: { padding: '10px 10px 3px', fontSize: 11, fontWeight: 600, color: C.muted, letterSpacing: 0.2 } }, group.dir),
            group.rows.map((row) => h(NoteRow, { key: row.path, note: row, active: row.path === selected, onSelect: setSelected })),
          ),
        );
      }

      const list = h(
        'div',
        {
          style: {
            flex: '0 0 268px',
            minWidth: 0,
            borderRight: `1px solid ${C.border}`,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          },
        },
        h('div', { style: { padding: '10px 12px 6px', flex: '0 0 auto' } }, h('input', {
          value: filter,
          placeholder: t('filter'),
          onChange: (event) => setFilter(event.target.value),
          style: {
            width: '100%',
            boxSizing: 'border-box',
            height: 28,
            borderRadius: 8,
            border: `1px solid ${C.border}`,
            background: C.layer1,
            color: C.text,
            font: 'inherit',
            fontSize: 12.5,
            padding: '0 9px',
            outline: 'none',
          },
        })),
        h('div', { style: { flex: '1 1 auto', overflowY: 'auto', overflowX: 'hidden', padding: '0 8px 12px', minHeight: 0 } }, listBody),
        listTruncated
          ? h('div', { style: { padding: '6px 12px', borderTop: `1px solid ${C.border}`, fontSize: 11, color: C.muted } }, t('listTruncated'))
          : null,
      );

      let preview;
      if (selected === null) {
        preview = h('div', { style: { margin: 'auto', color: C.muted, fontSize: 13 } }, t('previewEmpty'));
      } else if (notePhase === 'loading' && note === null) {
        preview = h('div', { style: { margin: 'auto', color: C.muted, fontSize: 13 } }, t('loading'));
      } else if (note !== null && typeof note.error === 'string') {
        preview = h('div', { style: { margin: 'auto', color: C.danger, fontSize: 13 } }, note.error);
      } else if (note !== null && typeof note.text === 'string') {
        preview = h(
          'div',
          { style: { padding: '18px 26px 40px', maxWidth: 860, width: '100%', boxSizing: 'border-box', margin: '0 auto' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 10, paddingBottom: 12, borderBottom: `1px solid ${C.border}`, marginBottom: 6 } },
            h('div', { style: { fontSize: 13.5, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, note.path ?? ''),
            h('div', { style: { flex: '1 1 auto' } }),
            h('div', { style: { fontSize: 11.5, color: C.muted, whiteSpace: 'nowrap' } }, formatSize(note.size)),
          ),
          note.truncated === true
            ? h('div', { style: { margin: '8px 0 0', padding: '6px 10px', borderRadius: 8, background: C.layer2, color: C.muted, fontSize: 11.5 } }, t('truncated'))
            : null,
          renderMarkdown(note.text),
        );
      } else {
        preview = h('div', { style: { margin: 'auto', color: C.muted, fontSize: 13 } }, t('previewEmpty'));
      }

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
            paddingTop: 'var(--dsh-frame-top-clearance, 0px)',
            boxSizing: 'border-box',
            color: C.text,
            font: 'inherit',
          },
        },
        header,
        h(
          'div',
          { style: { display: 'flex', flex: '1 1 auto', minHeight: 0 } },
          list,
          h('div', { style: { flex: '1 1 auto', minWidth: 0, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' } }, preview),
        ),
      );
    }

    // ----------------------------------------------------------------- plug
    /**
     * Register the sidebar entry and its main panel.
     * @param ctx - Client root context.
     */
    function apply(ctx) {
      const locale = ctx.get('locale');
      if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
        ctx.effect(() => locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'project-notes: dictionaries');
        const bound = locale.bind(NS);
        t = (key) => {
          try {
            const value = bound(key);
            if (typeof value === 'string' && value !== '' && value !== key) return value;
          } catch {
            /* fall back to the bundled dictionary */
          }
          return DICT.zh[key] ?? key;
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
