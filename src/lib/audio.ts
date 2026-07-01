// Wire up the multi-track audio player that render.ts emits. The markup is a
// single card: a controls-less <audio> we drive ourselves, a custom transport
// bar (play/pause, now-playing title, seek slider, time), and a track list:
//   <figure class="audio-playlist" data-audio-playlist>
//     <audio preload="none"></audio>
//     <div class="ap-bar">
//       <button data-toggle>…</button>
//       <div class="ap-body">…<span data-nowtitle></span><span data-time></span>
//         <input data-seek type="range" min="0" max="1000">
//       </div>
//     </div>
//     <ol class="tracks">
//       <li data-track data-src="…" data-title="…"><button data-play>…</button><a download>…</a></li>
//     </ol>
//   </figure>
//
// We show a custom transport rather than native <audio controls> because the
// native player's light OS chrome never blends with the dark card. The per-row
// download links are plain <a download> and need no scripting.
//
// preload="none" means nothing is fetched until the first play. Call
// attachAudioPlaylist(root) after injecting rendered markup. Idempotent: each
// playlist is wired at most once (a data-wired flag guards re-runs).

const fmtTime = (s: number): string => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
};

export function attachAudioPlaylist(root: ParentNode = document): void {
  const lists = Array.from(root.querySelectorAll<HTMLElement>('[data-audio-playlist]'));
  for (const pl of lists) {
    if (pl.dataset.wired) continue;
    pl.dataset.wired = '1';
    const audio = pl.querySelector('audio');
    const rows = Array.from(pl.querySelectorAll<HTMLElement>('[data-track]'));
    if (!audio || !rows.length) continue;

    const toggle = pl.querySelector<HTMLButtonElement>('[data-toggle]');
    const seek = pl.querySelector<HTMLInputElement>('[data-seek]');
    const timeEl = pl.querySelector<HTMLElement>('[data-time]');
    const nowTitle = pl.querySelector<HTMLElement>('[data-nowtitle]');

    let current = -1;
    let scrubbing = false; // don't fight the user while they drag the seek bar

    const renderTime = () => {
      const d = audio.duration;
      const c = audio.currentTime;
      if (timeEl) timeEl.textContent = `${fmtTime(c)} / ${isFinite(d) ? fmtTime(d) : '0:00'}`;
      if (seek && !scrubbing) seek.value = String(isFinite(d) && d > 0 ? Math.round((c / d) * 1000) : 0);
    };

    // Load a track into the shared <audio> (and optionally start it). Highlights
    // the row and updates the now-playing label; resets the transport display.
    const select = (i: number, play: boolean) => {
      if (i < 0 || i >= rows.length) return;
      current = i;
      audio.src = rows[i].getAttribute('data-src') || '';
      rows.forEach((r, idx) => r.classList.toggle('playing', idx === i));
      if (nowTitle) nowTitle.textContent = rows[i].getAttribute('data-title') || '';
      if (seek) seek.value = '0';
      if (timeEl) timeEl.textContent = '0:00 / 0:00';
      if (play) audio.play().catch(() => {});
    };

    const playPause = () => {
      if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
    };

    toggle?.addEventListener('click', () => (current < 0 ? select(0, true) : playPause()));

    rows.forEach((row, i) => {
      const btn = row.querySelector<HTMLElement>('[data-play]') || row;
      // The active row toggles play/pause; any other row switches to it.
      btn.addEventListener('click', () => (i === current ? playPause() : select(i, true)));
    });

    if (seek) {
      seek.addEventListener('input', () => {
        scrubbing = true;
      });
      seek.addEventListener('change', () => {
        if (isFinite(audio.duration)) audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
        scrubbing = false;
      });
    }

    audio.addEventListener('timeupdate', renderTime);
    audio.addEventListener('loadedmetadata', renderTime);
    audio.addEventListener('play', () => {
      pl.classList.add('is-playing');
      toggle?.setAttribute('aria-label', 'Pause');
    });
    audio.addEventListener('pause', () => {
      pl.classList.remove('is-playing');
      toggle?.setAttribute('aria-label', 'Play');
    });
    // Chain to the next track when one finishes (stops after the last).
    audio.addEventListener('ended', () => {
      pl.classList.remove('is-playing');
      if (current + 1 < rows.length) select(current + 1, true);
    });

    // Preload the first track's source (not its bytes) so the transport and row
    // highlight are ready before any interaction.
    select(0, false);
  }
}
