/* JK.Terrain — STUB, replaced by terrain agent. */
(function(){
'use strict';
var mesh = null;
JK.Terrain = {
  SIZE: 200,
  height: function(x, z){ return 0; },
  init: function(){
    var g = JK.Geo.box(400, 1, 400, 0.80, 0.66, 0.44);
    var m = JK.M.make(); JK.M.tr(m, 0, -0.5, 0);
    mesh = JK.GL.mesh(JK.Geo.tf(g, m));
    JK.GL.fog([0.86, 0.72, 0.52], 0.0035);
    JK.GL.sun([0.45, 0.75, 0.35], [1.0, 0.93, 0.78], [0.38, 0.34, 0.30]);
  },
  draw: function(){ JK.GL.draw(mesh, null); }
};
})();
