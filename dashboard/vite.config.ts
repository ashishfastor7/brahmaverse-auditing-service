import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";

/** Pure engine files the dashboard shares with the API (no imports of their own), e.g. `@engine/rebalance`. */
const engine = fileURLToPath(new URL("../src/audit/v2", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@engine": engine } },
  server: { port: 5175, fs: { allow: [searchForWorkspaceRoot(process.cwd()), engine] } },
});
