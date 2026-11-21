import { defineConfig } from "tsup";

export default defineConfig({
  // One file, one bin. The single runtime dependency stays external so npm
  // installs it and its provenance stays visible.
  entry: { bin: "src/bin.ts" },
  splitting: false,
  format: ["esm"],
  target: "node22",
  sourcemap: true,
  clean: true,
});
