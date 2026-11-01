# Romantiskt landskap

Elias Martin, *Romantiskt landskap* (before 1777, oil on canvas), rebuilt from
a single phone photo as a 3D scene you can fly into. One HTML file plus a
handful of textures, three.js from a CDN, made for a phone held in portrait.

**Open:** https://sandstreampop.github.io/scratch/

- phone: left thumb glides, right thumb looks around; leave it alone and it drifts on its own
- desktop: drag to look, WASD / scroll to move, Q/E up and down, shift for speed
- ⌂ back to the gallery · ♪ sound · i the museum wall text

## How it was made

1. `tools/01_plate.py` cuts the canvas out of the photo and straightens it.
2. `tools/02_depth.py` estimates depth with Depth Anything V2 (Large).
   `tools/02b_sharpen.py` snaps the soft depth silhouettes to the painting's colour edges.
3. `tools/03_segment.py` finds the sky (forced far) with SegFormer.
4. `tools/04_layers.py` slices the picture into six depth bands. Each band keeps going a bounded
   distance behind whatever is in front of it, with the hidden part painted in by mirroring the
   band's own brushwork, and depth discontinuities are carved out so nothing stretches. Output is
   `assets/L*.jpg` (colour), `assets/L*.png` (alpha + 16-bit depth), `assets/water.png`, `assets/scene.json`.
5. `index.html` displaces each band along the painter's view rays, keeps the camera inside a volume
   where the illusion holds, and adds the water ripples, light shafts through the trees, the stirring
   pennant and sails, a bird, and synthesised water and wind.

`work/` holds the intermediate images. `archive/` holds earlier scratch projects.
See `DOD.md` for what "done" means for this one.
