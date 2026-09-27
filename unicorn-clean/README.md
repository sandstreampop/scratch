# Glimmer tidies up

A code-drawn unicorn sweeps a messy kid's room clean with her glitter horn.

- `index.html` — playable canvas animation (play/pause, scrub, jump chips). Serve the folder and open it.
- `glimmer-tidies-up.mp4` — 26 s, 900×1200, 30 fps render of the same timeline.
- `render.mjs` — renders the page frame by frame with Playwright → ffmpeg (`FFMPEG=/path/to/ffmpeg node render.mjs`).
- `prep.py` / `align.py` — resize the two photos and affine-align the clean shot onto the messy one so the reveal lines up.

The unicorn, sparkles, beam and rainbow are all drawn procedurally in Canvas 2D. Only external asset: the Fredoka font (SIL Open Font License).
