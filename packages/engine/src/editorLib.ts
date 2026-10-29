/**
 * The editor library (packages/editor), loaded at run time rather than imported.
 *
 * Bundlers must leave it out: it reads its fonts and HyperFrames' runtime files from its own package folder and
 * loads native code (wawoff2), none of which survives being inlined. The desktop shell bundles the engine and
 * ships the editor as its own package next to it (runtime/packages/editor, the same depth as in the repo), so the
 * engine looks for it by name first (the workspace, tests) and then beside its own package.
 */
import type * as Editor from "@nightshift/editor";

export type EditorLib = typeof Editor;

// A name in a variable, so bundlers do not follow the import.
const PACKAGE = "@nightshift/editor";
let loading: Promise<EditorLib> | undefined;

export function loadEditor(): Promise<EditorLib> {
  loading ??= (async () => {
    try {
      return (await import(PACKAGE)) as EditorLib;
    } catch (byName) {
      // From packages/engine/{src,dist}/ to packages/editor/dist/.
      const sibling = new URL("../../editor/dist/index.js", import.meta.url).href;
      try {
        return (await import(sibling)) as EditorLib;
      } catch {
        throw new Error(`The editor (packages/editor) could not be loaded: ${(byName as Error).message}`, { cause: byName });
      }
    }
  })();
  return loading;
}
