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
import { material } from './textures.js';

const TAU = Math.PI * 2;

// Vertical field of view for the viewmodel lens, in degrees, and how far the
// eye sits behind the ocular when aiming. Eye relief is the only thing setting
// how much of the frame the sight tube fills, so it is a tuning knob, not a
// consequence of the pose.
const FOV_HIP = 48;
const FOV_ADS = 40;
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

  // Cone half-angle in radians at rest and at full bloom.
  spreadHip: 0.0165,
  spreadAds: 0.0011,
  spreadMoving: 0.019,
  spreadPerShot: 0.0022,
  spreadMax: 0.045,
  spreadRecover: 0.075,

  recoilPitch: 0.0135,
  recoilYaw: 0.0042,
  recoilKick: 0.026,
  reloadTime: 2.18,
  reloadEmptyTime: 2.74,
  adsTime: 0.19,
};

/* ------------------------------------------------------------- materials -- */

function reticleTexture() {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.clearRect(0, 0, s, s);
  const cx = s / 2, cy = s / 2;

  // Soft bloom halo behind the dot — this is what sells an illuminated optic.
  const glow = g.createRadialGradient(cx, cy, 0, cx, cy, s * 0.30);
  glow.addColorStop(0.00, 'rgba(255, 60, 40, 0.85)');
  glow.addColorStop(0.16, 'rgba(255, 46, 28, 0.30)');
  glow.addColorStop(0.45, 'rgba(255, 40, 24, 0.06)');
  glow.addColorStop(1.00, 'rgba(255, 40, 24, 0.00)');
  g.fillStyle = glow;
  g.fillRect(0, 0, s, s);

  const core = g.createRadialGradient(cx, cy, 0, cx, cy, s * 0.052);
  core.addColorStop(0.0, 'rgba(255, 236, 230, 1.0)');
  core.addColorStop(0.30, 'rgba(255, 96, 60, 1.0)');
  core.addColorStop(1.0, 'rgba(255, 40, 24, 0.0)');
  g.fillStyle = core;
  g.beginPath();
  g.arc(cx, cy, s * 0.055, 0, TAU);
  g.fill();

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
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

/** One picatinny recoil lug, chamfered like the real extrusion. */
function railToothGeometry() {
  const s = new THREE.Shape();
  s.moveTo(-0.0106, 0);
  s.lineTo(0.0106, 0);
  s.lineTo(0.0106, 0.0014);
  s.lineTo(0.0086, 0.0034);
  s.lineTo(-0.0086, 0.0034);
  s.lineTo(-0.0106, 0.0014);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.0050, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -0.0025);
  return g;
}

function buildCarbine() {
  const root = new THREE.Group();
  root.name = 'carbine';

  // Phosphate is a matte conversion coating that scatters wide, so only the
  // worn-through high points ever specular. Modelled at full metalness it has no
  // diffuse term at all and the receiver becomes a hole in a backlit frame;
  // backing metalness off gives the flanks something for the fill to catch.
  const phosphate = material('gunmetal', [3.2, 3.2], { roughness: 0.88, metalness: 0.30 });
  const barrelSteel = material('gunmetal', [5, 5], { roughness: 0.58, metalness: 0.75 });
  const furniture = material('polymer', [3, 3], { roughness: 1.0 });
  const gripPoly = material('polymer', [7, 7], { roughness: 1.05 });
  // An FDE magazine is the one value break a black rifle gets, and it is what
  // stops the lower right of frame being a single silhouette.
  const magPoly = material('polymer', [2.4, 4], { map: null, color: 0x6f5f48, roughness: 0.88 });
  // Small hard parts are the trap: at low roughness a near-black metal still
  // mirrors a dawn sky straight back at the lens and reads as bare aluminium.
  const small = new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.86, metalness: 0.15 });
  const railMat = new THREE.MeshStandardMaterial({ color: 0x232529, roughness: 0.54, metalness: 0.45 });
  // Tiled tight on purpose: at low repeat the gunmetal sampler's polished-through
  // wear blobs are bigger than the optic itself and turn the whole tube chrome.
  const opticBody = material('gunmetal', [5, 5], { roughness: 0.92, metalness: 0.28 });
  const worn = new THREE.MeshStandardMaterial({ color: 0x4a4c51, roughness: 0.45, metalness: 0.80 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.94, metalness: 0.0 });
  const bore = new THREE.MeshStandardMaterial({ color: 0x030303, roughness: 1.0, metalness: 0.3 });

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
  add(cyl(0.0030, 0.0030, 0.0310, 8), worn, 0.0000, -0.0362, -0.0150, 0, 0, Math.PI / 2);

  // The tube and both bells are open cylinders drawn from the inside too:
  // capping them plugs the sight with a solid disc, which is the single fastest
  // way to make an optic read as a painted-on prop. A matte black liner runs the
  // full length so the bore swallows light instead of glowing like a drainpipe.
  const anodised = opticBody.clone();
  anodised.side = THREE.DoubleSide;
  const boreWall = new THREE.MeshStandardMaterial({
    color: 0x08090a, roughness: 0.96, metalness: 0.0, side: THREE.DoubleSide,
  });
  const ocyl = (rt, rb, len, seg) => new THREE.CylinderGeometry(rt, rb, len, seg, 1, true);
  add(ocyl(0.0150, 0.0150, 0.0570, 40), anodised, 0, 0, 0, Math.PI / 2);
  add(ocyl(0.0140, 0.0140, 0.0840, 40), boreWall, 0, 0, 0, Math.PI / 2);
  add(ocyl(0.0164, 0.0150, 0.0120, 40), anodised, 0, 0, -0.0290, Math.PI / 2);
  add(ocyl(0.0150, 0.0168, 0.0130, 40), anodised, 0, 0, 0.0295, Math.PI / 2);
  add(cyl(0.0066, 0.0070, 0.0110, 16), small, 0, 0.0172, -0.0120);          // elevation turret
  add(cyl(0.0066, 0.0070, 0.0110, 16), small, 0.0172, 0, -0.0120, 0, 0, Math.PI / 2);
  add(cyl(0.0088, 0.0088, 0.0060, 18), small, -0.0172, 0, 0.0060, 0, 0, Math.PI / 2);  // battery cap
  add(cyl(0.0070, 0.0070, 0.0040, 18), worn, -0.0208, 0, 0.0060, 0, 0, Math.PI / 2);
  add(cyl(0.0056, 0.0060, 0.0070, 14), small, -0.0152, 0, 0.0230, 0, 0, Math.PI / 2);  // brightness dial

  // Glass. Real transmission is no use here: the viewmodel scene is empty, so
  // three would refract a black backdrop. Plain alpha over the already-composited
  // world plus a clearcoat sheen is what actually reads as a coated lens.
  const lensMat = new THREE.MeshPhysicalMaterial({
    color: 0x0c1a20,
    roughness: 0.04,
    metalness: 0.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.02,
    iridescence: 0.9,
    iridescenceIOR: 1.85,
    iridescenceThicknessRange: [220, 520],
    transparent: true,
    opacity: 0.26,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const front = add(new THREE.CircleGeometry(0.0134, 40), lensMat, 0, 0, -0.0300);
  front.castShadow = false;
  const rear = add(new THREE.CircleGeometry(0.0136, 40), lensMat.clone(), 0, 0, 0.0300);
  rear.castShadow = false;
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
  constructor(renderer, worldCamera, environment) {
    this.renderer = renderer;
    this.worldCamera = worldCamera;

    this.scene = new THREE.Scene();
    this.scene.environment = environment;
    // Held back below the world's: at full strength a dawn sky reflects off
    // every small anodised part and the carbine reads as bare aluminium.
    this.scene.environmentIntensity = 0.85;

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
    // Hip: muzzle at 58% across and 55% up, receiver running out through the
    // bottom-right corner, nothing crossing the vertical centreline. The muzzle
    // rides above the stock purely from perspective convergence, so the numbers
    // that matter are the offsets, not the on-screen result of any one part.
    this.hipPosition = new THREE.Vector3(0.126, -0.041, -0.300);
    this.hipRotation = new THREE.Euler(0.151, 0.062, 0.060);
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
    this.spread = SPEC.spreadHip;
    this.lastShot = -99;
    this.reloading = false;
    this.reloadStart = 0;
    this.reloadDuration = 0;
    this.reloadWasEmpty = false;

    this._recoil = new THREE.Vector3();          // positional kick
    this._recoilVel = new THREE.Vector3();
    this._recoilRot = new THREE.Vector3();
    this._recoilRotVel = new THREE.Vector3();
    this._sway = new THREE.Vector2();
    this._swayVel = new THREE.Vector2();
    this._bobPhase = 0;
    this._breathe = 0;
    this._shotCount = 0;

    // --- muzzle flash --------------------------------------------------------
    this.flashLight = new THREE.PointLight(0xffcc88, 0, 9, 2);
    this.flashLight.castShadow = false;
    this.muzzleAnchor.add(this.flashLight);

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
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.115, 0.115), flashMat.clone());
      m.rotation.z = (i / 3) * Math.PI;
      m.renderOrder = 30;
      this.flashSprites.add(m);
      this.flashMaterials.push(m.material);
    }
    // Forward-facing cone so the flash has volume when seen off-axis.
    this.flashCone = new THREE.Mesh(
      new THREE.ConeGeometry(0.026, 0.10, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffd9a0, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
      }),
    );
    this.flashCone.rotation.x = Math.PI / 2;
    this.flashCone.position.z = -0.05;
    this.muzzleAnchor.add(this.flashCone);
    this._flash = 0;

    this.onShot = null;
    this.onReloadEvent = null;
  }

  setupLighting() {
    // Matches the world key so the weapon reads as being in the same place,
    // with a tight fill that keeps the left side of the receiver off black.
    this.key = new THREE.DirectionalLight(0xffd0a0, 3.0);
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

    // Fixed in view space rather than chased to the sun. Turning to face a
    // dawn sun would otherwise flatten the weapon into a black cut-out, and no
    // shooter ships that; a constant three-quarter fill is the standard cheat.
    // Kept low and to the side. Raised overhead it lights every top face at
    // once and the receiver reads as light grey plastic instead of phosphate.
    this.fill = new THREE.DirectionalLight(0xb6c8dc, 2.3);
    this.fill.position.set(-0.90, 0.42, 0.85);
    this.scene.add(this.fill);

    this.rim = new THREE.DirectionalLight(0xffb066, 1.5);
    this.rim.position.set(-0.3, 0.4, -1.0);
    this.scene.add(this.rim);

    // Sky-over-sand bounce plus a flat floor. A black rifle sits around 0.06
    // albedo; without this much indirect the shadow side lands under the tone
    // curve's toe and the whole lower half of the weapon crushes to zero.
    this.scene.add(new THREE.HemisphereLight(0x9cc0e6, 0x8a6842, 2.1));
    this.scene.add(new THREE.AmbientLight(0xdfe4ee, 0.8));
  }

  /** Aligns the viewmodel key light with the world sun as the player turns. */
  syncLighting(sunDirection, worldCamera) {
    const local = sunDirection.clone().applyQuaternion(worldCamera.quaternion.clone().invert());
    this.key.position.copy(local).multiplyScalar(2).add(new THREE.Vector3(0, 0.2, 0));
    this.key.target.position.set(0, -0.05, -0.2);
    this.key.target.updateMatrixWorld();
    // Bounce sits opposite the sun so a backlit weapon still gets a warm edge
    // down the side facing the camera.
    this.rim.position.copy(local).multiplyScalar(-2).add(new THREE.Vector3(0, 0.9, 0));
  }

  /* --------------------------------------------------------------- fire -- */

  get canFire() {
    return !this.reloading && this.ammo > 0
      && (performance.now() / 1000 - this.lastShot) >= 60 / SPEC.rpm;
  }

  fire(now, player) {
    if (!this.canFire) return null;
    this.lastShot = now;
    this.ammo--;
    this._shotCount++;

    // Recoil grows for the first several rounds then plateaus — the classic
    // controllable-then-punishing curve.
    const ramp = Math.min(1, 0.45 + this._shotCount * 0.075);
    const adsScale = THREE.MathUtils.lerp(1, 0.66, player.ads);

    // Camera kick.
    const yawSign = Math.sin(this._shotCount * 2.399) ;
    player.addRecoil(
      SPEC.recoilPitch * ramp * adsScale * 42,
      SPEC.recoilYaw * ramp * adsScale * yawSign * 42,
    );

    // Viewmodel kick. Kept to a few centimetres: the weapon is only 30 cm off
    // the lens, so a kick sized for the camera reads as the gun lunging at the
    // player rather than recoiling.
    this._recoilVel.z += SPEC.recoilKick * ramp * adsScale * 24;
    this._recoilVel.y += 0.004 * ramp * adsScale * 30;
    this._recoilVel.x += yawSign * 0.0025 * ramp * adsScale * 30;
    this._recoilRotVel.x -= 0.032 * ramp * adsScale * 42;
    this._recoilRotVel.z += yawSign * 0.014 * ramp * adsScale * 42;

    this.spread = Math.min(SPEC.spreadMax, this.spread + SPEC.spreadPerShot);
    this._flash = 1;

    return {
      spread: this.currentSpread(player),
      damage: SPEC.damage,
    };
  }

  currentSpread(player) {
    const base = THREE.MathUtils.lerp(SPEC.spreadHip, SPEC.spreadAds, player.ads);
    const motion = THREE.MathUtils.clamp(player.speedHorizontal / 6, 0, 1)
      * SPEC.spreadMoving * (1 - player.ads * 0.7);
    const air = player.onGround ? 0 : 0.022;
    const crouch = player.crouching ? -base * 0.28 : 0;
    return Math.max(0.0004, base + motion + air + crouch + (this.spread - SPEC.spreadHip));
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
      this.spread = Math.max(SPEC.spreadHip, this.spread - SPEC.spreadRecover * dt);
      if (now - this.lastShot > 0.35) this._shotCount = Math.max(0, this._shotCount - dt * 22);
    }

    // --- muzzle flash decay -------------------------------------------------------
    this._flash = Math.max(0, this._flash - dt * 26);
    const f = this._flash;
    this.flashLight.intensity = f * f * 14;
    this.flashCone.material.opacity = f * 0.60;
    this.flashCone.scale.setScalar(0.7 + (1 - f) * 0.7);
    for (let i = 0; i < this.flashMaterials.length; i++) {
      this.flashMaterials[i].opacity = f * (0.62 - i * 0.13);
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
  const glove = new THREE.MeshStandardMaterial({ color: 0x171310, roughness: 0.93, metalness: 0.0 });
  const knuckle = new THREE.MeshStandardMaterial({ color: 0x0e0d0c, roughness: 0.66, metalness: 0.0 });
  const sleeve = material('canvas', [3, 3], { roughness: 1.0, color: 0x34302a });

  const piece = (parent, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const rbox = (w, h, d, r) => new RoundedBoxGeometry(w, h, d, 2, r);

  // Firing hand: palm on the backstrap, fingers wrapped across the frontstrap,
  // index laid along the receiver above the trigger.
  const right = new THREE.Group();
  right.position.set(0.002, -0.098, 0.016);
  right.rotation.set(-0.40, 0.05, 0.02);
  piece(right, rbox(0.048, 0.082, 0.030, 0.013), glove, 0.006, 0.002, 0.030);
  piece(right, rbox(0.040, 0.066, 0.014, 0.006), knuckle, 0.010, 0.006, 0.040);
  for (let i = 0; i < 3; i++) {
    piece(right, rbox(0.046, 0.0165, 0.0210, 0.0075), glove,
      -0.001, 0.008 - i * 0.0205, -0.0235 + i * 0.0022, 0, 0, -0.10 + i * 0.05);
    piece(right, rbox(0.0165, 0.0090, 0.0150, 0.004), knuckle,
      0.020, 0.008 - i * 0.0205, -0.0225 + i * 0.0022);
  }
  piece(right, rbox(0.0175, 0.0175, 0.0480, 0.0075), glove, 0.001, 0.0325, -0.0330, 0.34, 0, 0);
  piece(right, rbox(0.0180, 0.0400, 0.0180, 0.0075), glove, -0.0215, 0.0230, 0.0080, 0, 0, 0.30);
  g.add(right);

  // Support hand: C-clamp on the handguard. From the shooter's eye you see the
  // fingertips come over the top of the tube and the heel of the hand below it,
  // so those are what get modelled — the palm never faces the lens.
  const left = new THREE.Group();
  left.position.set(-0.004, -0.006, -0.288);
  left.rotation.set(0.20, 0.12, -0.26);
  piece(left, rbox(0.0145, 0.0370, 0.0650, 0.011), glove, -0.0230, -0.0175, 0.0040);
  piece(left, rbox(0.0230, 0.0140, 0.0580, 0.008), glove, -0.0130, -0.0295, 0.0030);
  for (let i = 0; i < 4; i++) {
    const z = -0.0270 + i * 0.0185;
    piece(left, rbox(0.0300, 0.0165, 0.0158, 0.0072), glove, 0.0025, 0.0215 - i * 0.0012, z, 0, 0, 0.22);
    piece(left, rbox(0.0130, 0.0060, 0.0130, 0.0025), knuckle, 0.0060, 0.0290 - i * 0.0012, z);
    piece(left, rbox(0.0135, 0.0210, 0.0150, 0.0060), glove, 0.0175, 0.0075 - i * 0.0010, z, 0, 0, -0.30);
  }
  piece(left, rbox(0.0160, 0.0150, 0.0480, 0.0068), glove, -0.0215, 0.0135, -0.0290, 0.10, 0, -0.12);
  g.add(left);

  // Cuffs — a hard edge where the glove meets the sleeve stops the hands from
  // reading as blobs. The support forearm is kept short and aimed away from the
  // lens: run it out to the side and it becomes a slab floating in mid-frame.
  piece(g, new THREE.CylinderGeometry(0.0320, 0.0385, 0.105, 16), sleeve,
    0.0250, -0.1560, 0.0920, 1.06, 0, 0.20);
  piece(g, new THREE.CylinderGeometry(0.0290, 0.0335, 0.070, 16), sleeve,
    -0.0300, -0.0520, -0.2620, 0.95, 0.20, -0.62);

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
