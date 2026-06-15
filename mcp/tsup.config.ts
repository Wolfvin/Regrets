import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts", "src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  external: ["regret-testing"],
  splitting: false,
  sourcemap: true,
});
