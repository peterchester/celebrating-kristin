// Wire up the multi-track audio player that render.ts emits as:
//   <figure class="audio-playlist" data-audio-playlist>
//     <audio controls preload="none"></audio>
//     <ol class="tracks">
//       <li data-track data-src="…"><button data-play>…</button><a download>…</a></li>
//     </ol>
//   </figure>
//
// The markup ships without a chosen source. Here we load the FIRST track into
// the shared <audio> (preload="none" means the row highlight + native controls
// are ready but nothing is fetched until play), wire each row's play button to
// switch tracks, and auto-advance on 'ended'. The per-row download links are
// plain <a download> and need no scripting.
//
// Call attachAudioPlaylist(root) after injecting rendered markup. Idempotent:
// each playlist is wired at most once (a data-wired flag guards re-runs).

export function attachAudioPlaylist(root: ParentNode = document): void {
  const lists = Array.from(root.querySelectorAll<HTMLElement>('[data-audio-playlist]'));
  for (const pl of lists) {
    if (pl.dataset.wired) continue;
    pl.dataset.wired = '1';
    const audio = pl.querySelector('audio');
    const rows = Array.from(pl.querySelectorAll<HTMLElement>('[data-track]'));
    if (!audio || !rows.length) continue;

    let current = -1;
    const select = (i: number, play: boolean) => {
      if (i < 0 || i >= rows.length) return;
      current = i;
      audio.src = rows[i].getAttribute('data-src') || '';
      rows.forEach((r, idx) => r.classList.toggle('playing', idx === i));
      if (play) audio.play().catch(() => {});
    };

    rows.forEach((row, i) => {
      const btn = row.querySelector<HTMLElement>('[data-play]') || row;
      btn.addEventListener('click', () => select(i, true));
    });
    // Chain to the next track when one finishes (stops after the last).
    audio.addEventListener('ended', () => select(current + 1, true));
    // Preload the first track's source (not its bytes) so the controls and the
    // row highlight are ready before any click.
    select(0, false);
  }
}
