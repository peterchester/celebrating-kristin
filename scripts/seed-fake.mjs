// Generates a dozen fake memories with fake media for testing the layout.
// Writes into src/content/entries/ and public/media/fake/ — both gitignored,
// so this is throwaway local data. Re-run anytime: `node scripts/seed-fake.mjs`.
// Remove it all with `node scripts/seed-fake.mjs --clean`.
//
// No ffmpeg here, so: images are SVGs, audio is real generated WAV (plays in
// the browser), and video uses a poster image (the <video> needs a real MP4 to
// actually play — drop one in for full playback testing).

import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES = join(ROOT, 'src', 'content', 'entries');
const FAKE = join(ROOT, 'public', 'media', 'fake');
const PREFIX = 'fake-';

if (process.argv.includes('--clean')) {
  for (const f of await readdir(ENTRIES).catch(() => [])) {
    if (f.startsWith(PREFIX)) await rm(join(ENTRIES, f));
  }
  await rm(FAKE, { recursive: true, force: true });
  console.log('Removed fake entries and media.');
  process.exit(0);
}

await mkdir(ENTRIES, { recursive: true });
await mkdir(FAKE, { recursive: true });

// ── media generators ────────────────────────────────────────────────────────

const PALETTES = [
  ['#e8e1d6', '#c2a878'], ['#cdd6d0', '#8aa3a0'], ['#e6d2c0', '#b07d5b'],
  ['#d9dde6', '#7f93b3'], ['#efe4d2', '#cdb083'], ['#d7cfc4', '#9a8f7d'],
  ['#e9d9d2', '#bf8a7a'], ['#cfe0dd', '#6f9c95'],
];

// A soft abstract "photo": gradient sky, a horizon, and a low sun. Varied
// aspect ratios so the masonry staggers nicely.
function scene(w, h, [a, b], i) {
  const horizon = Math.round(h * (0.55 + 0.25 * ((i % 3) / 2)));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/>
  </linearGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <circle cx="${Math.round(w * (0.3 + 0.4 * ((i % 4) / 3)))}" cy="${Math.round(horizon * 0.6)}" r="${Math.round(h * 0.09)}" fill="#fff" opacity="0.55"/>
  <rect y="${horizon}" width="${w}" height="${h - horizon}" fill="#000" opacity="0.08"/>
</svg>`;
}

function poster(w, h, [a, b]) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/>
  </linearGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <rect width="${w}" height="${h}" fill="#000" opacity="0.18"/>
</svg>`;
}

// Real, playable mono 16-bit PCM WAV — a gentle two-note tone with a fade.
function wav(seconds, notes) {
  const rate = 8000;
  const n = rate * seconds;
  const body = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = notes[Math.floor((t / seconds) * notes.length)] ?? notes[0];
    const env = Math.min(1, t * 3, (seconds - t) * 3);
    const v = Math.sin(2 * Math.PI * f * t) * env * 0.35;
    body.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + body.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(body.length, 40);
  return Buffer.concat([head, body]);
}

// Write a spread of images, two posters, two audio clips.
const sizes = [[900, 1200], [1400, 900], [1000, 1000], [1200, 1500], [1500, 1000], [1100, 1300], [1400, 1050], [1000, 1400]];
for (let i = 0; i < sizes.length; i++) {
  await writeFile(join(FAKE, `img-${i + 1}.svg`), scene(sizes[i][0], sizes[i][1], PALETTES[i], i));
}
await writeFile(join(FAKE, 'poster-1.svg'), poster(1400, 900, PALETTES[1]));
await writeFile(join(FAKE, 'poster-2.svg'), poster(1200, 1500, PALETTES[6]));
await writeFile(join(FAKE, 'audio-1.wav'), wav(3, [392, 440, 392]));
await writeFile(join(FAKE, 'audio-2.wav'), wav(4, [330, 392, 440, 392]));

// ── the dozen memories ───────────────────────────────────────────────────────

const img = (n, caption, alt) => ({ type: 'image', src: `/media/fake/img-${n}.svg`, caption, alt });
const vid = (n, caption) => ({ type: 'video', src: `/media/fake/clip-${n}.mp4`, poster: `/media/fake/poster-${n}.svg`, caption });
const aud = (n, caption) => ({ type: 'audio', src: `/media/fake/audio-${n}.wav`, caption });

const P = (...lines) => lines.join('\n\n');

const memories = [
  { author: { name: 'Maya Lindqvist', relationship: 'College roommate' }, title: 'The kitchen at 2am',
    body: P('We never cooked anything ambitious — it was always grilled cheese and whatever tea was in the cupboard. But she could turn a 2am kitchen into the safest room in the world.', 'I still make the tea the way she did. Too much honey.'),
    media: [img(1, 'The old apartment window', 'A soft gradient sky')] },
  { author: { name: 'Daniel Okafor', relationship: 'Bandmate' }, title: 'She heard the harmony first',
    body: P('Kristin always found the harmony before the rest of us even had the melody down. She\'d just close her eyes and there it was.', 'This is a rough recording from one of our last practices. You can hear her laughing at the end.'),
    media: [aud(1, 'Practice room, spring')] },
  { author: { name: 'Tess Romano', relationship: 'Neighbor' }, title: 'Tomatoes over the fence',
    body: P('Every August she\'d hand tomatoes over the fence like they were treasure. They kind of were.') },
  { author: { name: 'Greg Pham' }, title: '',
    body: P('I didn\'t know her long. We met twice, both times at the dog park, both times she remembered my dog\'s name and not mine. I loved that about her.', 'Some people make you feel like the world is a little less sharp around the edges. That was her, even to a near-stranger.') },
  { author: { name: 'Aiyana Brooks', relationship: 'Sister' }, title: 'Cliffs at golden hour',
    body: P('We hiked this trail a hundred times growing up. She always stopped at the same spot.'),
    media: [img(2, 'The overlook', 'Golden gradient over a horizon'), img(5, 'Looking north'), img(7, 'The last bend')] },
  { author: { name: 'Marcus Reyes', relationship: 'Coworker' }, title: 'Her desk speech',
    body: P('On my first day she gave me a five-minute speech about which mug was hers. It became a running joke for six years. I have the mug now.'),
    media: [vid(1, 'The infamous mug, on video')] },
  { author: { name: 'Priya Anand', relationship: 'Yoga teacher' }, title: 'Front row, always',
    body: P('She took the front row of every class even when she was tired, even near the end. She said the view of the window was better up there.'),
    media: [img(3, 'Morning light')] },
  { author: { name: 'Hollis Wynn', relationship: 'Old friend' }, title: 'A voicemail I kept',
    body: P('I never delete voicemails and I\'m glad. Here\'s one from a Tuesday, about nothing at all.'),
    media: [aud(2, 'Tuesday, no occasion')] },
  { author: { name: 'Sofia Castellano', relationship: 'Cousin' }, title: 'Lake day',
    body: P('The water was freezing and she went in first, like always. Recorded this from the dock.'),
    media: [vid(2, 'In she goes')] },
  { author: { name: 'Ben Iverson', relationship: 'Brother-in-law' }, title: 'Card games',
    body: P('She cheated at cards. Everyone knew. No one minded. It was never about winning — it was about the table being full and loud and late.'),
    media: [img(4, 'The cabin porch')] },
  { author: { name: 'Renata Silva', relationship: 'Friend from the choir' }, title: '',
    body: P('Three things I never want to forget: the way she said my name like a question, her terrible parallel parking, and how she cried at every single wedding including ones for people she\'d just met.') },
  { author: { name: 'Theo Marsh', relationship: 'Former student' }, title: 'She kept the drawing',
    body: P('I made her a bad drawing in the third grade. Twenty years later it was still on her fridge. I only found out at the service. I don\'t really have words for that.'),
    media: [img(6, 'The fridge, still'), aud(1, 'Her voicemail saying thank you, years later')] },
];

const pad = (n) => String(n + 1).padStart(2, '0');
const day = (n) => `2026-06-${String(2 + n).padStart(2, '0')}T1${n % 9}:30:00Z`;

for (let i = 0; i < memories.length; i++) {
  const m = memories[i];
  const slug = m.author.name.toLowerCase().split(' ')[0];
  const entry = { ...m, media: m.media ?? [], submittedAt: day(i), status: 'published' };
  await writeFile(join(ENTRIES, `${PREFIX}${pad(i)}-${slug}.json`), JSON.stringify(entry, null, 2) + '\n');
}

console.log(`Seeded ${memories.length} fake memories + media into src/content/entries/ and public/media/fake/.`);
console.log('Remove with: node scripts/seed-fake.mjs --clean');
