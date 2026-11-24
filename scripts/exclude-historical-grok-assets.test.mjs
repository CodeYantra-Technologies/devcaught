import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { removeCopiedGrokAssets } from "./exclude-historical-grok-assets.mjs";

test("build-output copies of __grok are removed and historical sources are refused", () => {
  const root = mkdtempSync(join(tmpdir(), "devcaught-grok-"));
  try {
    mkdirSync(join(root, "public", "__grok", "install"), { recursive: true });
    writeFileSync(join(root, "public", "__grok", "icon-180.png"), "source");
    mkdirSync(join(root, ".grok"), { recursive: true });
    writeFileSync(join(root, ".grok", "note.md"), "history");
    mkdirSync(join(root, ".output", "public", "__grok", "install"), { recursive: true });
    writeFileSync(join(root, ".output", "public", "__grok", "icon-180.png"), "copy");
    mkdirSync(join(root, "dist", "client", "__grok"), { recursive: true });
    writeFileSync(join(root, "dist", "client", "__grok", "icon-180.png"), "copy");

    const removed = [
      ...removeCopiedGrokAssets(join(root, ".output"), root),
      ...removeCopiedGrokAssets(join(root, "dist"), root),
    ];
    assert.equal(removed.length, 2);
    assert.equal(existsSync(join(root, ".output", "public", "__grok")), false);
    assert.equal(existsSync(join(root, "dist", "client", "__grok")), false);
    assert.equal(existsSync(join(root, "public", "__grok", "icon-180.png")), true);
    assert.equal(existsSync(join(root, ".grok", "note.md")), true);
    assert.throws(() => removeCopiedGrokAssets(join(root, "public"), root));
    assert.throws(() => removeCopiedGrokAssets(join(root, ".grok"), root));
    assert.deepEqual(removeCopiedGrokAssets(join(root, "missing-output"), root), []);

    const outside = mkdtempSync(join(tmpdir(), "devcaught-grok-outside-"));
    try {
      writeFileSync(join(outside, "precious.txt"), "keep");
      mkdirSync(join(outside, "__grok"), { recursive: true });
      writeFileSync(join(outside, "__grok", "asset.png"), "outside");
      mkdirSync(join(root, ".output", "public"), { recursive: true });
      symlinkSync(join(outside, "__grok"), join(root, ".output", "public", "__grok"));
      symlinkSync(outside, join(root, ".output", "linked-client"));
      mkdirSync(join(root, "dist", "client", "__grok"), { recursive: true });
      symlinkSync(join(outside, "precious.txt"), join(root, "dist", "client", "__grok", "precious.txt"));
      symlinkSync(outside, join(root, "escaped-output"));
      symlinkSync(join(root, "public"), join(root, "public-output"));

      assert.deepEqual(removeCopiedGrokAssets(join(root, ".output"), root), []);
      assert.equal(existsSync(join(outside, "__grok", "asset.png")), true);
      assert.equal(lstatSync(join(root, ".output", "public", "__grok")).isSymbolicLink(), true);
      const removedLink = removeCopiedGrokAssets(join(root, "dist"), root);
      assert.equal(removedLink.length, 1);
      assert.equal(existsSync(join(outside, "precious.txt")), true);
      assert.equal(existsSync(join(root, "dist", "client", "__grok")), false);
      assert.throws(() => removeCopiedGrokAssets(join(root, "escaped-output"), root));
      assert.throws(() => removeCopiedGrokAssets(join(root, "public-output"), root));
      assert.equal(existsSync(join(outside, "precious.txt")), true);
      assert.equal(existsSync(join(root, "public", "__grok", "icon-180.png")), true);
      assert.equal(existsSync(join(outside, "__grok", "asset.png")), true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
