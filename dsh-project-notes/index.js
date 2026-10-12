/**
 * @local/dsh-project-notes — Host half.
 *
 * Mounts the read-only HTTP API the 项目笔记 browser panel reads:
 *
 *   GET /project-notes/api/state
 *     -> { workspaces, defaultKey, order, route }
 *   GET /project-notes/api/notes?workspace=<id|path>
 *     -> { workspace, root, notes, truncated, limit }
 *   GET /project-notes/api/note?workspace=<id|path>&path=<relative path>
 *     -> { path, name, text, size, truncated, limitBytes }
 *
 * Workspaces come from the durable workspace registry in its own display
 * order; only Markdown files inside a registered workspace directory are
 * listed, and every read is re-checked against that root through the Host
 * `fs` service, which refuses a final symlink exactly as the platform's own
 * file reads do. Nothing here mutates files.
 *
 * The route is gated by the connection fence (`ctx.connection.admit`): a
 * `webServer` route is not covered by the carrier, so a plugin route must
 * enforce the same Host/Origin and browser-authentication checks the shipped
 * `/api` channel does.
 *
 * The optional config is read from the row's `config` key and clamped to safe
 * bounds; see README for the accepted fields. Host changes need a DSH restart.
 */
import { createHandler, normalizeConfig, ROUTE } from './lib/host.js';

/** Required Host services: the HTTP carrier, the trust fence, and the filesystem. */
export const inject = ['webServer', 'connection', 'fs'];

/** Plugin name for diagnostics. */
export const name = 'project-notes';

/**
 * Mount the notes API.
 * @param ctx - Host plugin context.
 * @param config - optional row config (see `normalizeConfig`).
 */
export function apply(ctx, config) {
  const resolved = normalizeConfig(config);
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: createHandler(ctx, resolved) }),
    'project-notes: notes api',
  );
}
