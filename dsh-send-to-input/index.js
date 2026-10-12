/**
 * @local/dsh-send-to-input — Host half.
 *
 * This plugin has no Host face on purpose. The button lives in the document
 * preview's header and the text lands in the composer; both are Client
 * concerns:
 *
 *   * the composer is reached through the `inputActions` slot prop, so no Host
 *     service is involved in delivering text;
 *   * the previewed file is read through the session-scoped
 *     `remote.workspaceFiles` Client face, which is itself the Host's own
 *     guarded file API — re-implementing it here would only add a second,
 *     weaker path to the same bytes.
 *
 * The bundle still needs a Host entry, and this one deliberately injects
 * nothing, so a missing Host capability can never keep the button away from
 * the page.
 */

/** Row identity in the composition, matching `cordis.patch.yml`. */
export const name = 'send-to-input';

/**
 * Do nothing: every behaviour of this plugin is declared by its browser half.
 */
export function apply() {}
