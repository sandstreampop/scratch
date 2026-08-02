/* JK.Player — STUB, replaced by player agent. */
(function(){
'use strict';
JK.Player = {
  pos: [0, 0, 0], yaw: 0, vel: [0, 0, 0], onGround: true, speed2D: 0, anim: 'idle',
  camEye: [0, 3, 6], camTarget: [0, 1.2, 0],
  init: function(){},
  update: function(dt, t){
    JK.GL.setCamera(this.camEye, this.camTarget, 70);
  }
};
})();
