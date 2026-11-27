import { copyFile } from "node:fs/promises";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  absWorkingDir: fileURLToPath(new URL(".", import.meta.url)),
  entryPoints: ["src/codex-mcp.ts"],
  outfile: "codex-plugin/server/workmate.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
});

await build({
  absWorkingDir: fileURLToPath(new URL(".", import.meta.url)),
  entryPoints: ["src/codex-board.ts"],
  outfile: "codex-plugin/server/board.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
});
await copyFile(new URL("./board/index.html", import.meta.url), new URL("./codex-plugin/server/board.html", import.meta.url));
