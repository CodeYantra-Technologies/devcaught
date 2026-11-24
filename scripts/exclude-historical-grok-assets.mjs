import { existsSync, lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** Vite copies `public/` verbatim. Historical `public/__grok` is not app code. */
export const HISTORICAL_GROK_DIR = "__grok";

function isInside(parent, child) {
  return child === parent || child.startsWith(parent + sep);
}

/** Unlink a tree. Symbolic links are removed as links and are not followed. */
function removeWithoutFollowing(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    unlinkSync(path);
    return;
  }
  for (const name of readdirSync(path)) removeWithoutFollowing(join(path, name));
  rmdirSync(path);
}

/**
 * Delete copied `__grok` directories under a build output.
 * Refuses to touch `public/` or `.grok/` sources, paths outside the workspace,
 * and any directory reached through a symbolic link.
 * Returns the removed directory paths.
 */
export function removeCopiedGrokAssets(outputRoot, workspaceRoot) {
  const workspace = resolve(workspaceRoot);
  const output = resolve(outputRoot);
  const forbidden = [resolve(workspace, "public"), resolve(workspace, ".grok")].filter(existsSync).map(path => realpathSync(path));
  if (!existsSync(output)) return [];
  const realOutput = realpathSync(output);
  if (!isInside(workspace, realOutput) || forbidden.some(path => isInside(path, realOutput))) {
    throw new Error(`Refusing to scan ${realOutput} for historical Grok assets`);
  }
  const removed = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const full = join(directory, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (!stat.isDirectory()) continue;
      if (name === HISTORICAL_GROK_DIR) {
        const real = realpathSync(full);
        if (forbidden.some(path => isInside(path, real) || isInside(real, path))) {
          throw new Error(`Refusing to delete historical Grok source ${real}`);
        }
        if (!isInside(realOutput, real)) throw new Error(`Refusing to delete ${real}`);
        removeWithoutFollowing(full);
        removed.push(real);
        continue;
      }
      visit(full);
    }
  };
  visit(realOutput);
  return removed;
}
