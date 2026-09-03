import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Keep the raw art drop out of the build.
 *
 * public/assets/raw/ is where Joe puts the source FBX files -- 314 MB of them,
 * gitignored, converted by scripts/convert-character.mjs into the few megabytes
 * the game actually ships. Vite copies publicDir wholesale, so without this the
 * bundle carries every source file and the "under 60 MB" budget is a fiction.
 * Deleting after the copy rather than filtering during it, because publicDir
 * has no exclude option and a plugin that reimplements the copy would be worse.
 */
function excludeRawAssets(): Plugin {
  return {
    name: 'exclude-raw-assets',
    apply: 'build',
    closeBundle() {
      const dir = path.resolve('dist/assets/raw');
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 2048 },
  server: { port: 5173 },
  plugins: [excludeRawAssets()],
});
