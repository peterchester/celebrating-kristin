// @ts-check
import { defineConfig } from 'astro/config';

// Set `site` to the final URL before deploying (used for canonical links, RSS, etc.)
export default defineConfig({
  // site: 'https://celebrating-kristin.example.org',
  devToolbar: { enabled: false }, // dev-only UI; never shipped in builds anyway
});
