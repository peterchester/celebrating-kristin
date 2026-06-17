// @ts-check
import { defineConfig } from 'astro/config';

// Dev-only: mirror the production CloudFront rule that routes every
// /memory/<slug> to the single viewer page (src/pages/memory/index.astro).
// The browser URL keeps the slug; the viewer's script reads it. This hook runs
// only under `astro dev`, so the static production build is unaffected.
const memorySlugDevRewrite = {
  name: 'memory-slug-dev-rewrite',
  hooks: {
    'astro:server:setup': ({ server }) => {
      server.middlewares.use((req, _res, next) => {
        if (req.url && /^\/memory\/[^/?]+\/?(\?.*)?$/.test(req.url)) req.url = '/memory/';
        next();
      });
    },
  },
};

// Set `site` to the final URL before deploying (used for canonical links, RSS, etc.)
export default defineConfig({
  // site: 'https://celebrating-kristin.example.org',
  devToolbar: { enabled: false }, // dev-only UI; never shipped in builds anyway
  integrations: [memorySlugDevRewrite],
});
