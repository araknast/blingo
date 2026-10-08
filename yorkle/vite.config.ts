import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// `npm run dev:ui` serves the app with hot reload; API calls go to `npm run dev` on :8787.
export default defineConfig({
	root: "app",
	plugins: [svelte()],
	build: { outDir: "../dist", emptyOutDir: true },
	server: { proxy: { "/api": "http://localhost:8787", "/verify": "http://localhost:8787" } },
});
