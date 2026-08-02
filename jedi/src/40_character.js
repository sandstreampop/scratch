/* JK.Rig — STUB, replaced by character agent. */
(function(){
'use strict';
var mesh = null, mm = null;
JK.Rig = {
  init: function(){
    mesh = JK.GL.mesh(JK.Geo.box(0.6, 1.8, 0.4, 0.45, 0.35, 0.28));
    mm = JK.M.make();
  },
  draw: function(){
    var p = JK.Player.pos;
    JK.M.ident(mm); JK.M.tr(mm, p[0], p[1] + 0.9, p[2]); JK.M.ry(mm, JK.Player.yaw);
    JK.GL.draw(mesh, mm);
  }
};
})();
