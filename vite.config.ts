import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	server: { port: 5173 },
	// @polkadot/api pulls in some large chunks; bump the warning limit to keep noise down.
	build: { chunkSizeWarningLimit: 2000 },
});
