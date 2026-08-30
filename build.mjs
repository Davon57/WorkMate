import * as esbuild from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, "lib");
mkdirSync(outDir, { recursive: true });

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8"));
const external = [
  ...Object.keys(pkg.peerDependencies ?? {}),
  "node:*",
  "ws",
  "node-pty",
];

// Build host plugin
await esbuild.build({
  entryPoints: [resolve(__dirname, "src/plugin.ts")],
  outfile: resolve(outDir, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external,
  banner: { js: "// agent-console host plugin" },
  minify: false,
  sourcemap: false,
});

// Build client plugin
await esbuild.build({
  entryPoints: [resolve(__dirname, "src/client.ts")],
  outfile: resolve(outDir, "client.js"),
  bundle: true,
  platform: "browser",
  // DSH loads client bundles as factories registered in its module table,
  // rather than as native ES modules.
  format: "cjs",
  target: "es2022",
  external: [...Object.keys(pkg.peerDependencies ?? {}), "react"],
  banner: {
    js: `window.__ModuleLoader__.load({
  id: "${pkg.name}",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
  },
  footer: {
    js: `    return module.exports;
  },
});`,
  },
  minify: false,
  sourcemap: false,
});

console.log("✅ agent-console plugin built");
