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
/* Redundant-state cache. Every draw used to re-bind 4 buffers, re-issue 3
   vertexAttribPointers and re-upload 4 uniforms even when nothing had changed —
   and a particle burst issues 150+ consecutive draws of the SAME unit cube with
   the SAME options. Measured in busy combat: 2053 GL calls/frame. iOS Safari
   marshals every one of those across a process boundary, so this is the single
   biggest GPU-side cost in the game. Nothing outside this module touches GL
   state (verified), so caching is safe; mesh() invalidates the binding. */
var curMesh = null;
var uEm = -1, uAl = -1, uNf = -1, uTr = -1, uTg = -1, uTb = -1;

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

  fog: function(col, den){ fogCol.set(col); fogDen = den; },
  sun: function(dir, col, ambient){
    var l = Math.sqrt(dir[0]*dir[0]+dir[1]*dir[1]+dir[2]*dir[2]) || 1;
    sunDir[0]=dir[0]/l; sunDir[1]=dir[1]/l; sunDir[2]=dir[2]/l;
    sunCol.set(col); amb.set(ambient);
  },

  beginFrame: function(r, g, b){
    var w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h){ canvas.width = w; canvas.height = h; }
    GL.w = w; GL.h = h; GL.aspect = w / (h || 1);
    gl.viewport(0, 0, w, h);
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniform3fv(loc.uSunDir, sunDir);
    gl.uniform3fv(loc.uSunCol, sunCol);
    gl.uniform3fv(loc.uAmb, amb);
    gl.uniform3fv(loc.uFogCol, fogCol);
    gl.uniform1f(loc.uFogDen, fogDen);
  },

  setCamera: function(eye, target, fovDeg){
    GL.eye[0]=eye[0]; GL.eye[1]=eye[1]; GL.eye[2]=eye[2];
    M.persp(proj, (fovDeg||70) * Math.PI/180, GL.aspect, 0.1, 2000);
    M.lookAt(view, eye, target, [0,1,0]);
    gl.uniformMatrix4fv(loc.uProj, false, proj);
    gl.uniformMatrix4fv(loc.uView, false, view);
  },

  /* geo: {pos,nrm,col:Float32Array, idx:Uint16Array} */
  mesh: function(geo){
    function buf(target, data){
      var b = gl.createBuffer(); gl.bindBuffer(target, b);
      gl.bufferData(target, data, gl.STATIC_DRAW); return b;
    }
    var m = {
      p: buf(gl.ARRAY_BUFFER, geo.pos),
      n: buf(gl.ARRAY_BUFFER, geo.nrm),
      c: buf(gl.ARRAY_BUFFER, geo.col),
      i: buf(gl.ELEMENT_ARRAY_BUFFER, geo.idx),
      count: geo.idx.length
    };
    curMesh = null;               /* creating buffers left them bound: invalidate */
    return m;
  },

  draw: function(mesh, model, opts){
    opts = opts || {};
    gl.uniformMatrix4fv(loc.uModel, false, model || IDENT);
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
    if (mesh !== curMesh){
      curMesh = mesh;
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.p); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.n); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.c); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.i);
    }
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
  }
};

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
