import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@renderer": path.resolve(__dirname, "src/renderer"),
      "@shared": path.resolve(__dirname, "src/shared"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "dist-electron/**", "node_modules/**", "release/**"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
