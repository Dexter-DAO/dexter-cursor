import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  dts: false,
  splitting: false,
  minify: true,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
});
