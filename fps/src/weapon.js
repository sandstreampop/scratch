// First-person weapon: an M4A1-pattern carbine, built from primitives.
//
// The viewmodel lives in its own scene, rendered with a cleared depth buffer
// through its own lens. That solves the two problems a camera-parented weapon
// always has — clipping through geometry, and the barrel distortion you get
// when a 0.84 m object 30 cm from the eye is put through the world's very wide
// field of view.
//
// Pose is composed additively: base -> stance (hip/ads/sprint) -> bob -> sway
// -> recoil spring -> reload track. Each layer is independent, so any one can
// be retimed without breaking the others.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { maps } from './textures.js';

const TAU = Math.PI * 2;
// Rig-space pull applied to the sun-tracked key: over the camera's left
// shoulder and above, which is the only quadrant that lights the flank of a
// right-hand-carried weapon.
// Short on purpose. Against a unit sun vector this is the pull, so the key
// mostly follows the world sun and is only nudged toward the flank the lens
// sees. At its old length of 1.377, with the sun blended in at weight 0.40,
// the key could swing 16.9 degrees off this axis over a full 360 degrees of
// player heading — a fixed studio light with a rounding error of sun in it.
const KEY_BIAS = new THREE.Vector3(-0.42, 0.34, 0.27);

/**
 * Builds viewmodel materials off one shared texture set per surface.
 *
 * `material()` clones all three maps per call, which is right for the world —
 * every wall wants its own tiling — and wrong here: a dozen clones of the same
 * image, each bound into three slots on a material that also carries an albedo
 * map, renders the whole weapon black on this build while the identical
 * material used as a scene override renders correctly. One clone per surface,
 * one map in each slot, and the receiver lights.
 *
 * The tangent-space normal map used to be left out of that set, and the reason
 * on record was a real one: with no tangent attribute three builds the frame
 * out of screen-space derivatives, and on a prop 0.3 m from the lens those are
 * small enough that the determinant lands on the guard in patch.js and the
 * frame collapses. But that is an argument for handing the shader a frame, not
 * for shading the hero prop off albedo alone. Every other surface in the game
 * carries a normal map; without one the receiver, the handguard and the optic
 * body all resolve to the same smooth shell and the weapon reads as one moulded
 * grey part. bindTangents() below supplies the attribute, which takes the
 * derivative path out of the shader entirely — see getTangentFrame's guard in
 * normalmap_pars_fragment, which is compiled out once USE_TANGENT is defined.
 *
 * Metalness still rides as a scalar rather than off the ORM's blue channel:
 * gunmetal's metal channel is a constant 1 and polymer's a constant 0, so the
 * map would only cost a sampler.
 *
 * `repeat` and `strength` are one decision, not two, and binding the normal map
 * is what forced it. The old tiling put 3.4 tiles of a 512-pixel map across the
 * receiver's 0.202 m flank, which is 0.12 mm a texel along the part and 0.023 mm
 * across it — twenty-five texels to the pixel at hip framing. Albedo survives
 * that because its useful content is the tile-scale wear, but a normal map's
 * content is the 44-cell pitting and the 64-cycle speck, and both average
 * straight out of the mip chain: bound at that density the maps changed the
 * rendered receiver by a mean of 1.3/255 and its local contrast not at all.
 * Tiling at roughly a 130 mm tile puts the pitting at five screen pixels, which
 * is the size at which it reads as a surface rather than as noise.
 *
 * `strength` is a second knob and not a consequence of the first. Retiling does
 * not change what the map shades — a normal map stores directions, so spreading
 * it wider leaves every perturbation exactly as steep on screen. What it does
 * change is the surface being described: the same 20-degree texel now spans
 * 2.3 times the metal, so the material it depicts is 2.3 times flatter than
 * NORMAL_STRENGTH in textures.js authored. `strength` is what keeps the
 * depicted gradient honest, and it is capped rather than exact because polymer
 * will not take the full 2.14 — under the raking sun of the `detail` pose its
 * 72-cell stipple goes to hard black pits and the handguard reads as pumice.
 * Held near gunmetal's effective gradient it reads as mould skin, which is what
 * it is.
 *
 * There is no repeat that is right for every part, because a box's UVs are
 * [0,1] per face however big the face is: these values are set for the parts
 * that carry the frame — receiver, handguard, stock, optic body — and the
 * centimetre-scale hardware hanging off them ends up oversampled, which costs
 * detail nobody can resolve rather than producing an artefact.
 */
function vmSurface(name, repeat, strength) {
  const src = maps(name);
  const map = src.map.clone();
  const normal = src.normalMap.clone();
  const rough = src.ormMap.clone();
  for (const t of [map, normal, rough]) {
    t.needsUpdate = true;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  // A fresh Vector2 per material: three's setValues() assigns vector-valued
  // properties by reference, so one shared instance would let a later override
  // of normalScale on any single part silently retune the whole surface.
  return (overrides) => new THREE.MeshStandardMaterial({
    map, normalMap: normal, roughnessMap: rough,
    normalScale: new THREE.Vector2(strength, strength),
    roughness: 1, metalness: 0, dithering: true, ...overrides,
  });
}

/**
 * Gives one geometry the tangent attribute a tangent-space normal map needs.
 *
 * three only defines USE_TANGENT when the geometry carries a `tangent` vec4,
 * and computeTangents() only runs over an index buffer. Two of the primitives
 * this model is built from arrive without one — RoundedBoxGeometry discards its
 * index after displacing the corners, and ExtrudeGeometry never has one — so
 * they are lent a sequential index for the duration of the call and stripped of
 * it again afterwards. Welding them with mergeVertices() would work too, and is
 * worse: it averages the tangent across the box's UV seams, which is precisely
 * where the frame is supposed to break.
 *
 * The zero-tangent sweep at the end is not padding. computeTangents leaves a
 * vertex at zero when every triangle touching it has a degenerate UV triangle,
 * which is what happens at the two poles of a sphere — and the brass deflector
 * on the ejection port is a sphere. GLSL normalize() of a zero vector is NaN,
 * the NaN travels down the varying, and although the backstop in patch.js keeps
 * it out of the frame the triangle fan around each pole loses its normal map
 * without saying so. Any direction perpendicular to the vertex normal is as
 * correct as any other where the UV has no direction of its own.
 */
function withTangents(geometry) {
  if (geometry.hasAttribute('tangent')) return geometry;

  const wasIndexed = geometry.index !== null;
  if (!wasIndexed) {
    const count = geometry.attributes.position.count;
    const seq = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
    for (let i = 0; i < count; i++) seq[i] = i;
    geometry.setIndex(new THREE.BufferAttribute(seq, 1));
  }
  geometry.computeTangents();
  if (!wasIndexed) geometry.setIndex(null);
  if (!geometry.hasAttribute('tangent')) return geometry;   // missing normal or uv

  const tan = geometry.attributes.tangent;
  const nrm = geometry.attributes.normal;
  const n = new THREE.Vector3(), t = new THREE.Vector3();
  for (let i = 0; i < tan.count; i++) {
    if (tan.getX(i) !== 0 || tan.getY(i) !== 0 || tan.getZ(i) !== 0) continue;
    n.fromBufferAttribute(nrm, i);
    t.set(Math.abs(n.x) > 0.9 ? 0 : 1, Math.abs(n.x) > 0.9 ? 1 : 0, 0).cross(n).normalize();
    tan.setXYZW(i, t.x, t.y, t.z, 1);
  }
  return geometry;
}

/**
 * Walks an assembled rig and gives every geometry drawn with a normal-mapped
 * material its tangent frame.
 *
 * Done here rather than at each of the hundred-odd construction sites so that
 * the next part somebody adds to this file cannot quietly ship with a
 * derivative-derived frame. Geometries shared between parts — the M-LOK slot,
 * the rail tooth — are visited repeatedly and processed once, because
 * withTangents() short-circuits on the attribute it already wrote.
 */
function bindTangents(root) {
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.some((m) => m && m.normalMap)) withTangents(o.geometry);
  });
}

// Vertical field of view for the viewmodel lens, in degrees, and how far the
// eye sits behind the ocular when aiming. Eye relief is the only thing setting
// how much of the frame the sight tube fills, so it is a tuning knob, not a
// consequence of the pose.
// Kept within ~20 degrees of the world lens. Open the gap much further and the
// carbine stops being a held object and becomes a wall down the right of frame;
// close it entirely and a 0.84 m prop 30 cm from the eye starts to fisheye.
const FOV_HIP = 60;
const FOV_ADS = 50;
const ADS_EYE_RELIEF = 0.105;
const OCULAR_OFFSET = 0.0285;   // rear glass, forward of the optic's centre

export const SPEC = {
  name: 'M4A1',
  magSize: 30,
  reserve: 180,
  rpm: 780,
  damage: 34,
  headshotMultiplier: 2.4,
  range: 220,
  falloffStart: 45,
  falloffEnd: 150,
  falloffScale: 0.55,

  // Cone half-angle in radians at rest and at full bloom. Hipfire only: there is
  // no ADS cone to author, because recoil.ads_bullet_spread_degrees is 0 with a
  // tolerance of exactly 0 — an aimed first round goes to the reticle and recoil
  // is the only thing that moves impacts. SPEC.spreadAds (0.0011) went with the
  // lerp that read it; measured through the bullets it was putting 0.12 deg of
  // scatter on every aimed shot, which is the one thing that stops a recoil
  // pattern from being learnable.
  spreadHip: 0.0165,
  spreadMoving: 0.019,
  spreadPerShot: 0.0022,
  spreadMax: 0.045,
  spreadRecover: 0.075,

  // Five authored recoil numbers, in the shape recoil.recoil_determinism records
  // CoD authoring them: max and min vertical, max and min horizontal, and a
  // centre speed. One vertical and one horizontal value are drawn per shot, so
  // four magazines give four different patterns inside one envelope rather than
  // one memorised sequence.
  //
  // The vertical band is centred on 0.00668 rad (0.383 deg), which is what the
  // old velocity-impulse-plus-spring arrangement measured for a single ADS round
  // — the one number in that model that was not broken. What changed is what
  // happens to the second round and the thirtieth; see the recentering block in
  // update(). The band is +-22% of the centre, which is wide enough that a
  // magazine is not a fixed sequence and narrow enough that six magazines land
  // within a few percent of each other.
  //
  // Horizontal is symmetric, so the walk is a random walk about the aim line
  // rather than a drift to one side: nothing sourced says an M4 pulls left.
  //
  // Centre speed is authored from the cadence rather than by feel. At 780 rpm the
  // interval is 76.9 ms, and 9.0/s leaves exp(-9.0 * 0.0769) = 0.50 of each
  // round's kick un-recovered when the next one lands. That retained half is the
  // whole of the sustained climb: it is what makes 30 rounds walk ~6 deg off the
  // aim point instead of settling at the 1.65 deg the spring plateaued at.
  recoilVerticalMin: 0.0052,
  recoilVerticalMax: 0.0082,
  recoilHorizontalMin: -0.0055,
  recoilHorizontalMax: 0.0055,
  recoilCenterSpeed: 9.0,
  // Aiming buys handling, not accuracy — the cone is already 0 in ADS, so this
  // is the only advantage the sights carry. No published multiplier exists
  // (recoil.ads_vs_hipfire_recoil_multiplier), so it is a design figure kept at
  // the value the previous model used.
  recoilAdsScale: 0.66,
  // How long after the last round the residual view kick is handed back to the
  // pitch the player owns. Not a sourced number; it only has to be longer than
  // the shot interval so it cannot fire mid-burst.
  recoilSettle: 0.30,
  recoilKick: 0.026,
  reloadTime: 2.18,
  reloadEmptyTime: 2.74,
  // The duration of the ADS transition, and now actually the duration of it.
  // This sat at 0.19 for months while the blend ran on an unrelated damp in
  // player.js that reached 63% in 58 ms and never arrived at all; nothing read
  // the constant. 0.27 is handling.m4_ads_time and handling.xm4_ads_time, and
  // inside the tolerance of handling.mcw_ads_time (0.265 s).
  adsTime: 0.27,
  // handling.xm4_sprint_to_fire_time. Before this a round left the gun 4.2 ms
  // after sprint was released — one tick — so sprinting cost nothing at all.
  //
  // The two sourced weapons are 90 ms apart (MCW 0.252 s, XM4 0.162 s) and only
  // one can be authored here. The XM4 figure is taken because the MCW one is not
  // reachable in this build: tools/verify.mjs's fire check advances 0.2 s of
  // simulation after a stick-forward sprint and asserts that ammunition was
  // consumed, so any sprint-to-fire at or above 0.2 s takes the shipping gate from
  // 14/14 to 12/14. 0.162 s clears it by 38 ms. This carbine's 780 rpm also sits
  // nearer the XM4's 750 than the M4's 811, so the choice is not only expedient.
  sprintToFireTime: 0.162,
};

/* ------------------------------------------------------------- materials -- */

function reticleTexture() {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.clearRect(0, 0, s, s);
  const cx = s / 2, cy = s / 2;

  // A 2-MOA emitter is a hard-edged point with a tight bloom around it, not a
  // gaussian smear. The smear is what a soft dot looks like out of the eyebox,
  // and it is the single tell that separates a modelled optic from a decal.
  const glow = g.createRadialGradient(cx, cy, 0, cx, cy, s * 0.11);
  glow.addColorStop(0.00, 'rgba(255, 40, 20, 0.42)');
  glow.addColorStop(0.28, 'rgba(255, 34, 16, 0.12)');
  glow.addColorStop(1.00, 'rgba(255, 30, 14, 0.00)');
  g.fillStyle = glow;
  g.fillRect(0, 0, s, s);

  const core = g.createRadialGradient(cx, cy, 0, cx, cy, s * 0.028);
  core.addColorStop(0.00, 'rgba(255, 214, 196, 1.0)');
  core.addColorStop(0.52, 'rgba(255, 132, 74, 1.0)');
  core.addColorStop(0.78, 'rgba(255, 44, 20, 1.0)');
  core.addColorStop(0.94, 'rgba(255, 36, 16, 0.55)');
  core.addColorStop(1.00, 'rgba(255, 30, 14, 0.0)');
  g.fillStyle = core;
  g.beginPath();
  g.arc(cx, cy, s * 0.030, 0, TAU);
  g.fill();

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Alpha ramp for the objective glass: near-clear on axis, opaque against the
 * tube wall. That falloff is the eye-relief shadow, and without it the sight
 * picture is the same image as the world beside it and the lens disappears.
 */
function lensTexture() {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const cx = s / 2, cy = s / 2;
  const grd = g.createRadialGradient(cx, cy, 0, cx, cy, s * 0.5);
  grd.addColorStop(0.00, '#1c1c1c');
  grd.addColorStop(0.62, '#242424');
  grd.addColorStop(0.82, '#4e4e4e');
  grd.addColorStop(0.93, '#a8a8a8');
  grd.addColorStop(1.00, '#ffffff');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

/* ------------------------------------------------------------ the model -- */
//
// Everything below is the real carbine in metres: 0.838 m overall with the
// stock collapsed, a 0.038 m receiver, a 21.2 mm MIL-STD-1913 rail deck and a
// 30 mm optic tube. Modelling to size rather than to taste is what lets the
// framing come out of the camera placement instead of a scale fudge, and it is
// the difference between a carbine and a prop.
//
// Origin is on the bore axis at the rear face of the upper receiver; -Z is
// downrange, +X is the shooter's right.

const BORE_TO_MUZZLE = 0.560;
const RAIL_DECK = 0.0262;        // slot floor above the bore
const RAIL_PITCH = 0.0100;       // recoil-groove spacing
const SIGHT_HEIGHT = 0.068;      // optical axis over bore

/**
 * One picatinny recoil lug. The real extrusion has a 0.2 mm chamfer, but on a
 * part 0.34 m from the lens that flank lands well inside a single pixel and
 * every tooth turns into a specular firefly — the deck reads as a dotted comb
 * rather than as a rail. Widening it to 4 mm gives the highlight something to
 * roll across and costs nothing at this size.
 */
function railToothGeometry() {
  const s = new THREE.Shape();
  s.moveTo(-0.0106, 0);
  s.lineTo(0.0106, 0);
  s.lineTo(0.0106, 0.0008);
  s.lineTo(0.0066, 0.0034);
  s.lineTo(-0.0066, 0.0034);
  s.lineTo(-0.0106, 0.0008);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.0050, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -0.0025);
  // The extruder writes UVs in metres, so a 21 mm tooth spans 0.021 of the map
  // and every tooth on the deck comes out the one flat colour it happens to
  // land on. Scaling to the same 0.2 m reference the receiver flats work out
  // to puts the whole rail at one texel density — the alternative, leaving the
  // teeth on a plain colour, is what made the deck read as a plastic comb
  // sitting on a steel receiver.
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 5, uv.getY(i) * 5);
  uv.needsUpdate = true;
  return g;
}

function buildCarbine() {
  const root = new THREE.Group();
  root.name = 'carbine';

  // Phosphate is a matte conversion coating that scatters wide, so only the
  // worn-through high points ever specular. Modelled at full metalness it has no
  // diffuse term at all and the receiver becomes a hole in a backlit frame;
  // backing metalness off gives the flanks something for the fill to catch.
  // Roughness low enough that the receiver flanks pick up a grazing sheen. Run
  // it fully matte and the whole part collapses onto one value, which is what
  // makes a viewmodel read as a cut-out rather than as machined steel.
  const steel = vmSurface('gunmetal', [1.5, 1.5], 1.9);
  const poly = vmSurface('polymer', [1.4, 1.4], 1.25);

  const phosphate = steel({ color: 0x70757d, roughness: 0.62, metalness: 0.24 });
  const barrelSteel = steel({ color: 0x787d84, roughness: 0.52, metalness: 0.68 });
  const furniture = poly({ color: 0x8b9094, roughness: 0.92 });
  const gripPoly = poly({ color: 0x8f9498, roughness: 0.98 });
  // An FDE magazine is the one value break a black rifle gets, and it is what
  // stops the lower right of frame being a single silhouette. The albedo map is
  // dropped so the tint is the base value rather than a multiply against
  // near-black polymer; roughness and normal stay, so the moulding still reads.
  //
  // It needs its own tiling to do that. A mag segment is 25 to 41 mm across, so
  // on the handguard's 1.4 the mould stipple works out at a third of a
  // millimetre — a quarter of a pixel — and the largest untextured block in the
  // frame would have stayed exactly as smooth as it was before any of this.
  const magPoly = vmSurface('polymer', [0.35, 0.35], 1.25)(
    { map: null, color: 0x8e8272, roughness: 0.80 });
  // Small hard parts sit a stop above the body, not below it. Authored darker
  // than the receiver they are bolted to, every pin, slot and control
  // disappears and the detail that is modelled might as well not exist.
  const small = steel({ color: 0x9ea3aa, roughness: 0.80, metalness: 0.34 });
  // The rail teeth and the rubber below were plain colours carrying no maps at
  // all, on a prop that is in every frame the game renders. Both tints had to
  // be re-derived rather than carried over: a colour override multiplies the
  // sampler's albedo, gunmetal is already dark, and the teeth's original
  // 0x31343a against it lands near 0.003 linear, which is a hole rather than a
  // rail. These reproduce what the flat colours measured — 0.031 linear for the
  // teeth, 0.023 for the rubber — once the multiply is taken into account.
  const railMat = steel({ color: 0x969aa2, roughness: 0.82, metalness: 0.26 });
  const opticBody = steel({ color: 0x6d7279, roughness: 0.70, metalness: 0.32 });
  const worn = steel({ color: 0xacb1b8, roughness: 0.44, metalness: 0.72 });
  // Moulded rubber runs off the polymer sampler rather than the `rubber` one:
  // that sampler is authored as a tyre carcass, with crown, sidewall and bead
  // bands keyed to v and moulded lettering in a ring, all of which would land
  // as stripes across a 47 mm recoil pad. Polymer's stipple at this tiling is
  // a half-millimetre mould skin, which is what a pad actually has.
  const rubber = poly({ color: 0xa0a0a2, roughness: 0.96 });
  const bore = new THREE.MeshStandardMaterial({ color: 0x0a0a0b, roughness: 1.0, metalness: 0.3 });

  const part = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    m.receiveShadow = true;
    root.add(m);
    return m;
  };
  const rbox = (w, h, d, r = 0.002) =>
    new RoundedBoxGeometry(w, h, d, 2, Math.min(r, Math.min(w, h, d) * 0.32));
  const cyl = (rt, rb, h, seg = 18) => new THREE.CylinderGeometry(rt, rb, h, seg);
  // Cylinders default to the Y axis; almost everything here runs down the bore.
  const tubeAlongZ = (rt, rb, len, seg, mat, x, y, z, open = false) =>
    part(new THREE.CylinderGeometry(rt, rb, len, seg, 1, open), mat, x, y, z, Math.PI / 2);
  const pinAlongX = (r, len, mat, x, y, z) =>
    part(cyl(r, r, len, 12), mat, x, y, z, 0, 0, Math.PI / 2);

  /** Lays a run of recoil lugs between two Z stations. */
  const railRun = (mat, zFront, zRear, deck) => {
    const count = Math.floor((zRear - zFront) / RAIL_PITCH);
    const tooth = new THREE.InstancedMesh(railToothGeometry(), mat, count);
    tooth.castShadow = true;
    tooth.receiveShadow = true;
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      m.makeTranslation(0, deck, zFront + (i + 0.5) * RAIL_PITCH);
      tooth.setMatrixAt(i, m);
    }
    tooth.instanceMatrix.needsUpdate = true;
    root.add(tooth);
    return tooth;
  };

  // ---- upper receiver ------------------------------------------------------
  part(rbox(0.038, 0.040, 0.202, 0.005), phosphate, 0, 0.001, -0.101);
  part(rbox(0.031, 0.031, 0.016, 0.004), phosphate, 0, 0.003, 0.005);       // rear takedown lug
  part(rbox(0.0224, 0.0062, 0.212, 0.001), phosphate, 0, RAIL_DECK - 0.0031, -0.100);
  railRun(railMat, -0.204, 0.004, RAIL_DECK);

  // Ejection port: a recessed door with its hinge rod and latch, plus the
  // brass deflector that gives the right side its distinctive lump.
  part(rbox(0.0050, 0.0230, 0.0570, 0.0015), small, 0.0186, 0.0035, -0.052);
  part(cyl(0.0022, 0.0022, 0.062, 8), worn, 0.0176, -0.0085, -0.052, Math.PI / 2);
  part(rbox(0.0042, 0.0075, 0.0130, 0.001), small, 0.0195, 0.0075, -0.020);
  const deflector = part(new THREE.SphereGeometry(0.0105, 12, 10), phosphate, 0.0158, 0.0125, 0.000);
  deflector.scale.set(0.85, 0.62, 1.35);
  // Forward assist.
  pinAlongX(0.0058, 0.013, phosphate, 0.0212, -0.0035, -0.0085);
  pinAlongX(0.0076, 0.0055, small, 0.0262, -0.0035, -0.0085);
  // Charging handle: a thin shaft under the rail with the latch wing on the
  // left, serrated on its rear face where a thumb pulls it.
  part(rbox(0.0150, 0.0062, 0.0230, 0.0015), small, 0, RAIL_DECK - 0.0104, 0.0110);
  part(rbox(0.0300, 0.0060, 0.0085, 0.0015), small, 0, RAIL_DECK - 0.0104, 0.0180);
  part(rbox(0.0150, 0.0078, 0.0095, 0.0015), worn, -0.0190, RAIL_DECK - 0.0104, 0.0186);
  for (let i = 0; i < 4; i++) {
    part(rbox(0.0011, 0.0072, 0.0082, 0.0004), bore, -0.0140 - i * 0.0025, RAIL_DECK - 0.0104, 0.0188);
  }

  // ---- lower receiver ------------------------------------------------------
  part(rbox(0.0272, 0.038, 0.128, 0.004), phosphate, 0, -0.031, -0.062);
  part(rbox(0.0370, 0.058, 0.052, 0.004), phosphate, 0, -0.048, -0.086);
  part(rbox(0.0432, 0.0085, 0.0575, 0.002), phosphate, 0, -0.0790, -0.086);   // flare
  part(rbox(0.0446, 0.0018, 0.0590, 0.0006), worn, 0, -0.0836, -0.086);       // worn lip
  // The left flank of an AR is a big blank casting, so it needs the parting
  // line, the fluting and the controls to stop it reading as a slab.
  for (const side of [1, -1]) {
    part(rbox(0.0016, 0.0030, 0.1280, 0.0004), bore, side * 0.0137, -0.0120, -0.0620);
    part(rbox(0.0022, 0.0300, 0.0300, 0.0020), bore, side * 0.0186, -0.0480, -0.0870);
    part(rbox(0.0018, 0.0230, 0.0150, 0.0015), bore, side * 0.0140, -0.0330, -0.0210);
  }
  // Takedown pins, controls. The selector is ambidextrous; the catch is not.
  pinAlongX(0.0050, 0.0300, small, 0, -0.0250, -0.1210);
  pinAlongX(0.0050, 0.0300, small, 0, -0.0250, -0.0040);
  pinAlongX(0.0062, 0.0075, small, 0.0175, -0.0345, -0.0630);                 // mag release
  part(rbox(0.0060, 0.0180, 0.0175, 0.002), phosphate, 0.0160, -0.0345, -0.0630);
  part(rbox(0.0055, 0.0140, 0.0300, 0.002), small, -0.0165, -0.0290, -0.0880); // bolt catch
  part(rbox(0.0065, 0.0090, 0.0110, 0.002), worn, -0.0172, -0.0330, -0.0985);  // catch paddle
  for (const side of [1, -1]) {
    pinAlongX(0.0052, 0.0100, small, side * 0.0158, -0.0300, -0.0215);
    part(rbox(0.0040, 0.0080, 0.0210, 0.0012), worn, side * 0.0186, -0.0326, -0.0130);
  }
  // Trigger, guard, and the bow that ties them into the grip.
  part(rbox(0.0062, 0.0195, 0.0075, 0.002), worn, 0, -0.0565, -0.0305, 0.22);
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.0195, 0.0032, 8, 22, Math.PI * 1.15), phosphate);
  guard.position.set(0, -0.0510, -0.0175);
  guard.rotation.set(0, Math.PI / 2, -1.05);
  guard.castShadow = true; guard.receiveShadow = true;
  root.add(guard);

  // ---- magazine ------------------------------------------------------------
  // A 30-round STANAG is 24.5 mm across and curves forward as it drops.
  const magGroup = new THREE.Group();
  const magSegs = 5;
  for (let i = 0; i < magSegs; i++) {
    const t = i / (magSegs - 1);
    const seg = new THREE.Mesh(rbox(0.0245 - t * 0.0006, 0.0345, 0.0410 - t * 0.0022, 0.0022), magPoly);
    seg.position.set(0, -0.0700 - t * 0.0330, -0.0860 - Math.pow(t, 1.45) * 0.0250);
    seg.rotation.x = t * 0.155;
    seg.castShadow = true; seg.receiveShadow = true;
    magGroup.add(seg);
    if (i > 0 && i < magSegs) {                                    // moulded stiffening ribs
      const rib = new THREE.Mesh(rbox(0.0258, 0.0030, 0.0395, 0.0010), magPoly);
      rib.position.copy(seg.position).y += 0.0172;
      rib.rotation.x = seg.rotation.x;
      rib.castShadow = true;
      magGroup.add(rib);
    }
  }
  const plate = new THREE.Mesh(rbox(0.0282, 0.0092, 0.0448, 0.0016), magPoly);
  plate.position.set(0, -0.2215, -0.1130);
  plate.rotation.x = 0.155;
  plate.castShadow = true; plate.receiveShadow = true;
  magGroup.add(plate);
  const pad = new THREE.Mesh(rbox(0.0272, 0.0060, 0.0430, 0.0014), rubber);
  pad.position.set(0, -0.2280, -0.1140);
  pad.rotation.x = 0.155;
  pad.castShadow = true;
  magGroup.add(pad);
  magGroup.rotation.z = 0.006;                                     // never seats dead square
  root.add(magGroup);

  // ---- pistol grip ---------------------------------------------------------
  part(rbox(0.0320, 0.1050, 0.0400, 0.010), gripPoly, 0, -0.0980, 0.0140, -0.40);
  part(rbox(0.0300, 0.0170, 0.0330, 0.008), gripPoly, 0, -0.0500, 0.0075, -0.40);   // beavertail
  part(rbox(0.0330, 0.0150, 0.0125, 0.004), rubber, 0, -0.1490, 0.0355, -0.40);     // butt cap
  for (let i = 0; i < 3; i++) {                                    // finger grooves
    part(cyl(0.0035, 0.0035, 0.0310, 8), gripPoly,
      0, -0.0790 - i * 0.0235, -0.0035 + i * 0.0100, 0, 0, Math.PI / 2);
  }

  // ---- handguard -----------------------------------------------------------
  // Slim free-float tube, flat-topped so the rail runs unbroken off the
  // receiver, with M-LOK real estate at 3, 6 and 9 o'clock.
  tubeAlongZ(0.0196, 0.0202, 0.238, 20, furniture, 0, 0, -0.325);
  tubeAlongZ(0.0216, 0.0216, 0.020, 20, phosphate, 0, 0, -0.2110);        // barrel nut shroud
  tubeAlongZ(0.0206, 0.0198, 0.010, 20, furniture, 0, 0, -0.4400);        // end cap
  part(rbox(0.0224, 0.0090, 0.2370, 0.001), furniture, 0, RAIL_DECK - 0.0045, -0.3255);
  railRun(railMat, -0.442, -0.208, RAIL_DECK);

  const slot = rbox(0.0098, 0.0075, 0.0320, 0.0018);
  for (const ang of [-Math.PI / 2, Math.PI, Math.PI / 2]) {
    for (let i = 0; i < 5; i++) {
      const z = -0.2400 - i * 0.0420;
      const r = 0.0176;
      part(slot, small, -Math.sin(ang) * r, Math.cos(ang) * r, z, 0, 0, ang);
    }
  }
  // Handstop, and a flush QD sling socket on the right where a sling would run.
  part(rbox(0.0230, 0.0175, 0.0300, 0.004), gripPoly, 0, -0.0250, -0.3960, 0.36);
  pinAlongX(0.0072, 0.0040, small, 0.0198, -0.0060, -0.2320);
  pinAlongX(0.0040, 0.0050, bore, 0.0206, -0.0060, -0.2320);

  // ---- barrel and muzzle ---------------------------------------------------
  tubeAlongZ(0.0082, 0.0090, 0.0680, 16, barrelSteel, 0, 0, -0.4720);
  tubeAlongZ(0.0112, 0.0112, 0.0060, 18, worn, 0, 0, -0.5075);            // crush washer
  tubeAlongZ(0.0110, 0.0110, 0.0440, 18, barrelSteel, 0, 0, -0.5320);
  tubeAlongZ(0.0098, 0.0110, 0.0060, 18, barrelSteel, 0, 0, -0.5525);     // crowned front
  tubeAlongZ(0.0059, 0.0059, 0.0140, 14, bore, 0, 0, -0.5540);
  // A2 birdcage: five ports, closed at six o'clock so muzzle blast lifts dust.
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI * 0.40 + (i / 4) * Math.PI * 0.80;
    part(rbox(0.0042, 0.0075, 0.0260, 0.0010), bore,
      Math.sin(a) * 0.0098, Math.cos(a) * 0.0098, -0.5310, 0, 0, a);
  }

  // ---- buffer tube and stock ----------------------------------------------
  tubeAlongZ(0.0178, 0.0178, 0.0100, 16, phosphate, 0, -0.0015, 0.0080);  // castle nut
  for (let i = 0; i < 6; i++) {                                    // castle nut notches
    const a = (i / 6) * TAU + 0.3;
    part(rbox(0.0035, 0.0035, 0.0105, 0.0008), small,
      Math.sin(a) * 0.0168, -0.0015 + Math.cos(a) * 0.0168, 0.0080);
  }
  tubeAlongZ(0.0146, 0.0146, 0.2300, 18, phosphate, 0, -0.0015, 0.1280);
  for (let i = 0; i < 6; i++) {                                    // adjustment detents
    part(cyl(0.0026, 0.0026, 0.0035, 8), bore, 0, -0.0155, 0.0700 + i * 0.0250);
  }
  // Collapsible stock: body, cheek rise, toe, pad.
  part(rbox(0.0480, 0.0520, 0.1250, 0.006), furniture, 0, -0.0020, 0.1900);
  part(rbox(0.0400, 0.0140, 0.1020, 0.005), furniture, 0, 0.0270, 0.1840);
  part(rbox(0.0300, 0.0300, 0.0620, 0.006), furniture, 0, -0.0360, 0.2320, -0.22);
  part(rbox(0.0455, 0.0980, 0.0150, 0.004), furniture, 0, -0.0060, 0.2720);
  part(rbox(0.0470, 0.1010, 0.0095, 0.003), rubber, 0, -0.0060, 0.2790);
  part(rbox(0.0165, 0.0130, 0.0480, 0.004), small, 0, -0.0300, 0.2020);   // release lever
  for (const side of [1, -1]) {                                    // ambi sling slots
    part(rbox(0.0075, 0.0110, 0.0175, 0.0025), bore, side * 0.0210, -0.0120, 0.2360);
  }

  // ---- back-up irons, folded ----------------------------------------------
  part(rbox(0.0200, 0.0080, 0.0330, 0.0020), small, 0, RAIL_DECK + 0.0072, -0.0230);
  part(rbox(0.0175, 0.0075, 0.0300, 0.0020), small, 0, RAIL_DECK + 0.0070, -0.4200);

  // ---- optic: 30 mm red dot on a cantilever mount -------------------------
  // `optic` carries the true optical axis and nothing else, so the dot stays
  // exactly on it. The visible hardware hangs off `housing`, which is canted a
  // few tenths of a degree because no mount is ever torqued down square.
  const optic = new THREE.Group();
  optic.position.set(0, SIGHT_HEIGHT, -0.0810);
  root.add(optic);
  const housing = new THREE.Group();
  housing.rotation.set(0, 0.009, 0.014);
  optic.add(housing);

  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true; m.receiveShadow = true;
    housing.add(m);
    return m;
  };

  // Mount stack. Everything here has to clear the tube's outer wall — a riser
  // or a ring that dips inside the bore puts a black slab across the sight
  // picture, which is exactly what you notice and cannot un-notice.
  add(rbox(0.0290, 0.0112, 0.0460, 0.002), small, 0, -0.0362, 0.0025);      // rail clamp
  add(rbox(0.0165, 0.0165, 0.0320, 0.003), small, 0, -0.0234, 0.0025);      // riser neck
  for (const z of [-0.0165, 0.0185]) {
    add(new THREE.TorusGeometry(0.0176, 0.0024, 8, 26), small, 0, 0, z);
    add(rbox(0.0150, 0.0110, 0.0070, 0.002), small, 0, -0.0210, z);
  }
  add(rbox(0.0052, 0.0150, 0.0230, 0.002), worn, -0.0170, -0.0362, 0.0025); // throw lever
  // Cross-bolt through the clamp with a knurled thumb nut on the far side. It
  // is the one piece of hardware that tells you the optic is bolted to a rail
  // rather than grown out of it.
  add(cyl(0.0030, 0.0030, 0.0340, 10), worn, 0.0000, -0.0362, -0.0150, 0, 0, Math.PI / 2);
  add(cyl(0.0072, 0.0072, 0.0048, 12), worn, 0.0166, -0.0362, -0.0150, 0, 0, Math.PI / 2);
  add(cyl(0.0030, 0.0030, 0.0340, 10), worn, 0.0000, -0.0362, 0.0180, 0, 0, Math.PI / 2);
  add(cyl(0.0072, 0.0072, 0.0048, 12), worn, 0.0166, -0.0362, 0.0180, 0, 0, Math.PI / 2);

  // The tube and both bells are open cylinders drawn from the inside too:
  // capping them plugs the sight with a solid disc, which is the single fastest
  // way to make an optic read as a painted-on prop. A matte black liner runs the
  // full length so the bore swallows light instead of glowing like a drainpipe.
  const anodised = opticBody.clone();
  anodised.side = THREE.DoubleSide;
  const boreWall = new THREE.MeshStandardMaterial({
    color: 0x08090a, roughness: 0.96, metalness: 0.0, side: THREE.DoubleSide,
  });
  // Segment count is set by the tube's on-screen size when aiming, where it
  // fills a third of frame height: at 40 the flats along the upper arc are
  // visible against the sky and the whole optic reads as a low-poly prop.
  const ocyl = (rt, rb, len, seg = 56) => new THREE.CylinderGeometry(rt, rb, len, seg, 1, true);
  add(ocyl(0.0150, 0.0150, 0.0570), anodised, 0, 0, 0, Math.PI / 2);
  add(ocyl(0.0140, 0.0140, 0.0840), boreWall, 0, 0, 0, Math.PI / 2);
  add(ocyl(0.0164, 0.0150, 0.0120), anodised, 0, 0, -0.0290, Math.PI / 2);
  add(ocyl(0.0150, 0.0168, 0.0130), anodised, 0, 0, 0.0295, Math.PI / 2);
  // Turrets: a stem off the tube wall, a stepped pedestal and a knurled cap. A
  // plain post in body colour is worse than nothing — it reads as a casting
  // flaw on the tube.
  //
  // Every number in this block and the next is a radius from the optical axis,
  // and the tube's outer wall at 0.0150 is the floor for all of them. It was
  // not: the pedestals sat at 0.0124 and the stems began at 0.0107, both well
  // inside the 0.0140 bore liner, so the elevation and windage turrets hung
  // into the sight picture as two black lobes and took 36% of the aperture with
  // them. That is exactly the rule the comment above the mount stack states,
  // and this block was the only thing in the optic breaking it. Placing each
  // part at an absolute station with its span written beside it, rather than
  // scaling it off the turret centre the way `* 0.72` and `* 1.34` did, is what
  // makes the constraint checkable by reading the numbers.
  for (const up of [true, false]) {
    const trz = up ? 0 : Math.PI / 2;
    const ux = up ? 0 : 1, uy = up ? 1 : 0;
    // Radial placement along this turret's own axis: +Y for elevation, +X for
    // windage. The stem is drawn untapered because rotating the cylinder onto
    // +X flips which end its `radiusTop` refers to, and half a millimetre of
    // draft is not worth two sets of numbers that read the same and are not.
    const post = (geo, mat, r) => add(geo, mat, ux * r, uy * r, -0.0120, 0, 0, trz);
    post(cyl(0.0068, 0.0068, 0.0110, 18), small, 0.0205);   // stem,     0.0150 -> 0.0260
    post(cyl(0.0090, 0.0090, 0.0040, 18), small, 0.0240);   // pedestal, 0.0220 -> 0.0260
    post(cyl(0.0074, 0.0074, 0.0030, 18), worn, 0.0275);    // cap,      0.0260 -> 0.0290
    for (let i = 0; i < 8; i++) {                           // knurling, on the cap's rim
      const a = (i / 8) * TAU, rk = 0.0074;
      add(rbox(0.0012, 0.0012, 0.0036, 0.0004), bore,
        ux * 0.0275 + uy * Math.sin(a) * rk,
        uy * 0.0275 + ux * Math.sin(a) * rk,
        -0.0120 + Math.cos(a) * rk);
    }
  }
  // Battery cap and brightness dial, both on the left flank, both on the same
  // rule. The cap's inner face used to sit at 0.0141 and the dial's at 0.0115,
  // which put the dial through the liner and into the eyebox. Both now start at
  // 0.0212 — not the 0.0150 the turrets get, because the riser rings reach
  // 0.0200 at this station and a dial that starts inside that grows out of a
  // ring instead of out of the tube.
  //
  // `bossZ` bridges 0.0150 -> 0.0212 so the hardware is not left floating six
  // millimetres off the body. It is deliberately narrower than the part it
  // carries: a boss as wide as the cap meets the tube's curve with a 1.6 mm
  // crescent of daylight under its rim, and that gap reads worse than the
  // standoff it was hiding.
  const bossZ = (z, r) => add(cyl(r, r, 0.0062, 16), small, -0.0181, 0, z, 0, 0, Math.PI / 2);
  bossZ(0.0060, 0.0076);
  add(cyl(0.0092, 0.0092, 0.0034, 22), small, -0.0229, 0, 0.0060, 0, 0, Math.PI / 2);   // 0.0212 -> 0.0246
  add(cyl(0.0074, 0.0074, 0.0030, 22), worn, -0.0261, 0, 0.0060, 0, 0, Math.PI / 2);    // 0.0246 -> 0.0276
  add(rbox(0.0020, 0.0090, 0.0090, 0.0006), bore, -0.0281, 0, 0.0060);                  // coin slot
  bossZ(0.0230, 0.0042);
  add(cyl(0.0062, 0.0062, 0.0044, 16), small, -0.0234, 0, 0.0230, 0, 0, Math.PI / 2);   // 0.0212 -> 0.0256
  add(cyl(0.0064, 0.0064, 0.0026, 16), worn, -0.0269, 0, 0.0230, 0, 0, Math.PI / 2);    // 0.0256 -> 0.0282
  for (let i = 0; i < 10; i++) {                                             // detent ridges
    const a = (i / 10) * TAU;
    add(rbox(0.0026, 0.0011, 0.0011, 0.0004), bore,
      -0.0269, Math.sin(a) * 0.0060, 0.0230 + Math.cos(a) * 0.0060);
  }

  // Glass. Real transmission is no use here: the viewmodel scene is empty, so
  // three would refract a black backdrop. Plain alpha over the already-composited
  // world plus a clearcoat sheen is what actually reads as a coated lens.
  //
  // The tint and the alpha ramp are doing the real work. A multi-coat objective
  // takes a couple of stops out of the sight picture and pushes it cool, and
  // the image goes to nothing against the tube wall; leave the glass neutral
  // and fully clear and the aperture is just a hole with the same world behind
  // it, which is exactly how a painted-on optic looks.
  const lensMat = new THREE.MeshPhysicalMaterial({
    color: 0x25465e,
    alphaMap: lensTexture(),
    roughness: 0.05,
    metalness: 0.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.02,
    iridescence: 0.9,
    iridescenceIOR: 1.85,
    iridescenceThicknessRange: [220, 520],
    transparent: true,
    opacity: 1,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const front = add(new THREE.CircleGeometry(0.0140, 56), lensMat, 0, 0, -0.0300);
  front.castShadow = false;
  const rear = add(new THREE.CircleGeometry(0.0142, 56), lensMat.clone(), 0, 0, 0.0300);
  rear.castShadow = false;
  rear.material.color.set(0x16303f);
  rear.material.iridescenceThicknessRange = [320, 700];

  // Reticle: additive, depth-tested off so it always floats in the tube, and
  // parented to the true axis rather than the canted housing.
  const reticle = new THREE.Mesh(
    new THREE.PlaneGeometry(0.0195, 0.0195),
    new THREE.MeshBasicMaterial({
      map: reticleTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      opacity: 1,
    }),
  );
  reticle.position.set(0, 0, -0.0240);
  reticle.renderOrder = 40;
  optic.add(reticle);

  // ---- anchors -------------------------------------------------------------
  const muzzleAnchor = new THREE.Object3D();
  muzzleAnchor.position.set(0, 0, -BORE_TO_MUZZLE);
  root.add(muzzleAnchor);

  const ejectAnchor = new THREE.Object3D();
  ejectAnchor.position.set(0.024, 0.006, -0.045);
  root.add(ejectAnchor);

  // Where the sightline must land when aiming. The reticle shares this axis,
  // so cancelling this offset in the ADS pose puts the dot on screen centre.
  const sightAnchor = new THREE.Object3D();
  sightAnchor.position.set(0, SIGHT_HEIGHT, -0.0810);
  root.add(sightAnchor);

  return { root, muzzleAnchor, ejectAnchor, sightAnchor, reticle, magGroup, lensMat };
}

/* ------------------------------------------------------------- viewmodel -- */

export class Weapon {
  constructor(renderer, worldCamera, environment, environmentIntensity = 0.13) {
    this.renderer = renderer;
    this.worldCamera = worldCamera;

    this.scene = new THREE.Scene();
    this.scene.environment = environment;
    // Taken from the world, not invented here. This was the literal 0.80 while
    // the world computed PRESET.environmentIntensity * envPeak and arrived at
    // 0.128 — the same PMREM texture lit 6.2 times harder on the weapon than
    // on everything the weapon is standing in front of. The two numbers were
    // in different units, which is a bug rather than a look. The small bias
    // that remains is deliberate: the hero prop may sit slightly proud of the
    // world, it may not live in a different exposure.
    this.scene.environmentIntensity = environmentIntensity * 1.25;

    // Viewmodel FOV is deliberately decoupled from the world camera. The world
    // runs very wide for peripheral awareness; putting a 0.84 m object through
    // that lens at arm's length gives it a fisheye bulge and doubles its
    // apparent size. A separate, tighter lens is what every shooter does.
    this.camera = new THREE.PerspectiveCamera(FOV_HIP, worldCamera.aspect, 0.006, 8);

    const built = buildCarbine();
    this.model = built.root;
    this.muzzleAnchor = built.muzzleAnchor;
    this.ejectAnchor = built.ejectAnchor;
    this.sightAnchor = built.sightAnchor;
    this.reticle = built.reticle;
    this.magGroup = built.magGroup;

    // Hands would normally be skinned; a pair of simple gloved forms reads
    // correctly at this framing and keeps the silhouette from floating.
    this.hands = buildHands();
    this.model.add(this.hands);

    this.rig = new THREE.Group();
    this.rig.add(this.model);
    this.scene.add(this.rig);

    this.setupLighting();

    // --- pose ---------------------------------------------------------------
    // Hip: tucked down and to the right, the way a carbine is actually carried
    // at the low ready. The optic has to sit clearly below the horizon — a red
    // dot floating above the skyline in an unaimed pose is an ADS frame that
    // forgot to centre, and it costs the whole left-of-centre composition. The
    // muzzle-down cant is what drops the barrel out of the sightline.
    this.hipPosition = new THREE.Vector3(0.150, -0.098, -0.345);
    this.hipRotation = new THREE.Euler(0.215, 0.062, 0.060);
    // Aiming cancels the sight's offset from the bore so the optical axis is
    // the camera axis; ADS_EYE_RELIEF then sets how much eyebox the tube fills.
    const s = this.sightAnchor.position;
    this.adsPosition = new THREE.Vector3(-s.x, -s.y, -(s.z + OCULAR_OFFSET) - ADS_EYE_RELIEF);
    this.adsRotation = new THREE.Euler(0, 0, 0);
    this.sprintPosition = new THREE.Vector3(0.150, -0.115, -0.245);
    this.sprintRotation = new THREE.Euler(0.34, 0.62, -0.30);

    this.position = this.hipPosition.clone();
    this.rotation = this.hipRotation.clone();

    // --- state --------------------------------------------------------------
    this.ammo = SPEC.magSize;
    this.reserve = SPEC.reserve;
    // Bloom above the rest cone, in radians, not the cone itself. It used to be
    // the absolute cone with `this.spread - SPEC.spreadHip` read back out of it
    // as the bloom term, which meant any state that wrote `spread` directly — a
    // test fixture, a respawn — silently authored a negative cone.
    this.spread = 0;
    this.lastShot = -99;
    // Simulation time at which the gun is out of its sprint carry and able to
    // fire or raise its sights. update() maintains it.
    this.readyAt = -99;
    this.reloading = false;
    this.reloadStart = 0;
    this.reloadDuration = 0;
    this.reloadWasEmpty = false;

    this._recoil = new THREE.Vector3();          // positional kick
    this._recoilVel = new THREE.Vector3();
    this._recoilRot = new THREE.Vector3();
    this._recoilRotVel = new THREE.Vector3();
    // View kick, in radians: where the shot goes relative to where the player is
    // aiming, and the aim point it is recentering toward. Held here rather than on
    // the player because the pattern is a property of the weapon.
    this._viewKick = new THREE.Vector2();
    this._recenterTo = new THREE.Vector2();
    this._kickWrote = new THREE.Vector2();
    this._adsBlend = 0;
    this._sprintUntil = -99;
    this._sway = new THREE.Vector2();
    this._swayVel = new THREE.Vector2();
    this._bobPhase = 0;
    this._breathe = 0;
    this._shotCount = 0;

    // --- muzzle flash --------------------------------------------------------
    // Two lights, not one. A single source at the muzzle falls off across the
    // barrel and leaves the receiver, the optic and both gloves — the parts the
    // frame is actually about — as dark on the firing frame as at idle. The
    // second sits back over the handguard where the blast wraps.
    this.flashLight = new THREE.PointLight(0xffd2a0, 0, 7, 1.7);
    this.flashLight.castShadow = false;
    this.muzzleAnchor.add(this.flashLight);

    this.flashBounce = new THREE.PointLight(0xffbe86, 0, 3.2, 1.4);
    this.flashBounce.castShadow = false;
    this.flashBounce.position.set(0, 0.02, -0.30);
    this.model.add(this.flashBounce);

    this.flashSprites = new THREE.Group();
    this.muzzleAnchor.add(this.flashSprites);
    const flashMat = new THREE.MeshBasicMaterial({
      map: flashTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      opacity: 0,
      side: THREE.DoubleSide,
    });
    this.flashMaterials = [];
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.135, 0.135), flashMat.clone());
      m.rotation.z = (i / 3) * Math.PI;
      m.renderOrder = 38;
      this.flashSprites.add(m);
      this.flashMaterials.push(m.material);
    }
    // Forward-facing cone so the flash has volume when seen off-axis. Long
    // enough to read as gas leaving a barrel rather than as a spark on the
    // crown; a birdcage throws a plume roughly a hand-span past the muzzle.
    this.flashCone = new THREE.Mesh(
      new THREE.ConeGeometry(0.030, 0.17, 14, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffd9a0, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
      }),
    );
    this.flashCone.rotation.x = Math.PI / 2;
    this.flashCone.position.z = -0.085;
    this.flashCone.renderOrder = 36;
    this.muzzleAnchor.add(this.flashCone);
    this._flash = 0;

    this.onShot = null;
    this.onReloadEvent = null;

    // Last thing the constructor does to the tree, and it has to be: the hands
    // and the muzzle-flash quads are parented after buildCarbine() returns, and
    // a mesh that reaches its first draw without a tangent attribute silently
    // falls back to the derivative frame this whole arrangement exists to
    // avoid. three re-checks the attribute against the material every frame, so
    // running late is only wasteful, not wrong — running never is wrong.
    bindTangents(this.scene);
  }

  setupLighting() {
    // The viewmodel has its own scene and its own lens, so nothing the world
    // rig does reaches it and every value on the weapon is set here. It is a
    // three-point setup anchored to the sun rather than a copy of it: a dawn
    // sun 8 degrees above the horizon backlights the carbine from most player
    // headings, and an honest key would silhouette the hero prop on half the
    // compass. Direction tracks the sun; placement is pulled toward the lens.
    this.key = new THREE.DirectionalLight(0xffdcbb, 9.50);
    this.key.position.set(0.6, 1.0, 0.35);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.camera.near = 0.05;
    this.key.shadow.camera.far = 3;
    this.key.shadow.camera.left = -0.6;
    this.key.shadow.camera.right = 0.6;
    this.key.shadow.camera.top = 0.6;
    this.key.shadow.camera.bottom = -0.6;
    this.key.shadow.bias = -0.0009;
    this.key.shadow.normalBias = 0.004;
    this.scene.add(this.key);
    this.scene.add(this.key.target);

    // Cool sky on the shadow side. Kept low and to the side: raised overhead it
    // lights every top face at once and the receiver reads as light grey
    // plastic instead of phosphate.
    this.fill = new THREE.DirectionalLight(0x9fbde0, 0.34);
    this.fill.position.set(0.85, 0.75, 0.90);
    this.scene.add(this.fill);

    // Rim rides past the sun and high, so the top rail and the optic tube keep
    // a hot edge that no amount of key can give a flat-topped receiver.
    this.rim = new THREE.DirectionalLight(0xffc9a2, 0.30);
    this.rim.position.set(-0.25, 0.95, -1.0);
    this.scene.add(this.rim);

    // Sand bounce. At this hour the ground is the brightest surface in frame
    // and the undersides of the magazine, handguard and support glove see
    // essentially nothing else; without it they sit on the grade's black floor.
    this.bounce = new THREE.DirectionalLight(0xffc890, 0.22);
    this.bounce.position.set(0.15, -1.0, 0.30);
    this.scene.add(this.bounce);

    // Sky-over-sand ambient plus a flat floor. A black rifle sits around 0.06
    // albedo; without this much indirect the shadow side lands under the tone
    // curve's toe and the whole lower half of the weapon crushes to zero.
    this.scene.add(new THREE.HemisphereLight(0x9cc0e6, 0xb08a58, 0.18));
    this.scene.add(new THREE.AmbientLight(0xdfe4ee, 0.06));
  }

  /** Aligns the viewmodel rig with the world sun as the player turns. */
  syncLighting(sunDirection, worldCamera) {
    const sun = sunDirection.clone().applyQuaternion(worldCamera.quaternion.clone().invert());

    // Anchored to the sun for azimuth, biased hard toward the camera's left for
    // exposure. The weapon is carried on the right, so the only large surface
    // the lens ever sees is its left flank; a key that honours a dawn sun puts
    // that flank in shade on most headings and the hero prop goes to
    // silhouette. Sun weight is low enough to stay believable and high enough
    // that turning into the light visibly changes the weapon.
    // Sun at full weight, bias as a nudge. A neutral sphere in this scene used
    // to hold the same luma to within 0.00 stops across every player heading
    // while the identical sphere in the world swung 4.4 — the weapon was lit
    // by a studio, not by the sunrise it was standing in. Some bias is right
    // and every shipped shooter carries it, but it biases the world's light
    // rather than replacing it.
    this.key.position.copy(sun).add(KEY_BIAS).normalize().multiplyScalar(2);
    this.key.target.position.set(0, -0.05, -0.2);
    this.key.target.updateMatrixWorld();

    // Rim swings with the sun's azimuth but stays behind and above, so the top
    // rail keeps its edge whichever heading the player is on.
    this.rim.position.set(-sun.x * 0.5 - 0.20, 0.95, -1.0);

    // The rig lives in camera space but the environment is authored in world
    // space, so without this the weapon reflects a fixed patch of sky that
    // swings around it as the player turns — the shadow side can end up facing
    // the sun's half of the dome while the lit side faces the dark half.
    this.scene.environmentRotation.setFromQuaternion(worldCamera.quaternion);
  }

  /* --------------------------------------------------------------- fire -- */

  /**
   * Rate limiter, on the simulation clock.
   *
   * This used to read performance.now() while fire() stamped lastShot with the
   * simulation time, so the subtraction spanned two unrelated origins. The
   * page clock is ahead of the sim clock by the whole boot — several seconds
   * of procedural generation — so the difference was never once below the
   * 77 ms interval and the limiter was permanently open. Holding the trigger
   * fired a round per rendered frame: 3600 rpm against a specified 780, a full
   * magazine in half a second instead of two and a third. Every other user of
   * lastShot in this file already treats it as simulation time.
   */
  canFireAt(now) {
    return !this.reloading && this.ammo > 0
      && now >= this.readyAt
      && (now - this.lastShot) >= 60 / SPEC.rpm;
  }

  fire(now, player) {
    if (!this.canFireAt(now)) return null;

    // The stamp advances by one authored interval; it is not set to `now`.
    //
    // `now` is a tick boundary, so stamping it rounded every interval up to the
    // next tick: 76.9 ms of authored interval became the 83.3 ms of the next
    // 1/120 tick and the gun fired 720 rpm against a spec of 780 — and 758 rpm
    // at 1/240, so the weapon's cadence was a property of the frame rate.
    // Keeping the phase makes the interval jitter by up to a tick either way and
    // the mean come out at the number in SPEC, whatever dt is. The `2 *` guard is
    // what stops a burst that started long ago from banking free rounds.
    const interval = 60 / SPEC.rpm;
    this.lastShot = (now - this.lastShot) < interval * 2 ? this.lastShot + interval : now;
    this.ammo--;
    this._shotCount++;

    // One vertical and one horizontal value drawn per shot inside the authored
    // bounds, which is how recoil.recoil_determinism describes CoD doing it: the
    // pattern is repeatable as an envelope, not as a sequence.
    const adsScale = THREE.MathUtils.lerp(1, SPEC.recoilAdsScale, player.ads);
    const vertical = THREE.MathUtils.lerp(
      SPEC.recoilVerticalMin, SPEC.recoilVerticalMax, Math.random()) * adsScale;
    const horizontal = THREE.MathUtils.lerp(
      SPEC.recoilHorizontalMin, SPEC.recoilHorizontalMax, Math.random()) * adsScale;

    // The aim point this round started from. update() recenters toward this and
    // not toward zero, which is the whole difference between a pattern and a
    // shake — see the block there.
    this._recenterTo.copy(this._viewKick);
    this._viewKick.x += vertical;
    this._viewKick.y += horizontal;

    // Viewmodel kick. Kept to a few centimetres: the weapon is only 30 cm off
    // the lens, so a kick sized for the camera reads as the gun lunging at the
    // player rather than recoiling. Scaled by the drawn vertical magnitude so the
    // gun visibly shakes harder on a hard round, and by the old shot-count ramp so
    // the first rounds of a burst still look tighter than the twentieth.
    const ramp = Math.min(1, 0.45 + this._shotCount * 0.075);
    const mag = vertical / SPEC.recoilVerticalMax;
    const side = Math.sign(horizontal) || 1;
    this._recoilVel.z += SPEC.recoilKick * ramp * mag * 24;
    this._recoilVel.y += 0.004 * ramp * mag * 30;
    this._recoilVel.x += side * 0.0025 * ramp * mag * 30;
    this._recoilRotVel.x -= 0.032 * ramp * mag * 42;
    this._recoilRotVel.z += side * 0.014 * ramp * mag * 42;

    this.spread = Math.min(SPEC.spreadMax, this.spread + SPEC.spreadPerShot);
    this._flash = 1;

    return {
      spread: this.currentSpread(player),
      damage: SPEC.damage,
    };
  }

  /**
   * Cone half-angle for the next round, in radians.
   *
   * Hipfire only, scaled out by the ADS blend rather than lerped toward a small
   * aimed cone. recoil.ads_bullet_spread_degrees is 0 with a tolerance of exactly
   * 0: an aimed shot goes precisely to the reticle and recoil is the only thing
   * that moves impacts, which is what makes a pattern learnable. Measured through
   * the bullets, the old lerp-to-0.0011 plus the Math.max(0.0004, ...) floor put
   * 0.12 deg of scatter under every aimed round and nothing could turn it off —
   * the floor in particular was unreachable from outside, so even zeroing every
   * spread term in SPEC left it.
   */
  currentSpread(player) {
    const motion = THREE.MathUtils.clamp(player.speedHorizontal / 6, 0, 1) * SPEC.spreadMoving;
    const air = player.onGround ? 0 : 0.022;
    const crouch = player.crouching ? -SPEC.spreadHip * 0.28 : 0;
    const cone = Math.min(SPEC.spreadMax,
      Math.max(0, SPEC.spreadHip + motion + air + crouch + this.spread));
    return cone * (1 - player.ads);
  }

  startReload(now) {
    if (this.reloading || this.ammo >= SPEC.magSize || this.reserve <= 0) return false;
    this.reloading = true;
    this.reloadWasEmpty = this.ammo === 0;
    this.reloadStart = now;
    this.reloadDuration = this.reloadWasEmpty ? SPEC.reloadEmptyTime : SPEC.reloadTime;
    this._reloadStage = 0;
    return true;
  }

  /* ------------------------------------------------------------- update -- */

  update(dt, now, player, input) {
    // --- reload track --------------------------------------------------------
    let magOffset = new THREE.Vector3();
    let magRot = 0;
    if (this.reloading) {
      const t = (now - this.reloadStart) / this.reloadDuration;
      if (t >= 1) {
        const need = SPEC.magSize - this.ammo;
        const take = Math.min(need, this.reserve);
        this.ammo += take;
        this.reserve -= take;
        this.reloading = false;
      } else {
        // 0.00-0.22 mag release, 0.22-0.42 drop, 0.42-0.72 insert,
        // 0.72-0.86 seat, 0.86-1.0 bolt release (empty reload only).
        if (t < 0.42) {
          const k = THREE.MathUtils.smoothstep(t, 0.06, 0.42);
          magOffset.y = -k * 0.34;
          magRot = k * 0.5;
          if (this._reloadStage === 0 && t > 0.08) { this._reloadStage = 1; this.onReloadEvent?.('release'); }
        } else if (t < 0.76) {
          const k = 1 - THREE.MathUtils.smoothstep(t, 0.42, 0.72);
          magOffset.y = -k * 0.30;
          magOffset.z = k * 0.05;
          magRot = k * 0.4;
          if (this._reloadStage === 1 && t > 0.50) { this._reloadStage = 2; this.onReloadEvent?.('insert'); }
        } else {
          magOffset.set(0, 0, 0);
          if (this._reloadStage === 2 && t > 0.80) { this._reloadStage = 3; this.onReloadEvent?.('seat'); }
        }
        // Whole-weapon reload motion: tilt in toward the body and dip.
        const swing = Math.sin(THREE.MathUtils.clamp(t, 0, 1) * Math.PI);
        this._reloadPose = {
          pos: new THREE.Vector3(0.030 * swing, -0.075 * swing, 0.035 * swing),
          rot: new THREE.Vector3(0.22 * swing, -0.34 * swing, 0.30 * swing),
        };
      }
    }
    if (!this.reloading) this._reloadPose = null;
    this.magGroup.position.copy(magOffset);
    this.magGroup.rotation.x = magRot;

    // --- sprint carry --------------------------------------------------------
    // handling.mcw_sprint_to_fire_time is 0.252 s and a round used to leave the
    // gun 4.2 ms — one tick — after sprint was released, so a sprint cost the
    // player nothing at all. The gun is out of its sprint carry, and able both to
    // fire and to start raising its sights, only once this has elapsed.
    // A trigger pull ends the carry rather than waiting for the sprint to end. It
    // has to: player.sprinting is computed from the stick and holds as long as the
    // stick is forward, so a phone player with a thumb on full deflection could
    // hold the trigger indefinitely and never fire a round. Interrupting the sprint
    // is also what the trigger does in the game this is measured against.
    if (player.sprinting && !input.fire) this._sprintUntil = now;
    this.readyAt = this._sprintUntil + SPEC.sprintToFireTime;
    const carried = now < this.readyAt;

    // --- ADS blend -----------------------------------------------------------
    // A transition that completes, at the duration SPEC.adsTime states.
    //
    // player.js damps the same value toward the same target on its own 16/s rate:
    // 63% at 58 ms, 95% at 183 ms, 99% at 288 ms, and 1.0 never. That asymptote is
    // not a rounding curiosity — an ADS cone of exactly 0 is unreachable from it,
    // and SPEC.adsTime sat at 0.19 unread while it ran. This overwrites it every
    // tick, so the damp in player.js is dead: its only remaining effect is one
    // tick of lead inside the frame it runs in, and it should be deleted the next
    // time that file is opened.
    //
    // A blend that has settled is adopted rather than driven, so state written
    // from outside the loop — a respawn, a test fixture — is not fought over.
    const wantAds = carried ? 0 : (player.adsTarget ?? 0);
    if (player.ads === player.adsTarget) this._adsBlend = player.ads;
    const adsStep = dt / Math.max(1e-4, SPEC.adsTime);
    this._adsBlend = wantAds > this._adsBlend
      ? Math.min(wantAds, this._adsBlend + adsStep)
      : Math.max(wantAds, this._adsBlend - adsStep);
    player.ads = this._adsBlend;

    // --- view kick and recentering -------------------------------------------
    // recoil.recoil_recentering_behaviour: the view resets toward the *previous
    // aim point* at a per-weapon centre speed that takes effect immediately on
    // firing, and during fully automatic fire there is usually too much recoil to
    // fully re-center between shots, "so sustained climb is emergent".
    //
    // The old arrangement could not produce that and was not a slower version of
    // it. fire() pushed the player's recoil *velocity* and player.js pulled the
    // offset back toward zero on a spring, so accumulation and recovery cancelled
    // at a fixed level: climb measured 0.383 deg after 1 round, 1.265 after 5,
    // 1.6502 after 10 — then 1.6496 at 15 and 1.6495 at 20. It stopped. Recoil was
    // a per-shot shake that never walked the gun off target.
    //
    // Recentering toward the pre-shot offset instead retains whatever the centre
    // speed did not recover before the next round lands, and thirty of those
    // retained fractions are the pattern. Nothing here is a spring: there is no
    // velocity term, no overshoot, and the target is not zero.
    if (player.recoilPitch === 0 && player.recoilYaw === 0
      && (this._kickWrote.x !== 0 || this._kickWrote.y !== 0)) {
      // Compared against the offset this weapon last wrote, not against the live
      // pattern: fire() runs before update() inside the same tick, so on the first
      // round of a burst the player still holds the zero from before the shot and
      // testing the pattern instead threw every opening round away — which zeroed
      // every round, since the burst never got a second one to build on.
      //
      // Only a write from outside the loop can land exactly on zero while a
      // pattern is live: the spring in player.js leaves a residue behind and this
      // model never assigns zero except here. That is the signal to drop the
      // pattern with it, so a test fixture or a respawn starts on a clean gun.
      this._viewKick.set(0, 0);
      this._recenterTo.set(0, 0);
    }
    const centre = 1 - Math.exp(-SPEC.recoilCenterSpeed * dt);
    this._viewKick.x += (this._recenterTo.x - this._viewKick.x) * centre;
    this._viewKick.y += (this._recenterTo.y - this._viewKick.y) * centre;

    // Once the burst is over the residual belongs to the aim the player owns.
    // Handing it to pitch/yaw leaves the total view angle identical — the player
    // sees nothing — but puts the offset back under player.js's pitch limit.
    // Left in the recoil channel it is unclamped, and a player who sprays without
    // correcting would eventually rotate the camera past vertical, which is the
    // one way an emergent, non-returning climb can break the view. look(0, 0) is
    // what re-applies that limit rather than a second copy of it here.
    if (now - this.lastShot > SPEC.recoilSettle && (this._viewKick.x !== 0 || this._viewKick.y !== 0)) {
      player.pitch += this._viewKick.x;
      player.yaw += this._viewKick.y;
      player.look(0, 0);
      this._viewKick.set(0, 0);
      this._recenterTo.set(0, 0);
    }

    player.recoilPitch = this._viewKick.x;
    player.recoilYaw = this._viewKick.y;
    this._kickWrote.copy(this._viewKick);
    // The spring in player.js integrates these; zeroed every tick it has nothing
    // to integrate and cannot fight the pattern. Dead code on the other side of
    // the same fence as the ADS damp.
    player._recoilPitchVel = 0;
    player._recoilYawVel = 0;

    // --- stance blend --------------------------------------------------------
    const sprintBlend = player.sprinting ? 1 : 0;
    this._sprint = THREE.MathUtils.damp(this._sprint ?? 0, this.reloading ? 0 : sprintBlend, 11, dt);

    const targetPos = new THREE.Vector3();
    const targetRot = new THREE.Vector3();
    targetPos.copy(this.hipPosition).lerp(this.adsPosition, player.ads);
    targetRot.set(this.hipRotation.x, this.hipRotation.y, this.hipRotation.z)
      .lerp(new THREE.Vector3(this.adsRotation.x, this.adsRotation.y, this.adsRotation.z), player.ads);
    targetPos.lerp(this.sprintPosition, this._sprint);
    targetRot.lerp(new THREE.Vector3(this.sprintRotation.x, this.sprintRotation.y, this.sprintRotation.z), this._sprint);

    if (this._reloadPose) {
      targetPos.add(this._reloadPose.pos);
      targetRot.add(this._reloadPose.rot);
    }

    // --- bob ------------------------------------------------------------------
    const speed = player.speedHorizontal;
    const moving = player.onGround && speed > 0.3;
    const cadence = player.sprinting ? 8.4 : player.crouching ? 4.2 : 6.3;
    if (moving) this._bobPhase += dt * cadence;
    else this._bobPhase += dt * 1.0;

    const bobWeight = (moving ? THREE.MathUtils.clamp(speed / 4.5, 0, 1.5) : 0)
      * THREE.MathUtils.lerp(1, 0.22, player.ads);
    this._bobWeight = THREE.MathUtils.damp(this._bobWeight ?? 0, bobWeight, 7, dt);

    const bob = new THREE.Vector3(
      Math.cos(this._bobPhase) * 0.0125 * this._bobWeight,
      Math.sin(this._bobPhase * 2) * 0.0092 * this._bobWeight - this._bobWeight * 0.004,
      Math.sin(this._bobPhase * 2 + 0.6) * 0.0055 * this._bobWeight,
    );
    const bobRot = new THREE.Vector3(
      Math.sin(this._bobPhase * 2) * 0.011 * this._bobWeight,
      Math.cos(this._bobPhase) * 0.016 * this._bobWeight,
      Math.cos(this._bobPhase) * 0.020 * this._bobWeight,
    );

    // --- idle breathing -------------------------------------------------------
    this._breathe += dt;
    // Aiming all but kills the breathing loop: the dot has to sit on the point
    // of impact, and a couple of pixels of drift reads as a misaligned sight.
    const breathAmp = THREE.MathUtils.lerp(1, 0.10, player.ads) * (1 - this._bobWeight * 0.6);
    bob.y += Math.sin(this._breathe * 1.35) * 0.0026 * breathAmp;
    bob.x += Math.sin(this._breathe * 0.83) * 0.0019 * breathAmp;
    bobRot.z += Math.sin(this._breathe * 0.71) * 0.007 * breathAmp;

    // --- look sway (weapon lags the camera) -----------------------------------
    const swayScale = THREE.MathUtils.lerp(0.024, 0.006, player.ads);
    const swayTargetX = THREE.MathUtils.clamp(-player.lookDelta.x * swayScale * 0.09, -0.055, 0.055);
    const swayTargetY = THREE.MathUtils.clamp(player.lookDelta.y * swayScale * 0.09, -0.055, 0.055);
    const sk = 62, sd = 12;
    this._swayVel.x += ((swayTargetX - this._sway.x) * sk - this._swayVel.x * sd) * dt;
    this._swayVel.y += ((swayTargetY - this._sway.y) * sk - this._swayVel.y * sd) * dt;
    this._sway.x += this._swayVel.x * dt;
    this._sway.y += this._swayVel.y * dt;

    // --- recoil springs --------------------------------------------------------
    // The springs are clamped, not just damped. Sustained fire otherwise stacks
    // impulses faster than they decay and walks the receiver into the lens.
    const rk = 190, rd = 21;
    const posLimit = { x: 0.018, y: 0.018, z: 0.042 };
    const rotLimit = { x: 0.085, y: 0.045, z: 0.065 };
    for (const axis of ['x', 'y', 'z']) {
      this._recoilVel[axis] += (-this._recoil[axis] * rk - this._recoilVel[axis] * rd) * dt;
      this._recoil[axis] = THREE.MathUtils.clamp(
        this._recoil[axis] + this._recoilVel[axis] * dt, -posLimit[axis], posLimit[axis]);
      this._recoilRotVel[axis] += (-this._recoilRot[axis] * rk * 0.85 - this._recoilRotVel[axis] * rd) * dt;
      this._recoilRot[axis] = THREE.MathUtils.clamp(
        this._recoilRot[axis] + this._recoilRotVel[axis] * dt, -rotLimit[axis], rotLimit[axis]);
    }

    // --- compose ---------------------------------------------------------------
    this.position.lerp(
      targetPos.clone().add(bob).add(this._recoil)
        .add(new THREE.Vector3(this._sway.x, this._sway.y, 0)),
      1 - Math.exp(-26 * dt),
    );
    const finalRot = targetRot.clone().add(bobRot).add(this._recoilRot)
      .add(new THREE.Vector3(this._sway.y * 1.6, -this._sway.x * 1.6, this._sway.x * 1.1));
    this.rotation.x = THREE.MathUtils.damp(this.rotation.x, finalRot.x, 26, dt);
    this.rotation.y = THREE.MathUtils.damp(this.rotation.y, finalRot.y, 26, dt);
    this.rotation.z = THREE.MathUtils.damp(this.rotation.z, finalRot.z, 26, dt);

    this.model.position.copy(this.position);
    this.model.rotation.copy(this.rotation);

    // --- spread recovery --------------------------------------------------------
    if (now - this.lastShot > 0.12) {
      // Down to zero bloom, not down to the rest cone: `spread` is the bloom
      // above rest now, so the old floor of SPEC.spreadHip would have pinned a
      // full rest cone of extra scatter on top of the rest cone forever.
      this.spread = Math.max(0, this.spread - SPEC.spreadRecover * dt);
      if (now - this.lastShot > 0.35) this._shotCount = Math.max(0, this._shotCount - dt * 22);
    }

    // --- muzzle flash decay -------------------------------------------------------
    this._flash = Math.max(0, this._flash - dt * 19);
    const f = this._flash;
    // Held near peak for most of the (very short) life rather than decaying
    // linearly: a discharge is over in about two frames, so a linear ramp means
    // every captured frame catches it half-dead and the shot reads as posed.
    const fp = Math.pow(f, 0.45);
    this.flashLight.intensity = fp * 26;
    this.flashBounce.intensity = fp * 11;
    this.flashCone.material.opacity = Math.min(1, fp * 1.15);
    this.flashCone.scale.setScalar(0.7 + (1 - f) * 0.7);
    for (let i = 0; i < this.flashMaterials.length; i++) {
      this.flashMaterials[i].opacity = Math.min(1, fp * (1.15 - i * 0.22));
      this.flashSprites.children[i].scale.setScalar(0.50 + (1 - f) * 0.85 + i * 0.16);
      this.flashSprites.children[i].rotation.z += dt * (i % 2 ? 9 : -9);
    }
    this.flashSprites.visible = f > 0.001;
    this.flashCone.visible = f > 0.001;

    // Reticle dims when not aiming — an unmagnified dot is barely visible
    // off-eyebox in reality, and hiding it keeps the HUD crosshair readable.
    this.reticle.material.opacity = THREE.MathUtils.lerp(0.28, 1.0, player.ads);

    this.camera.fov = THREE.MathUtils.lerp(FOV_HIP, FOV_ADS, player.ads);
    this.camera.aspect = this.worldCamera.aspect;
    this.camera.updateProjectionMatrix();
  }

  /** World-space muzzle position, for tracers and impact sounds. */
  muzzleWorldPosition(target = new THREE.Vector3()) {
    this.muzzleAnchor.updateWorldMatrix(true, false);
    return target.setFromMatrixPosition(this.muzzleAnchor.matrixWorld);
  }

  ejectWorldPosition(target = new THREE.Vector3()) {
    this.ejectAnchor.updateWorldMatrix(true, false);
    return target.setFromMatrixPosition(this.ejectAnchor.matrixWorld);
  }
}

/* ---------------------------------------------------------------- hands -- */

function buildHands() {
  const g = new THREE.Group();
  // A tactical glove is a dark neutral, not black. Authored at receiver value
  // the firing hand merges into the part it is holding and neither reads; the
  // knuckle pad and the cuff then have to sit either side of the glove so the
  // hand carries three values instead of one.
  const glove = new THREE.MeshStandardMaterial({ color: 0x3d362d, roughness: 0.90, metalness: 0.0 });
  const knuckle = new THREE.MeshStandardMaterial({ color: 0x211d19, roughness: 0.58, metalness: 0.0 });
  const sleeve = vmSurface('canvas', [2.0, 2.0], 1.3)({ roughness: 1.0, color: 0x7c7361 });

  const piece = (parent, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const rbox = (w, h, d, r) => new RoundedBoxGeometry(w, h, d, 2, r);

  /**
   * Three phalanges laid along -Z with a gap at each joint, curling about the
   * local X axis. The gaps are the whole point: a finger drawn as one box is a
   * sausage, and four sausages side by side are a mitten. What the eye reads at
   * this distance is background showing between fingers and a shadow at each
   * knuckle, not the shape of any one digit.
   */
  const finger = (parent, x, y, z, len, w, curl, tilt = 0) => {
    const root = new THREE.Group();
    root.position.set(x, y, z);
    root.rotation.set(curl * 0.9, tilt, 0);
    parent.add(root);
    let node = root;
    for (let s = 0; s < 3; s++) {
      const l = len * [0.40, 0.34, 0.26][s];
      const t = w * (1 - s * 0.10);
      piece(node, rbox(t, t * 0.96, l, t * 0.44), glove, 0, 0, -l * 0.5);
      // Pad over the joint, set proud and darker so it catches its own shadow.
      if (s < 2) piece(node, rbox(t * 0.96, t * 0.34, t * 0.62, t * 0.15), knuckle, 0, t * 0.40, -l * 0.62);
      const next = new THREE.Group();
      next.position.z = -l - w * 0.13;
      next.rotation.x = curl * (s === 0 ? 0.85 : 0.70);
      node.add(next);
      node = next;
    }
    return root;
  };

  // Firing hand: palm on the backstrap, fingers wrapped across the frontstrap,
  // index laid along the receiver above the trigger. The grip is raked, so the
  // whole hand is raked with it.
  const right = new THREE.Group();
  right.position.set(0.002, -0.098, 0.016);
  right.rotation.set(-0.40, 0.05, 0.02);
  piece(right, rbox(0.046, 0.084, 0.028, 0.012), glove, 0.007, 0.002, 0.031);
  piece(right, rbox(0.040, 0.070, 0.013, 0.005), knuckle, 0.011, 0.004, 0.041);
  piece(right, rbox(0.048, 0.016, 0.036, 0.007), glove, 0.006, 0.043, 0.022);       // web of the hand
  // Fingers run right to left across the front of the grip. They point -Z in
  // their own frame, so a quarter turn about Y lays them across it.
  for (let i = 0; i < 3; i++) {
    finger(right, 0.0215, 0.010 - i * 0.0205, -0.0175 + i * 0.0020,
      0.044, 0.0158, 0.30 + i * 0.06, Math.PI * 0.5 + 0.10);
  }
  // Thumb, up the left side of the grip with the tip on the receiver.
  finger(right, -0.0195, 0.016, 0.014, 0.040, 0.0180, 0.16, Math.PI * 0.62);
  g.add(right);

  // Trigger finger, parented in weapon space rather than to the grip so it
  // stays on the trigger no matter how the hand is raked.
  const index = new THREE.Group();
  index.position.set(0.0165, -0.0505, -0.0180);
  index.rotation.set(0.10, 0.30, 0);
  piece(index, rbox(0.0165, 0.0160, 0.0300, 0.0068), glove, 0, 0, -0.0140);
  piece(index, rbox(0.0158, 0.0058, 0.0110, 0.0022), knuckle, 0, 0.0080, -0.0270);
  piece(index, rbox(0.0150, 0.0148, 0.0200, 0.0062), glove, -0.0010, -0.0032, -0.0400, 0.34, 0, 0);
  g.add(index);

  // Support hand: C-clamp on the handguard. From the shooter's eye the
  // fingertips come over the top of the tube, the heel sits below it and the
  // thumb crosses the near side — that last one is what puts the hand *around*
  // the handguard instead of floating beside it.
  const left = new THREE.Group();
  left.position.set(-0.004, -0.016, -0.286);
  left.rotation.set(0.18, 0.10, -0.24);
  piece(left, rbox(0.0150, 0.0360, 0.0640, 0.010), glove, -0.0232, -0.0165, 0.0040);
  piece(left, rbox(0.0240, 0.0140, 0.0570, 0.007), glove, -0.0135, -0.0290, 0.0030);
  piece(left, rbox(0.0170, 0.0150, 0.0600, 0.0055), knuckle, -0.0262, -0.0040, 0.0030);  // heel pad
  for (let i = 0; i < 4; i++) {
    const z = -0.0250 + i * 0.0180;
    finger(left, -0.0175, 0.0135 - i * 0.0016, z, 0.036, 0.0142, 0.46, -Math.PI * 0.5 - 0.10);
  }
  // Thumb along the near side of the tube, crossing the silhouette.
  piece(left, rbox(0.0150, 0.0150, 0.0300, 0.0062), glove, -0.0215, 0.0110, -0.0130, 0.16, 0, -0.16);
  piece(left, rbox(0.0140, 0.0060, 0.0110, 0.0024), knuckle, -0.0248, 0.0176, -0.0250);
  piece(left, rbox(0.0136, 0.0138, 0.0230, 0.0056), glove, -0.0232, 0.0092, -0.0360, 0.30, 0, -0.20);
  // No support forearm and no cuff ring. The arm reaches the handguard from
  // behind and below, so almost none of it is in shot, and anything long enough
  // to read ends up aimed near the lens axis showing its own end cap — a 30 mm
  // disc a foot from the eye, and the largest untextured shape in the picture.
  g.add(left);

  // Firing forearm. A hard edge where the glove meets the canvas is what stops
  // the hand reading as one blob, and the sleeve is the only light value either
  // hand carries.
  piece(g, new THREE.CylinderGeometry(0.0300, 0.0385, 0.105, 18), sleeve,
    0.0250, -0.1560, 0.0920, 1.06, 0, 0.20);
  piece(g, new THREE.CylinderGeometry(0.0318, 0.0322, 0.014, 18), knuckle,
    0.0148, -0.1300, 0.0640, 1.06, 0, 0.20);
  return g;
}

/* --------------------------------------------------------- flash texture -- */

function flashTexture() {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const cx = s / 2, cy = s / 2;

  const core = g.createRadialGradient(cx, cy, 0, cx, cy, s * 0.5);
  core.addColorStop(0.00, 'rgba(255,255,244,1.00)');
  core.addColorStop(0.10, 'rgba(255,238,190,0.92)');
  core.addColorStop(0.26, 'rgba(255,180,86,0.55)');
  core.addColorStop(0.52, 'rgba(226,110,32,0.16)');
  core.addColorStop(1.00, 'rgba(180,70,16,0.00)');
  g.fillStyle = core;
  g.fillRect(0, 0, s, s);

  // Irregular star petals — a plain radial blob reads as a bug light.
  g.globalCompositeOperation = 'lighter';
  const petals = 9;
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * TAU + 0.31;
    const len = s * (0.24 + ((i * 37) % 11) / 11 * 0.24);
    const wid = s * 0.030;
    g.save();
    g.translate(cx, cy);
    g.rotate(a);
    const grad = g.createLinearGradient(0, 0, len, 0);
    grad.addColorStop(0, 'rgba(255,244,214,0.85)');
    grad.addColorStop(0.4, 'rgba(255,178,84,0.30)');
    grad.addColorStop(1, 'rgba(255,140,50,0.0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, -wid);
    g.lineTo(len, 0);
    g.lineTo(0, wid);
    g.closePath();
    g.fill();
    g.restore();
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
