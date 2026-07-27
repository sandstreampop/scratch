// Defensive patches to three's built-in shader chunks.
//
// Must be imported before any material is compiled.
//
// The problem this solves: a single NaN fragment is invisible on screen (it
// clamps to black) but it propagates through every post-processing pass that
// samples its neighbourhood, so bloom and the tone map turn a handful of bad
// pixels into a black frame. Guarding at the source is far cheaper than
// hunting the symptom downstream.

import * as THREE from 'three';

let patched = false;

export function patchShaderChunks() {
  if (patched) return;
  patched = true;

  // ---- 1. Degenerate tangent frames -------------------------------------
  //
  // getTangentFrame() builds a TBN from screen-space derivatives and guards
  // the normalisation with `det == 0.0`. That misses denormals: when the UV
  // and view-position derivatives very nearly cancel — which happens on large
  // tiled surfaces seen at grazing angles, i.e. the ground — det lands around
  // 1e-40, the equality test passes, and inversesqrt returns ~1e20. The
  // tangent explodes, normalize() returns NaN, and every PBR surface that
  // then samples the PMREM environment writes NaN into the frame.
  const LOOSE = 'float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );';
  const TIGHT = 'float scale = ( det > 1e-20 ) ? inversesqrt( det ) : 0.0;';
  let tangentPatched = false;
  for (const [name, source] of Object.entries(THREE.ShaderChunk)) {
    if (typeof source === 'string' && source.includes(LOOSE)) {
      THREE.ShaderChunk[name] = source.replace(LOOSE, TIGHT);
      tangentPatched = true;
    }
  }
  if (!tangentPatched) {
    console.warn('patch: getTangentFrame guard not found — three internals may have changed');
  }

  // ---- 2. Backstop on the shading normal --------------------------------
  //
  // Whatever the cause — a zero-area triangle, a collapsed tangent frame, a
  // normal map texel that decodes to zero — a non-unit shading normal must
  // never reach the lighting code. `!(x > 0.5)` is deliberate: it is true for
  // NaN, where `x < 0.5` would be false.
  THREE.ShaderChunk.normal_fragment_begin += `
  if ( ! ( dot( normal, normal ) > 0.5 ) ) {
    normal = vec3( 0.0, 0.0, 1.0 );
  }
  nonPerturbedNormal = normal;`;

  THREE.ShaderChunk.normal_fragment_maps += `
  if ( ! ( dot( normal, normal ) > 0.5 ) ) {
    normal = nonPerturbedNormal;
  }`;
}

patchShaderChunks();
