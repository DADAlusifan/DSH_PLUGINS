/**
 * @local/dsh-project-notes — Host half.
 *
 * Mounts the read-only API the 项目笔记 browser panel reads, as exact routes on
 * the shared authenticated `/api` channel:
 *
 *   GET /api/project-notes/state
 *     -> { workspaces, defaultKey, order, route }
 *   GET /api/project-notes/notes?workspace=<id|path>
 *     -> { workspace, root, notes, truncated, limit }
 *   GET /api/project-notes/note?workspace=<id|path>&path=<relative path>
 *     -> { path, name, text, size, truncated, limitBytes }
 *
 * `connection.fetch` owns the carrier: the connection fence admits every
 * request (Host/Origin plus browser authentication) and the
 * `connection/request` waterfall sees the traffic before this plugin does —
 * the same treatment the shipped `/api/file` route gets. The plugin therefore
 * carries no admission logic and cannot serve an unauthenticated read: without
 * the `connection` service it never loads at all.
 *
 * Workspaces come from the durable workspace registry in its own display
 * order; only Markdown files inside a registered workspace directory are
 * listed, and every read is re-checked against that root through the Host
 * `fs` service, which refuses a final symlink exactly as the platform's own
 * file reads do. Nothing here mutates files.
 *
 * The optional config is read from the row's `config` key and clamped to safe
 * bounds; see README for the accepted fields. Host changes need a DSH restart.
 */
import { createFetchRoutes, normalizeConfig } from './lib/host.js';

/** Required Host services: the authenticated carrier and the filesystem. */
export const inject = ['connection', 'fs'];

/** Plugin name for diagnostics. */
export const name = 'project-notes';

/**
 * Mount the notes API on the shared channel.
 * @param ctx - Host plugin context.
 * @param config - optional row config (see `normalizeConfig`).
 */
export function apply(ctx, config) {
  const routes = createFetchRoutes(ctx, normalizeConfig(config));
  ctx.effect(function* registerRoutes() {
    for (const { route } of routes) yield ctx.connection.fetch.register(route);
  }, 'project-notes: notes api');
}
