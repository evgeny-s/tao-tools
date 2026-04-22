import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Base path for GitHub Pages project sites. In CI the deploy workflow passes
// `/<repo-name>/`; locally it's "/". Personal sites (user.github.io) would pass "/".
const base = process.env.BASE_PATH || "/";

export default defineConfig({
	plugins: [react()],
	base,
	server: { port: 5173 },
	// @polkadot/api pulls in some large chunks; bump the warning limit to keep noise down.
	build: { chunkSizeWarningLimit: 2000 },
});
