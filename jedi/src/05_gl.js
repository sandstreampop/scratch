/* JK.GL + JK.Geo — WebGL1 renderer with one gouraud/fog shader. Owner: core. */
(function(){
'use strict';
var M = JK.M;
var gl = null, prog = null, canvas = null, dpr = 1;
var loc = {};
var proj = M.make(), view = M.make(), IDENT = M.make();
var sunDir = new Float32Array([0.45, 0.75, 0.35]);
var sunCol = new Float32Array([1.0, 0.93, 0.78]);
var amb    = new Float32Array([0.38, 0.34, 0.30]);
var fogCol = new Float32Array([0.86, 0.72, 0.52]);
var fogDen = 0.0035;
var curBlend = false;
/* ---------------------------------------------------------------------------
   WHY THIS RENDERER IS SHAPED LIKE THIS: on iOS Safari every WebGL entry point
   is marshalled across a process boundary, so the number of GL CALLS dominates
   frame time far more than triangle throughput. Three measured stages, counted
   by wrapping every entry point of the live context and dividing by frames — one
   hand-composed frame at a fixed 120-particle load, then the same build under
   the 12 s busy-combat benchmark (bots + bolts + force fx, so it runs higher):

                                                    120-part frame   busy combat
     per-mesh buffers, one draw per particle             1204            1553
     + static meshes packed into shared PAGES             639             586
     + the particle pool collapsed into ONE batch         279             489

   Draw calls over the same three stages: 201 -> 201 -> 79 at 120 particles.

   The page trick is the big one. Every mesh in the game uses the identical
   vertex layout, so instead of one vertex+normal+colour+index buffer per mesh
   (7 binding calls whenever the mesh changes) we suballocate meshes out of a
   few large interleaved buffers. Meshes sharing a page need NO binding calls at
   all — just drawElements at the right index offset. That removed ~7 calls from
   every one of the ~140 draws a busy frame issues.

   Consequences to respect if you touch this file:
   - Nothing outside this module touches GL state (verified by grep), so the
     redundant-state caches below are safe.
   - Uniform caches are per-program and survive across frames; only beginFrame's
     blend/depth reset and mesh()/dynamic() (which leave bindings dangling)
     invalidate anything.
   - Model matrices are caller-owned mutable scratch, so ONLY the identity model
     may be cached by reference.
   --------------------------------------------------------------------------- */
var curBind = null;      /* page (or dynamic handle) whose buffers are bound */
var uEm = -1, uAl = -1, uNf = -1, uTr = -1, uTg = -1, uTb = -1;
var uMIdent = false;     /* is uModel currently the identity? */
var lightDirty = true;   /* sun/fog uniforms need re-upload */

/* interleaved vertex layout shared by every mesh, page and dynamic batch:
   [px,py,pz, nx,ny,nz, r,g,b] — 9 floats, 36 bytes */
var VSTRIDE = 36, VFLOATS = 9;
var NOOPTS = {};         /* draw()'s default opts — never written, never leaked */

var VS =
'attribute vec3 aP; attribute vec3 aN; attribute vec3 aC;\n'+
'uniform mat4 uProj, uView, uModel;\n'+
'uniform vec3 uSunDir, uSunCol, uAmb, uTint;\n'+
'uniform float uEmissive;\n'+
'varying vec3 vCol; varying float vDist;\n'+
'void main(){\n'+
'  vec4 wp = uModel * vec4(aP, 1.0);\n'+
'  mat3 nm = mat3(uModel[0].xyz, uModel[1].xyz, uModel[2].xyz);\n'+
'  vec3 n = normalize(nm * aN);\n'+
'  float d = max(dot(n, uSunDir), 0.0);\n'+
'  vec3 base = aC * uTint;\n'+
'  vec3 lit = (uAmb + uSunCol * d) * base;\n'+
'  vCol = mix(lit, base, uEmissive);\n'+
'  vec4 vp = uView * wp;\n'+
'  vDist = length(vp.xyz);\n'+
'  gl_Position = uProj * vp;\n'+
'}';
var FS =
'precision mediump float;\n'+
'varying vec3 vCol; varying float vDist;\n'+
'uniform vec3 uFogCol; uniform float uFogDen; uniform float uAlpha; uniform float uNoFog;\n'+
'void main(){\n'+
'  float f = exp(-uFogDen * uFogDen * vDist * vDist * 1.442695);\n'+
'  f = clamp(max(f, uNoFog), 0.0, 1.0);\n'+
'  gl_FragColor = vec4(mix(uFogCol, vCol, f), uAlpha);\n'+
'}';

function sh(type, src){
  var s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error('shader: ' + gl.getShaderInfoLog(s));
  return s;
}

var GL = JK.GL = {
  gl: null, eye: new Float32Array(3), aspect: 1, w: 0, h: 0,

  /* read-only diagnostics: page count should settle to a small constant after
     boot. If it keeps climbing, something is calling mesh() every frame.
     `clamped` counts batch draws that asked for more than the batch holds — it
     must stay 0; anything else means a pool cap and its batch have drifted. */
  stats: { meshes: 0, verts: 0, pages: 0, batches: 0, clamped: 0 },

  init: function(cv){
    canvas = cv;
    gl = cv.getContext('webgl', {antialias:false, alpha:false, depth:true,
      powerPreference:'high-performance'}) || cv.getContext('experimental-webgl');
    if (!gl) return false;
    GL.gl = gl;
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(prog, 0, 'aP');
    gl.bindAttribLocation(prog, 1, 'aN');
    gl.bindAttribLocation(prog, 2, 'aC');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error('link: ' + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    ['uProj','uView','uModel','uSunDir','uSunCol','uAmb','uTint','uEmissive',
     'uFogCol','uFogDen','uAlpha','uNoFog'].forEach(function(n){ loc[n] = gl.getUniformLocation(prog, n); });
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    gl.enableVertexAttribArray(2);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    return true;
  },

  fog: function(col, den){ fogCol.set(col); fogDen = den; lightDirty = true; },
  sun: function(dir, col, ambient){
    var l = Math.sqrt(dir[0]*dir[0]+dir[1]*dir[1]+dir[2]*dir[2]) || 1;
    sunDir[0]=dir[0]/l; sunDir[1]=dir[1]/l; sunDir[2]=dir[2]/l;
    sunCol.set(col); amb.set(ambient); lightDirty = true;
  },

  beginFrame: function(r, g, b){
    var w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h){ canvas.width = w; canvas.height = h; }
    GL.w = w; GL.h = h; GL.aspect = w / (h || 1);
    gl.viewport(0, 0, w, h);
    gl.clearColor(r, g, b, 1);
    /* Additive draws leave BLEND on and depthMask(false), and a masked depth
       buffer silently IGNORES gl.clear(DEPTH_BUFFER_BIT). Restoring the opaque
       state here makes the clear correct no matter who drew last, so effect
       modules no longer need a degenerate "reset" draw at the end of draw(). */
    if (curBlend){ gl.disable(gl.BLEND); gl.depthMask(true); curBlend = false; }
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (lightDirty){          /* uniforms persist; only re-send on change */
      gl.uniform3fv(loc.uSunDir, sunDir);
      gl.uniform3fv(loc.uSunCol, sunCol);
      gl.uniform3fv(loc.uAmb, amb);
      gl.uniform3fv(loc.uFogCol, fogCol);
      gl.uniform1f(loc.uFogDen, fogDen);
      lightDirty = false;
    }
  },

  setCamera: function(eye, target, fovDeg){
    GL.eye[0]=eye[0]; GL.eye[1]=eye[1]; GL.eye[2]=eye[2];
    M.persp(proj, (fovDeg||70) * Math.PI/180, GL.aspect, 0.1, 2000);
    M.lookAt(view, eye, target, [0,1,0]);
    gl.uniformMatrix4fv(loc.uProj, false, proj);
    gl.uniformMatrix4fv(loc.uView, false, view);
  },

  /* geo: {pos,nrm,col:Float32Array, idx:Uint16Array}
     Suballocated out of a shared page — see the header note. The returned handle
     is opaque; nothing outside this file may read its fields. */
  mesh: function(geo){
    var nv = geo.pos.length / 3, ni = geo.idx.length, i, j;
    if (nv > 65536) throw new Error('GL.mesh: ' + nv + ' verts > 65536');
    var pg = pageFor(nv, ni);
    var base = pg.nv;
    var v = new Float32Array(nv * VFLOATS);    /* init-time only, not per frame */
    var P = geo.pos, N = geo.nrm, C = geo.col;
    for (i = 0; i < nv; i++){
      var o = i * VFLOATS; j = i * 3;
      v[o]   = P[j]; v[o+1] = P[j+1]; v[o+2] = P[j+2];
      v[o+3] = N[j]; v[o+4] = N[j+1]; v[o+5] = N[j+2];
      v[o+6] = C[j]; v[o+7] = C[j+1]; v[o+8] = C[j+2];
    }
    var idx = new Uint16Array(ni);              /* rebased into the page */
    for (i = 0; i < ni; i++) idx[i] = geo.idx[i] + base;
    gl.bindBuffer(gl.ARRAY_BUFFER, pg.vb);
    gl.bufferSubData(gl.ARRAY_BUFFER, base * VSTRIDE, v);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, pg.ib);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, pg.ni * 2, idx);
    var m = { page: pg, first: pg.ni, count: ni };
    pg.nv += nv; pg.ni += ni;
    GL.stats.meshes++; GL.stats.verts += nv; GL.stats.pages = pages.length;
    curBind = null;               /* uploading left bindings/pointers stale */
    return m;
  },

  /* DYNAMIC batch — see the note above dynamic()'s helpers below. */
  dynamic: function(maxVerts, opt){
    opt = opt || {};
    if (maxVerts > 65536) throw new Error('GL.dynamic: ' + maxVerts + ' verts > 65536');
    var h = {
      _dyn: true,
      max: maxVerts,
      v: new Float32Array(maxVerts * VFLOATS),  /* interleaved, stride 9 */
      idx: opt.idx || new Uint16Array(opt.maxIdx || maxVerts * 3),
      n: 0,                      /* vertices written this frame */
      ni: 0,                     /* indices to draw this frame  */
      staticIdx: !!opt.idx,
      vb: gl.createBuffer(), ib: gl.createBuffer()
    };
    /* Draw ceiling, precomputed so the per-frame clamp in drawDynamic is two
       compares: whole triangles only, so an over-full batch loses a primitive
       rather than half of one. */
    h.maxI = h.idx.length - (h.idx.length % 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, h.vb);
    gl.bufferData(gl.ARRAY_BUFFER, h.v.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, h.ib);
    if (h.staticIdx) gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, h.idx, gl.STATIC_DRAW);
    else gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, h.idx.byteLength, gl.DYNAMIC_DRAW);
    h.vv = mkViews(h.v, VBUCKET * VFLOATS);
    h.vi = mkViews(h.idx, IBUCKET);
    GL.stats.batches++;
    curBind = null;              /* buffer creation left bindings dangling */
    return h;
  },

  reset: function(h){ h.n = 0; h.ni = 0; },

  draw: function(mesh, model, opts){
    opts = opts || NOOPTS;        /* shared: `opts || {}` allocated every frame */
    if (mesh._dyn){ drawDynamic(mesh, model, opts); return; }
    applyState(model, opts);
    if (mesh.page !== curBind) bindUnit(mesh.page);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, mesh.first * 2);
  }
};

/* ---- shared static-geometry pages ------------------------------------------
 * One page holds many meshes in one interleaved vertex buffer + one index
 * buffer, so switching between meshes on the same page costs ZERO GL calls.
 * Indices are rebased at upload time (WebGL1 has no baseVertex), which is why a
 * page can never exceed the 16-bit index range. A geo too big for a fresh page
 * gets a page sized exactly to it (the 129x129 terrain grid: 16641 verts /
 * 98304 indices), and small meshes keep filling the general pages after it. */
var PAGE_V = 16384, PAGE_I = 32768;
var pages = [];

function newPage(capV, capI){
  var p = { vb: gl.createBuffer(), ib: gl.createBuffer(),
            capV: capV, capI: capI, nv: 0, ni: 0 };
  gl.bindBuffer(gl.ARRAY_BUFFER, p.vb);
  gl.bufferData(gl.ARRAY_BUFFER, capV * VSTRIDE, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, p.ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, capI * 2, gl.STATIC_DRAW);
  pages.push(p);
  return p;
}

function pageFor(nv, ni){
  for (var i = 0; i < pages.length; i++){
    var p = pages[i];
    if (p.nv + nv <= p.capV && p.ni + ni <= p.capI) return p;
  }
  if (nv > PAGE_V || ni > PAGE_I) return newPage(nv, ni);   /* exact-fit page */
  return newPage(PAGE_V, PAGE_I);
}

/* Bind a page or a dynamic handle. Both use the same interleaved layout, so the
 * three attrib pointers are identical — but WebGL1 has no VAOs, so a pointer
 * always re-captures whatever is bound and must be re-issued on a switch. */
function bindUnit(u){
  gl.bindBuffer(gl.ARRAY_BUFFER, u.vb);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VSTRIDE, 0);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, VSTRIDE, 12);
  gl.vertexAttribPointer(2, 3, gl.FLOAT, false, VSTRIDE, 24);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, u.ib);
  curBind = u;
}

/* ---- per-draw uniform + blend state, shared by both draw paths -------------
 * Only the IDENTITY model matrix is cached: callers hand us mutable scratch
 * matrices (M.ident(MTX); M.tr(MTX,...) then draw), so a by-reference compare
 * on a real model matrix would be wrong. null/IDENT is safe and is what the
 * batched path normally passes (its vertices are already in world space) — but
 * a batch handed a model matrix honours it like any other mesh, so the two draw
 * paths cannot disagree about what argument 2 means. */
function applyState(model, opts){
  if (model && model !== IDENT){
    gl.uniformMatrix4fv(loc.uModel, false, model); uMIdent = false;
  } else if (!uMIdent){
    gl.uniformMatrix4fv(loc.uModel, false, IDENT); uMIdent = true;
  }
  var v = opts.emissive || 0;
  if (v !== uEm){ gl.uniform1f(loc.uEmissive, v); uEm = v; }
  v = opts.alpha !== undefined ? opts.alpha : 1;
  if (v !== uAl){ gl.uniform1f(loc.uAlpha, v); uAl = v; }
  v = opts.nofog ? 1 : 0;
  if (v !== uNf){ gl.uniform1f(loc.uNoFog, v); uNf = v; }
  var t = opts.tint;
  var tr = t ? t[0] : 1, tg = t ? t[1] : 1, tb = t ? t[2] : 1;
  if (tr !== uTr || tg !== uTg || tb !== uTb){
    gl.uniform3f(loc.uTint, tr, tg, tb); uTr = tr; uTg = tg; uTb = tb;
  }
  var add = !!opts.additive;
  if (add !== curBlend){
    curBlend = add;
    if (add){ gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE); gl.depthMask(false); }
    else { gl.disable(gl.BLEND); gl.depthMask(true); }
  }
}

/* ---- DYNAMIC batched geometry ----------------------------------------------
 * WHY: JK.Fx used to issue ONE gl.drawElements per live particle — 150+
 * back-to-back draws of the same unit cube in a spark burst. Every WebGL call
 * on iOS Safari is marshalled across a process boundary, so the call COUNT, not
 * the triangle count, was the frame-time spike. CPU-transforming a cube into a
 * shared vertex buffer is ~30 float ops; a driver call is far more expensive.
 *
 * USAGE (WebGL1, no extensions, no VAOs; coexists with the static mesh path):
 *   var h = JK.GL.dynamic(maxVerts, {idx: template});
 *   // once: write the normals into h.v[o+3..o+5] for every slot
 *   JK.GL.reset(h);
 *   ... for each primitive, write WORLD-space verts into h.v at stride 9
 *       (pos at o..o+2, colour at o+6..o+8), advancing h.n;
 *       set h.ni = number of indices to draw ...
 *   if (h.ni) JK.GL.draw(h, null, opts);      // ONE bufferSubData + ONE
 *                                             // drawElements, total
 * opt.idx     Uint16Array index template uploaded once as STATIC_DRAW. Use it
 *             when the batch is N copies of one primitive packed from slot 0
 *             (then ni = count * indicesPerPrimitive). Omit to rewrite h.idx
 *             every frame (opt.maxIdx sizes it).
 *
 * The counts are the ONLY thing that decides what is drawn, so a frame with
 * fewer primitives than the last can never show leftovers — set them every
 * frame (or JK.GL.reset(h)) and never leave last frame's ni behind. Asking for
 * more than the batch holds is clamped to whole triangles and counted in
 * stats.clamped; it is a bug in the producer, not a licence to overfill.
 *
 * Vertices are interleaved exactly like a static page, so constant attributes
 * (normals for emissive draws) are written once at build time and simply ride
 * along in the upload — that costs bandwidth, never a call.
 *
 * Per-draw uniforms (emissive/alpha/tint/nofog/blend) are shared by the whole
 * batch, so fold anything that varies per primitive into the VERTEX COLOUR.
 * For additive+nofog+emissive draws that is exact: the shader reduces to
 * dst += aC*uTint*uAlpha, so aC = colour*alpha with uTint=1, uAlpha=1 is
 * bit-identical to one draw per primitive. Deliberately goes through draw() so
 * a batch counts as exactly one draw call in the profiler — which is the truth.
 *
 * bufferSubData needs a typed-array view; making one per frame would allocate,
 * so views are precut at build time in VBUCKET-vertex steps and reused. */
var VBUCKET = 64, IBUCKET = 288;

function mkViews(arr, bucket){
  var v = [arr.subarray(0, 0)];         /* [0] unused: an empty batch never draws */
  for (var k = 1; ; k++){
    var e = k * bucket;
    if (e >= arr.length){ v.push(arr); break; }
    v.push(arr.subarray(0, e));
  }
  v.bucket = bucket;
  return v;
}
function pick(v, elems){
  var k = Math.ceil(elems / v.bucket);
  if (k < 1) k = 1;
  if (k >= v.length) k = v.length - 1;
  return v[k];
}

function drawDynamic(h, model, opts){
  var ni = h.ni, n = h.n;
  /* CLAMP, never overrun. A producer that writes more primitives than its batch
     was sized for has already had its surplus vertices silently swallowed by the
     Float32Array (typed-array stores past the end are dropped, not memory
     corruption) — but drawElements with a count past the index buffer is
     INVALID_OPERATION, which drops the WHOLE batch and spams the error log every
     frame. Clamping degrades to "you get the first maxI/3 triangles" instead,
     and stats.clamped makes the drift visible in the profiler. */
  if (ni > h.maxI){ ni = h.maxI; GL.stats.clamped++; }
  if (n > h.max) n = h.max;
  if (ni <= 0) return;                      /* empty batch: not a single GL call */
  applyState(model, opts);                  /* batches pass null: world space */
  if (h !== curBind) bindUnit(h);           /* leaves both of h's buffers bound */
  else gl.bindBuffer(gl.ARRAY_BUFFER, h.vb);          /* rebind for the upload */
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, pick(h.vv, n * VFLOATS));
  if (!h.staticIdx)                         /* ELEMENT buffer is already bound */
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, pick(h.vi, ni));
  gl.drawElements(gl.TRIANGLES, ni, gl.UNSIGNED_SHORT, 0);
}

/* ---- CPU geometry builders ---- */
var Geo = JK.Geo = {
  box: function(sx, sy, sz, r, g, b){
    var x = sx/2, y = sy/2, z = sz/2;
    var P = [], N = [], C = [], I = [];
    var faces = [
      [[ 1,0,0],[[ x,-y,-z],[ x, y,-z],[ x, y, z],[ x,-y, z]]],
      [[-1,0,0],[[-x,-y, z],[-x, y, z],[-x, y,-z],[-x,-y,-z]]],
      [[0, 1,0],[[-x, y,-z],[-x, y, z],[ x, y, z],[ x, y,-z]]],
      [[0,-1,0],[[-x,-y, z],[-x,-y,-z],[ x,-y,-z],[ x,-y, z]]],
      [[0,0, 1],[[-x,-y, z],[ x,-y, z],[ x, y, z],[-x, y, z]]],
      [[0,0,-1],[[ x,-y,-z],[-x,-y,-z],[-x, y,-z],[ x, y,-z]]]
    ];
    for (var f = 0; f < 6; f++){
      var n = faces[f][0], vs = faces[f][1], base = P.length/3;
      for (var v = 0; v < 4; v++){
        P.push(vs[v][0], vs[v][1], vs[v][2]);
        N.push(n[0], n[1], n[2]);
        C.push(r, g, b);
      }
      I.push(base, base+1, base+2, base, base+2, base+3);
    }
    return { pos:new Float32Array(P), nrm:new Float32Array(N),
             col:new Float32Array(C), idx:new Uint16Array(I) };
  },

  tf: function(geo, m){
    var n = geo.pos.length/3;
    var pos = new Float32Array(geo.pos.length), nrm = new Float32Array(geo.nrm.length);
    var p = [0,0,0];
    for (var i = 0; i < n; i++){
      M.xp(p, m, geo.pos[i*3], geo.pos[i*3+1], geo.pos[i*3+2]);
      pos[i*3]=p[0]; pos[i*3+1]=p[1]; pos[i*3+2]=p[2];
      M.xd(p, m, geo.nrm[i*3], geo.nrm[i*3+1], geo.nrm[i*3+2]);
      var l = Math.sqrt(p[0]*p[0]+p[1]*p[1]+p[2]*p[2]) || 1;
      nrm[i*3]=p[0]/l; nrm[i*3+1]=p[1]/l; nrm[i*3+2]=p[2]/l;
    }
    return { pos:pos, nrm:nrm, col:new Float32Array(geo.col), idx:new Uint16Array(geo.idx) };
  },

  merge: function(list){
    var vTot = 0, iTot = 0, i, g;
    for (i = 0; i < list.length; i++){ vTot += list[i].pos.length/3; iTot += list[i].idx.length; }
    if (vTot > 65535) throw new Error('Geo.merge: ' + vTot + ' verts > 65535');
    var pos = new Float32Array(vTot*3), nrm = new Float32Array(vTot*3),
        col = new Float32Array(vTot*3), idx = new Uint16Array(iTot);
    var vo = 0, io = 0;
    for (i = 0; i < list.length; i++){
      g = list[i];
      pos.set(g.pos, vo*3); nrm.set(g.nrm, vo*3); col.set(g.col, vo*3);
      for (var j = 0; j < g.idx.length; j++) idx[io+j] = g.idx[j] + vo;
      vo += g.pos.length/3; io += g.idx.length;
    }
    return { pos:pos, nrm:nrm, col:col, idx:idx };
  }
};
})();
