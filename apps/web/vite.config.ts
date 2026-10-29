import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Use the contract's source directly so the web app builds without a prior contract build.
      "@nightshift/contract": fileURLToPath(new URL("../../packages/contract/src/index.ts", import.meta.url)),
    },
  },
  server: { port: 5180, strictPort: false },
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router"],
          vendor: ["zod", "@dnd-kit/core", "@dnd-kit/sortable", "@dnd-kit/utilities", "lucide-react"],
        },
      },
    },
  },
});
