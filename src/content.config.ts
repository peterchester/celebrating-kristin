import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * The enforced data model. This Zod schema IS the contract described in
 * docs/DATA-MODEL.md — keep the two in sync. Every JSON file in
 * src/content/entries/ is validated against it at build time, so a malformed
 * submission fails the build instead of silently rendering broken.
 *
 * z.object() strips unknown keys, so private capture-time fields (email, IP,
 * etc.) can never leak into the public site even if they end up in a file.
 */
const entries = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/entries' }),
  schema: z.object({
    author: z.object({
      name: z.string().min(1),
      relationship: z.string().optional(),
    }),
    title: z.string().optional(),
    body: z.string().optional(), // optional — a memory may be media-only

    media: z
      .array(
        z.object({
          type: z.enum(['image', 'audio', 'video']),
          src: z.string(), // path under /public, e.g. /media/<id>/file.jpg
          original: z.string().optional(), // untouched upload (images only); src is the web-optimized version
          poster: z.string().optional(), // video thumbnail image
          caption: z.string().optional(),
          alt: z.string().optional(),
        }),
      )
      .default([]),
    submittedAt: z.coerce.date(), // for sorting only — never shown to readers
    memoryDate: z.coerce.date().optional(), // when the memory happened (optional, contributor-provided)
    editedAt: z.coerce.date().optional(),
    status: z.enum(['published', 'hidden']).default('published'),
  }),
});

export const collections = { entries };
