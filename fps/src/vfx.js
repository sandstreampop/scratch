// Particles, tracers, casings, decals and atmospherics.
//
// Every system is a fixed-size pool backed by one InstancedMesh or Points
// object, so the whole VFX layer costs a handful of draw calls no matter how
// much is going on. Nothing allocates during play.

import * as THREE from 'three';

const TAU = Math.PI * 2;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();

/* ------------------------------------------------------------- textures -- */

function canvas(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

const TEX = {};

function initTextures() {
  // Soft round spark/dust point.
  TEX.spark = canvas(64, (g, s) => {
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,240,210,0.85)');
    grad.addColorStop(0.6, 'rgba(255,190,120,0.20)');
    grad.addColorStop(1, 'rgba(255,160,80,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });

  // Billowing smoke puff — fbm-ish clumping via stacked soft blobs.
  TEX.smoke = canvas(256, (g, s) => {
    g.clearRect(0, 0, s, s);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 46; i++) {
      const a = rnd() * TAU;
      const r = Math.pow(rnd(), 0.55) * s * 0.34;
      const x = s / 2 + Math.cos(a) * r;
      const y = s / 2 + Math.sin(a) * r;
      const rad = s * (0.06 + rnd() * 0.16);
      const alpha = 0.055 + rnd() * 0.075;
      const grad = g.createRadialGradient(x, y, 0, x, y, rad);
      grad.addColorStop(0, `rgba(255,255,255,${alpha})`);
      grad.addColorStop(0.55, `rgba(240,240,240,${alpha * 0.5})`);
      grad.addColorStop(1, 'rgba(230,230,230,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, rad, 0, TAU);
      g.fill();
    }
    // Fade the rim so the sprite never shows its square boundary.
    const mask = g.createRadialGradient(s / 2, s / 2, s * 0.30, s / 2, s / 2, s * 0.5);
    mask.addColorStop(0, 'rgba(0,0,0,0)');
    mask.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = mask;
    g.fillRect(0, 0, s, s);
  });

  // Bullet hole: dark crater, bright rim of pulverised material, radial cracks.
  TEX.hole = canvas(128, (g, s) => {
    g.clearRect(0, 0, s, s);
    const cx = s / 2, cy = s / 2;
    let seed = 31;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

    // Spall halo.
    const halo = g.createRadialGradient(cx, cy, s * 0.10, cx, cy, s * 0.48);
    halo.addColorStop(0, 'rgba(196,186,170,0.72)');
    halo.addColorStop(0.45, 'rgba(170,160,146,0.30)');
    halo.addColorStop(1, 'rgba(150,142,130,0)');
    g.fillStyle = halo;
    g.fillRect(0, 0, s, s);

    // Radial fracture spurs.
    g.strokeStyle = 'rgba(90,84,76,0.5)';
    for (let i = 0; i < 14; i++) {
      const a = rnd() * TAU;
      const len = s * (0.14 + rnd() * 0.28);
      g.lineWidth = 0.6 + rnd() * 1.6;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * s * 0.08, cy + Math.sin(a) * s * 0.08);
      g.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      g.stroke();
    }

    // Crater.
    const crater = g.createRadialGradient(cx, cy, 0, cx, cy, s * 0.13);
    crater.addColorStop(0, 'rgba(8,7,6,1)');
    crater.addColorStop(0.62, 'rgba(26,22,18,0.96)');
    crater.addColorStop(1, 'rgba(60,52,44,0)');
    g.fillStyle = crater;
    g.beginPath();
    g.arc(cx, cy, s * 0.14, 0, TAU);
    g.fill();
  });

  // Blood spatter.
  TEX.blood = canvas(128, (g, s) => {
    g.clearRect(0, 0, s, s);
    let seed = 91;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 26; i++) {
      const a = rnd() * TAU;
      const r = Math.pow(rnd(), 0.7) * s * 0.42;
      const x = s / 2 + Math.cos(a) * r, y = s / 2 + Math.sin(a) * r;
      const rad = s * (0.015 + Math.pow(rnd(), 2) * 0.10);
      g.fillStyle = `rgba(${92 + rnd() * 40 | 0},${6 + rnd() * 10 | 0},${4 + rnd() * 8 | 0},${0.5 + rnd() * 0.45})`;
      g.beginPath();
      g.ellipse(x, y, rad, rad * (0.6 + rnd() * 0.8), rnd() * TAU, 0, TAU);
      g.fill();
    }
  });

  // Dust mote — very soft, near-uniform.
  TEX.mote = canvas(32, (g, s) => {
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, 'rgba(255,246,228,0.9)');
    grad.addColorStop(0.5, 'rgba(255,240,214,0.28)');
    grad.addColorStop(1, 'rgba(255,235,205,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });
}

/* ------------------------------------------------------- point particles -- */

/**
 * Pooled sprite particles. One draw call per system.
 * `mode` selects the blend: 'additive' for sparks/embers, 'normal' for smoke.
 */
class PointPool {
  constructor(scene, count, texture, mode, sizeAttenuation = true) {
    this.count = count;
    this.cursor = 0;

    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const alphas = new Float32Array(count);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    geo.setDrawRange(0, count);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uPixelRatio: { value: 1 },
        uAttenuate: { value: sizeAttenuation ? 1 : 0 },
      },
      vertexShader: /* glsl */`
        attribute float aSize;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        uniform float uPixelRatio;
        uniform float uAttenuate;
        void main() {
          vColor = color;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float atten = mix(1.0, 300.0 / max(-mv.z, 0.001), uAttenuate);
          gl_PointSize = aSize * atten * uPixelRatio;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 tex = texture2D(uMap, gl_PointCoord);
          float a = tex.a * vAlpha;
          if (a < 0.003) discard;
          gl_FragColor = vec4(vColor * tex.rgb, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      vertexColors: true,
      blending: mode === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: mode !== 'additive',
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = mode === 'additive' ? 20 : 15;
    scene.add(this.points);

    this.pos = positions;
    this.col = colors;
    this.size = sizes;
    this.alpha = alphas;

    // Per-particle simulation state (plain arrays; never resized).
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.size0 = new Float32Array(count);
    this.size1 = new Float32Array(count);
    this.drag = new Float32Array(count);
    this.grav = new Float32Array(count);
    this.spin = new Float32Array(count);
    this.fade = new Float32Array(count);       // exponent on the alpha ramp
    this.col0 = new Float32Array(count * 3);
    this.col1 = new Float32Array(count * 3);
    this.bounce = new Uint8Array(count);
    this.alive = 0;
  }

  spawn(o) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    const i3 = i * 3;

    this.pos[i3] = o.x; this.pos[i3 + 1] = o.y; this.pos[i3 + 2] = o.z;
    this.vel[i3] = o.vx; this.vel[i3 + 1] = o.vy; this.vel[i3 + 2] = o.vz;
    this.life[i] = 0;
    this.maxLife[i] = o.life;
    this.size0[i] = o.size0;
    this.size1[i] = o.size1 ?? o.size0;
    this.drag[i] = o.drag ?? 1.4;
    this.grav[i] = o.gravity ?? 0;
    this.fade[i] = o.fade ?? 1;
    this.bounce[i] = o.bounce ? 1 : 0;
    const c0 = o.color0, c1 = o.color1 ?? o.color0;
    this.col0[i3] = c0.r; this.col0[i3 + 1] = c0.g; this.col0[i3 + 2] = c0.b;
    this.col1[i3] = c1.r; this.col1[i3 + 1] = c1.g; this.col1[i3 + 2] = c1.b;
    this.alpha[i] = 0;
    return i;
  }

  update(dt, groundHeight) {
    const { pos, vel, life, maxLife, size, alpha, col, col0, col1 } = this;
    for (let i = 0; i < this.count; i++) {
      if (maxLife[i] <= 0) { alpha[i] = 0; continue; }
      life[i] += dt;
      const t = life[i] / maxLife[i];
      if (t >= 1) { maxLife[i] = 0; alpha[i] = 0; continue; }

      const i3 = i * 3;
      const d = Math.max(0, 1 - this.drag[i] * dt);
      vel[i3] *= d; vel[i3 + 2] *= d;
      vel[i3 + 1] = vel[i3 + 1] * d - this.grav[i] * dt;

      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;

      if (this.bounce[i] && groundHeight) {
        const gy = groundHeight(pos[i3], pos[i3 + 2]);
        if (pos[i3 + 1] < gy) {
          pos[i3 + 1] = gy;
          vel[i3 + 1] = Math.abs(vel[i3 + 1]) * 0.32;
          vel[i3] *= 0.6; vel[i3 + 2] *= 0.6;
        }
      }

      size[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      alpha[i] = Math.pow(1 - t, this.fade[i]) * Math.min(1, t * 14);
      col[i3] = col0[i3] + (col1[i3] - col0[i3]) * t;
      col[i3 + 1] = col0[i3 + 1] + (col1[i3 + 1] - col0[i3 + 1]) * t;
      col[i3 + 2] = col0[i3 + 2] + (col1[i3 + 2] - col0[i3 + 2]) * t;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
  }
}

/* ---------------------------------------------------------------- decals -- */

class DecalPool {
  constructor(scene, count, texture, opts = {}) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
      roughness: opts.roughness ?? 0.86,
      metalness: 0,
      side: THREE.DoubleSide,
      alphaTest: 0.004,
      ...opts.material,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.frustumCulled = false;
    this.mesh.count = count;
    this.mesh.renderOrder = 5;
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;

    // Park everything off-screen until used.
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < count; i++) this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;

    scene.add(this.mesh);
    this.count = count;
    this.cursor = 0;
  }

  place(point, normal, size, roll = Math.random() * TAU) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    _q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
    _v.copy(point).addScaledVector(normal, 0.012);
    _s.set(size, size, size);
    _m.compose(_v, _q, _s);
    this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/* --------------------------------------------------------------- tracers -- */

class TracerPool {
  constructor(scene, count) {
    // A unit quad stretched along -Z; the shader keeps it facing the camera
    // by billboarding around its own axis.
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd9a2,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      opacity: 1,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 22;
    scene.add(this.mesh);

    this.opacity = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    geo.setAttribute('aOpacity', this.opacity);
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = 'attribute float aOpacity;\nvarying float vO;\n'
        + shader.vertexShader.replace('void main() {', 'void main() {\n  vO = aOpacity;');
      shader.fragmentShader = 'varying float vO;\n'
        + shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          'gl_FragColor = vec4( outgoingLight, diffuseColor.a * vO );',
        );
    };

    this.count = count;
    this.cursor = 0;
    this.from = new Float32Array(count * 3);
    this.dir = new Float32Array(count * 3);
    this.speed = new Float32Array(count);
    this.dist = new Float32Array(count);
    this.maxDist = new Float32Array(count);
    this.width = new Float32Array(count);
    this.active = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      _m.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, _m);
    }
  }

  fire(origin, direction, distance, speed = 480, width = 0.022) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    const i3 = i * 3;
    this.from[i3] = origin.x; this.from[i3 + 1] = origin.y; this.from[i3 + 2] = origin.z;
    this.dir[i3] = direction.x; this.dir[i3 + 1] = direction.y; this.dir[i3 + 2] = direction.z;
    this.speed[i] = speed;
    this.dist[i] = 0;
    this.maxDist[i] = distance;
    this.width[i] = width;
    this.active[i] = 1;
  }

  update(dt, camera) {
    let any = false;
    const camPos = camera.position;
    for (let i = 0; i < this.count; i++) {
      if (!this.active[i]) continue;
      any = true;
      const i3 = i * 3;
      this.dist[i] += this.speed[i] * dt;
      if (this.dist[i] > this.maxDist[i] + 6) {
        this.active[i] = 0;
        this.opacity.array[i] = 0;
        _m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _m);
        continue;
      }
      // Streak trails behind the projectile head.
      const head = Math.min(this.dist[i], this.maxDist[i]);
      const len = Math.min(5.5, head);
      const tail = head - len;
      _v.set(this.from[i3] + this.dir[i3] * tail,
        this.from[i3 + 1] + this.dir[i3 + 1] * tail,
        this.from[i3 + 2] + this.dir[i3 + 2] * tail);
      _v2.set(this.dir[i3], this.dir[i3 + 1], this.dir[i3 + 2]);

      // Billboard: quad's local Y runs along the tracer, local Z faces camera.
      const toCam = new THREE.Vector3().subVectors(camPos, _v).normalize();
      const side = new THREE.Vector3().crossVectors(_v2, toCam).normalize();
      const facing = new THREE.Vector3().crossVectors(side, _v2).normalize();
      const basis = new THREE.Matrix4().makeBasis(side, _v2, facing);
      _q.setFromRotationMatrix(basis);
      _s.set(this.width[i], len, 1);
      _m.compose(_v, _q, _s);
      this.mesh.setMatrixAt(i, _m);

      // Fade over the flight so the streak does not pop out at the end.
      this.opacity.array[i] = Math.min(1, (this.maxDist[i] - head) / 3 + 0.15)
        * Math.min(1, this.dist[i] / 2.2);
    }
    if (any) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.opacity.needsUpdate = true;
    }
  }
}

/* --------------------------------------------------------------- casings -- */

class CasingPool {
  constructor(scene, count) {
    const geo = new THREE.CylinderGeometry(0.0045, 0.0050, 0.0225, 8);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xc79a45, roughness: 0.28, metalness: 1.0,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    scene.add(this.mesh);
    for (let i = 0; i < count; i++) { _m.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, _m); }

    this.count = count;
    this.cursor = 0;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.rot = new Float32Array(count * 3);
    this.spin = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.rest = new Uint8Array(count);
    this.onLand = null;
  }

  eject(origin, direction, up) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    const i3 = i * 3;
    this.pos[i3] = origin.x; this.pos[i3 + 1] = origin.y; this.pos[i3 + 2] = origin.z;
    // Right and slightly rearward, as a real ejection port throws.
    const speed = 2.4 + Math.random() * 1.1;
    this.vel[i3] = direction.x * speed + (Math.random() - 0.5) * 0.5;
    this.vel[i3 + 1] = up * (1.6 + Math.random() * 0.7);
    this.vel[i3 + 2] = direction.z * speed + (Math.random() - 0.5) * 0.5;
    this.rot[i3] = Math.random() * TAU;
    this.rot[i3 + 1] = Math.random() * TAU;
    this.rot[i3 + 2] = Math.random() * TAU;
    this.spin[i3] = (Math.random() - 0.5) * 34;
    this.spin[i3 + 1] = (Math.random() - 0.5) * 26;
    this.spin[i3 + 2] = (Math.random() - 0.5) * 34;
    this.life[i] = 9;
    this.rest[i] = 0;
  }

  update(dt, groundHeight) {
    let any = false;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt;
      const i3 = i * 3;

      if (!this.rest[i]) {
        this.vel[i3 + 1] -= 19.6 * dt;
        this.pos[i3] += this.vel[i3] * dt;
        this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
        this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
        this.rot[i3] += this.spin[i3] * dt;
        this.rot[i3 + 1] += this.spin[i3 + 1] * dt;
        this.rot[i3 + 2] += this.spin[i3 + 2] * dt;

        const gy = groundHeight(this.pos[i3], this.pos[i3 + 2]) + 0.005;
        if (this.pos[i3 + 1] <= gy) {
          this.pos[i3 + 1] = gy;
          if (Math.abs(this.vel[i3 + 1]) < 0.55) {
            this.rest[i] = 1;
            this.rot[i3] = Math.PI / 2;                 // lie flat
            this.rot[i3 + 2] = 0;
            this.life[i] = Math.min(this.life[i], 7);
          } else {
            this.onLand?.(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2],
              Math.abs(this.vel[i3 + 1]));
            this.vel[i3 + 1] = -this.vel[i3 + 1] * 0.34;
            this.vel[i3] *= 0.55; this.vel[i3 + 2] *= 0.55;
            for (let k = 0; k < 3; k++) this.spin[i3 + k] *= 0.5;
          }
        }
      }

      _v.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]);
      _q.setFromEuler(new THREE.Euler(this.rot[i3], this.rot[i3 + 1], this.rot[i3 + 2]));
      const fade = Math.min(1, this.life[i] / 1.2);
      _s.setScalar(fade);
      _m.compose(_v, _q, _s);
      this.mesh.setMatrixAt(i, _m);
      if (this.life[i] <= 0) { _m.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, _m); }
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ VFX -- */

export class VFX {
  constructor(scene, camera, level) {
    initTextures();
    this.scene = scene;
    this.camera = camera;
    this.level = level;
    this.groundHeight = (x, z) => level.groundHeight(x, z);

    this.sparks = new PointPool(scene, 900, TEX.spark, 'additive');
    this.debris = new PointPool(scene, 700, TEX.spark, 'normal');
    this.smoke = new PointPool(scene, 620, TEX.smoke, 'normal');
    this.blood = new PointPool(scene, 420, TEX.spark, 'normal');

    this.holes = new DecalPool(scene, 220, TEX.hole);
    this.bloodDecals = new DecalPool(scene, 90, TEX.blood, { roughness: 0.42 });

    this.tracers = new TracerPool(scene, 90);
    this.casings = new CasingPool(scene, 80);

    this.buildAmbientDust();

    this._impactLights = [];
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffb060, 0, 4.5, 2);
      l.visible = false;
      scene.add(l);
      this._impactLights.push({ light: l, life: 0 });
    }
    this._lightCursor = 0;

    this.onCasingLand = null;
    this.casings.onLand = (x, y, z, v) => this.onCasingLand?.(x, y, z, v);
  }

  /** Slow-drifting motes that catch the sun — the single cheapest way to
   *  make an outdoor scene feel like it has air in it. */
  buildAmbientDust() {
    const N = 1400;
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 120;
      pos[i * 3 + 1] = Math.random() * 16;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 120;
      seed[i] = Math.random() * 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this.dustMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: TEX.mote },
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uPixelRatio: { value: 1 },
        uSun: { value: new THREE.Vector3(1, 0.1, 0) },
        uColor: { value: new THREE.Color(0xffd9a8) },
      },
      vertexShader: /* glsl */`
        attribute float aSeed;
        uniform float uTime; uniform vec3 uCam; uniform float uPixelRatio;
        uniform vec3 uSun;
        varying float vAlpha;
        void main() {
          // Wrap the field around the camera so it is always populated.
          vec3 p = position;
          p.x += sin(uTime * 0.14 + aSeed) * 1.6 + uTime * 0.22;
          p.y += sin(uTime * 0.21 + aSeed * 1.7) * 0.9;
          p.z += cos(uTime * 0.11 + aSeed * 0.6) * 1.6;
          vec3 rel = p - uCam;
          rel = mod(rel + 60.0, 120.0) - 60.0;
          p = uCam + rel;
          p.y = clamp(p.y, 0.15, 18.0);

          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float dist = -mv.z;
          gl_PointSize = clamp((0.5 + 0.9 * fract(aSeed)) * (26.0 / max(dist, 0.6)), 0.6, 7.0) * uPixelRatio;

          // Motes only really show when they are between you and the sun.
          vec3 toCam = normalize(uCam - p);
          float back = pow(max(dot(-toCam, -uSun), 0.0), 3.0);
          vAlpha = (0.018 + back * 0.20) * smoothstep(48.0, 4.0, dist) * smoothstep(0.4, 3.5, dist);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap; uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
          if (a < 0.002) discard;
          gl_FragColor = vec4(uColor, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });

    this.dust = new THREE.Points(geo, this.dustMaterial);
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 18;
    this.scene.add(this.dust);
  }

  /* ------------------------------------------------------------ spawners -- */

  flashLight(position, color, intensity, life) {
    const slot = this._impactLights[this._lightCursor];
    this._lightCursor = (this._lightCursor + 1) % this._impactLights.length;
    slot.light.position.copy(position);
    slot.light.color.set(color);
    slot.light.intensity = intensity;
    slot.light.visible = true;
    slot.life = life;
    slot.max = life;
    slot.peak = intensity;
  }

  /** Surface hit: spall, dust, sparks on hard materials, and a hole decal. */
  impact(point, normal, surface = 'stone', energy = 1) {
    const hard = surface === 'metal' || surface === 'stone';

    this.holes.place(point, normal, hard ? 0.10 + Math.random() * 0.05 : 0.13 + Math.random() * 0.06);

    // Dust puff along the surface normal, biased upward.
    const puffs = 5 + (Math.random() * 4 | 0);
    for (let i = 0; i < puffs; i++) {
      const spread = 0.75;
      this.smoke.spawn({
        x: point.x + (Math.random() - 0.5) * 0.06,
        y: point.y + (Math.random() - 0.5) * 0.06,
        z: point.z + (Math.random() - 0.5) * 0.06,
        vx: normal.x * (0.9 + Math.random()) + (Math.random() - 0.5) * spread,
        vy: normal.y * (0.9 + Math.random()) + Math.random() * 0.7 + 0.3,
        vz: normal.z * (0.9 + Math.random()) + (Math.random() - 0.5) * spread,
        life: 0.75 + Math.random() * 0.85,
        size0: 6 + Math.random() * 5,
        size1: 34 + Math.random() * 26,
        drag: 2.6,
        gravity: -0.7,
        fade: 1.7,
        color0: new THREE.Color(0.62, 0.55, 0.44),
        color1: new THREE.Color(0.42, 0.38, 0.32),
      });
    }

    // Ejecta chunks that bounce.
    const chunks = 6 + (Math.random() * 6 | 0);
    for (let i = 0; i < chunks; i++) {
      const a = Math.random() * TAU, e = Math.random() * 0.9;
      const t1 = new THREE.Vector3(normal.z, normal.x, -normal.y).normalize();
      const t2 = new THREE.Vector3().crossVectors(normal, t1);
      const dir = new THREE.Vector3()
        .addScaledVector(normal, 0.8 + Math.random() * 0.7)
        .addScaledVector(t1, Math.cos(a) * e)
        .addScaledVector(t2, Math.sin(a) * e)
        .normalize();
      const sp = 2.2 + Math.random() * 5.5;
      this.debris.spawn({
        x: point.x, y: point.y, z: point.z,
        vx: dir.x * sp, vy: dir.y * sp + 1.2, vz: dir.z * sp,
        life: 0.7 + Math.random() * 1.1,
        size0: 1.6 + Math.random() * 2.4,
        size1: 1.0 + Math.random() * 1.2,
        drag: 0.45,
        gravity: 15,
        fade: 0.7,
        bounce: true,
        color0: new THREE.Color(0.46, 0.40, 0.32),
        color1: new THREE.Color(0.34, 0.30, 0.25),
      });
    }

    // Sparks only where metal or stone would actually strike them.
    if (hard) {
      const n = 8 + (Math.random() * 12 | 0);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU, e = Math.random();
        const t1 = new THREE.Vector3(normal.z, normal.x, -normal.y).normalize();
        const t2 = new THREE.Vector3().crossVectors(normal, t1);
        const dir = new THREE.Vector3()
          .addScaledVector(normal, 0.5 + Math.random() * 0.9)
          .addScaledVector(t1, Math.cos(a) * e * 1.3)
          .addScaledVector(t2, Math.sin(a) * e * 1.3)
          .normalize();
        const sp = 4 + Math.random() * 11;
        this.sparks.spawn({
          x: point.x, y: point.y, z: point.z,
          vx: dir.x * sp, vy: dir.y * sp, vz: dir.z * sp,
          life: 0.16 + Math.random() * 0.42,
          size0: 3.2 + Math.random() * 3.4,
          size1: 0.4,
          drag: 1.1,
          gravity: 13,
          fade: 1.5,
          bounce: true,
          color0: new THREE.Color(3.4, 2.1, 0.85),
          color1: new THREE.Color(1.5, 0.32, 0.06),
        });
      }
      this.flashLight(point, 0xffa040, 2.6 * energy, 0.09);
    }
  }

  /** Body hit: mist, spatter and a ground decal. */
  bloodBurst(point, direction, amount = 1) {
    const n = (10 + Math.random() * 12) * amount | 0;
    for (let i = 0; i < n; i++) {
      const sp = 1.6 + Math.random() * 5;
      const d = direction.clone()
        .add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.85))
        .normalize();
      this.blood.spawn({
        x: point.x, y: point.y, z: point.z,
        vx: d.x * sp, vy: d.y * sp + 0.8, vz: d.z * sp,
        life: 0.35 + Math.random() * 0.6,
        size0: 3 + Math.random() * 6,
        size1: 1.5 + Math.random() * 3,
        drag: 1.5,
        gravity: 12,
        fade: 1.2,
        color0: new THREE.Color(0.42, 0.028, 0.018),
        color1: new THREE.Color(0.16, 0.012, 0.008),
      });
    }
    // Fine mist that hangs for a moment.
    for (let i = 0; i < 5 * amount; i++) {
      this.smoke.spawn({
        x: point.x, y: point.y, z: point.z,
        vx: direction.x * 1.3 + (Math.random() - 0.5) * 0.8,
        vy: (Math.random() - 0.2) * 0.7,
        vz: direction.z * 1.3 + (Math.random() - 0.5) * 0.8,
        life: 0.32 + Math.random() * 0.30,
        size0: 5,
        size1: 22,
        drag: 3.6,
        gravity: 1.5,
        fade: 2.2,
        color0: new THREE.Color(0.38, 0.045, 0.035),
        color1: new THREE.Color(0.20, 0.03, 0.025),
      });
    }
  }

  /** Muzzle smoke that lingers in front of the shooter. */
  muzzleSmoke(position, direction) {
    for (let i = 0; i < 3; i++) {
      this.smoke.spawn({
        x: position.x, y: position.y, z: position.z,
        vx: direction.x * (1.6 + Math.random()) + (Math.random() - 0.5) * 0.5,
        vy: direction.y * 1.4 + 0.35 + Math.random() * 0.4,
        vz: direction.z * (1.6 + Math.random()) + (Math.random() - 0.5) * 0.5,
        life: 0.5 + Math.random() * 0.8,
        size0: 4 + Math.random() * 4,
        size1: 26 + Math.random() * 22,
        drag: 3.0,
        gravity: -1.2,
        fade: 2.0,
        color0: new THREE.Color(0.55, 0.52, 0.48),
        color1: new THREE.Color(0.40, 0.38, 0.36),
      });
    }
  }

  /** Dust kicked up by a footfall. */
  footDust(position, strength) {
    const n = 2 + (strength * 4 | 0);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      this.smoke.spawn({
        x: position.x + Math.cos(a) * 0.14,
        y: position.y + 0.03,
        z: position.z + Math.sin(a) * 0.14,
        vx: Math.cos(a) * 0.5 * strength,
        vy: 0.25 + Math.random() * 0.35,
        vz: Math.sin(a) * 0.5 * strength,
        life: 0.6 + Math.random() * 0.6,
        size0: 6,
        size1: 26 + Math.random() * 14,
        drag: 3.2,
        gravity: -0.4,
        fade: 2.4,
        color0: new THREE.Color(0.52, 0.46, 0.36),
        color1: new THREE.Color(0.40, 0.36, 0.30),
      });
    }
  }

  update(dt, elapsed, sunDirection) {
    this.sparks.update(dt, this.groundHeight);
    this.debris.update(dt, this.groundHeight);
    this.smoke.update(dt, null);
    this.blood.update(dt, this.groundHeight);
    this.tracers.update(dt, this.camera);
    this.casings.update(dt, this.groundHeight);

    const u = this.dustMaterial.uniforms;
    u.uTime.value = elapsed;
    u.uCam.value.copy(this.camera.position);
    if (sunDirection) u.uSun.value.copy(sunDirection);

    for (const slot of this._impactLights) {
      if (slot.life <= 0) continue;
      slot.life -= dt;
      if (slot.life <= 0) { slot.light.visible = false; slot.light.intensity = 0; continue; }
      const k = slot.life / slot.max;
      slot.light.intensity = slot.peak * k * k;
    }
  }

  setPixelRatio(r) {
    this.sparks.points.material.uniforms.uPixelRatio.value = r;
    this.debris.points.material.uniforms.uPixelRatio.value = r;
    this.smoke.points.material.uniforms.uPixelRatio.value = r;
    this.blood.points.material.uniforms.uPixelRatio.value = r;
    this.dustMaterial.uniforms.uPixelRatio.value = r;
  }
}
