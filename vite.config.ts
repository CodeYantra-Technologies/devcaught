import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
// @ts-expect-error JS plugin alongside the TS vite config
import { appEnvPlugin } from "./scripts/app-env-plugin.mjs";
import { isMigrationFile } from "./scripts/migration-plan.mjs";
import { devcaughtPlugin } from "./apps/server/src/vite-plugin.ts";
import { devServerHost } from "./scripts/dev-server-host.mjs";
// @ts-expect-error JS helper alongside the TS vite config
import { removeCopiedGrokAssets } from "./scripts/exclude-historical-grok-assets.mjs";

/** The files `src/lib/db.ts` globs — same directory, same non-recursive scope. */
function hasGlobbedMigrations(root: string): boolean {
  try {
    return readdirSync(join(root, "migrations")).some(isMigrationFile);
  } catch {
    return false;
  }
}

/**
 * Finish PGLite bootstrap during dev-server setup (before traffic). Vite awaits
 * async `configureServer` hooks. Production: `src/lib/db` kicks `ensureDbReady`
 * on import.
 *
 * Vite awaiting the hook puts this on time-to-first-render, so an app with no
 * migrations — no schema to apply — skips it entirely rather than paying for a
 * PGLite instance it never queries.
 */
/**
 * `public/` is copied verbatim into the production client output. Historical
 * `public/__grok` assets are not referenced by this app. Remove only the copies
 * under build directories. Never delete `public/__grok` or `.grok`.
 */
function excludeHistoricalGrokAssets(): Plugin {
  let root = "";
  let outDir = "";
  return {
    name: "devcaught:exclude-historical-grok-assets",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      root = config.root;
      outDir = config.build.outDir;
    },
    closeBundle() {
      const seen = new Set<string>();
      for (const dir of [outDir, join(root, ".output"), join(root, "dist"), join(root, ".vercel")]) {
        if (seen.has(dir)) continue;
        seen.add(dir);
        removeCopiedGrokAssets(dir, root);
      }
    },
  };
}

function pgliteBootstrapPlugin(): Plugin {
  return {
    name: "app-builder:pglite-bootstrap",
    apply: "serve",
    async configureServer(server) {
      if (!hasGlobbedMigrations(server.config.root)) return;
      try {
        const mod = (await server.ssrLoadModule("/src/lib/db.ts")) as {
          ensureDbReady?: () => Promise<void>;
        };
        if (typeof mod.ensureDbReady === "function") {
          await mod.ensureDbReady();
        }
      } catch (err) {
        console.error("[app-builder] DB bootstrap failed:", err);
        throw err;
      }
    },
  };
}

// Network access is an explicit opt-in for isolated live-preview development.
export default defineConfig(({ command, isPreview }) => ({
  server: {
    host: devServerHost(process.env),
    port: 8080,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 8081,
    strictPort: true,
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    pgliteBootstrapPlugin(),
    // Dev-only /__app-env, read by scripts/check-auth-invariant.mjs.
    appEnvPlugin(),
    devcaughtPlugin(),
    tailwindcss(),
    tanstackStart(),
    ...(command === "build" || isPreview
      ? [
          nitro({
            preset:
              process.env.DEVCAUGHT_DOCKER_BUILD === "1"
                ? "node-server"
                : "vercel",
            ...(process.env.DEVCAUGHT_DOCKER_BUILD === "1"
              ? { plugins: ["apps/server/src/nitro/docker-startup.ts"] }
              : {}),
          }),
        ]
      : []),
    viteReact(),
    excludeHistoricalGrokAssets(),
  ],
}));
