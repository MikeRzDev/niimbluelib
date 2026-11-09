// Builds and runs test/gen_print_dump.ts against a niimbluelib source tree.
// Usage: node test/gen_print_dump.mjs [--niimbluelib <dir>]
import * as esbuild from "esbuild";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const i = args.indexOf("--niimbluelib");
const libDir = resolve(root, i >= 0 ? args[i + 1] : (process.env.NIIMBLUELIB_DIR ?? ".."));
const stub = join(root, "js", "stubs", "capacitor.ts");

const redirect = {
  name: "niimbluelib-dir",
  setup(build) {
    build.onResolve({ filter: /^\.\.\/\.\.\/src(\/.*)?$/ }, (a) => {
      const sub = a.path.replace(/^\.\.\/\.\.\/src\/?/, "");
      const base = join(libDir, "src", sub);
      for (const p of [base + ".ts", join(base, "index.ts")]) if (existsSync(p)) return { path: p };
      return { path: base };
    });
  },
};

const tmp = mkdtempSync(join(tmpdir(), "niimgen-"));
const out = join(tmp, "gen.mjs");
await esbuild.build({
  entryPoints: [join(root, "test", "gen_print_dump.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: out,
  alias: { "@capacitor/core": stub, "@capacitor-community/bluetooth-le": stub },
  nodePaths: [join(libDir, "node_modules")],
  define: { "import.meta.url": JSON.stringify(pathToFileURL(join(root, "test", "x")).href) },
  plugins: [redirect],
  logLevel: "warning",
});
await import(pathToFileURL(out).href);
rmSync(tmp, { recursive: true, force: true });
