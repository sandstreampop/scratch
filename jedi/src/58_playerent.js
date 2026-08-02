/* JK.Hero — registers the player as a JK.Combat entity so bots can hurt him,
 * and owns his health / knockback / death / respawn. Owner: core.
 *
 * Runs inside the 'Fx' slot's Combat pass indirectly: Combat.update() calls
 * ent.onHit(); this module only needs its own update() for regen + respawn, so
 * it is driven from 90_main's SYSTEMS list entry 'Hero'.
 *
 * Exposed:
 *   JK.Hero.ent      the registered entity (team 'player'), pos ALIASES
 *                    JK.Player.pos so it tracks the player with no copying.
 *   JK.Hero.hurt(dmg, dirX, dirY, dirZ, kind)  damage entry point for bots.
 *   JK.Hero.dead     bool
 *   JK.Hero.invuln   seconds of remaining spawn protection
 */
(function(){
'use strict';

var HP_MAX = 100;
var RESPAWN_T = 2.6;
var INVULN_T = 2.0;
var REGEN_DELAY = 6.0;      /* seconds without damage before health creeps back */
var REGEN_RATE = 4.0;       /* hp per second */

var dead = false, deadT = 0, invuln = 0, sinceHit = 99;
var ent = null, hpEl = null;
var flashT = 0;

function game(){ return JK.game || (JK.game = { hp: HP_MAX, hpMax: HP_MAX }); }

function hurt(dmg, dx, dy, dz, kind){
  var g = game();
  if (dead || invuln > 0 || !(dmg > 0)) return;
  g.hp -= dmg;
  sinceHit = 0;
  flashT = 0.22;
  /* knockback: blasters shove lightly, sabers/force shove hard */
  var k = kind === 'bolt' ? 1.6 : (kind === 'force' ? 7.0 : 4.0);
  if (JK.Player && JK.Player.impulse){
    var l = Math.sqrt((dx||0)*(dx||0) + (dz||0)*(dz||0)) || 1;
    JK.Player.impulse((dx||0)/l * k, (dy > 0 ? dy * k : 1.5), (dz||0)/l * k);
  }
  if (JK.Fx && JK.Fx.sparks && JK.Player){
    SP[0] = JK.Player.pos[0]; SP[1] = JK.Player.pos[1] + 1.1; SP[2] = JK.Player.pos[2];
    JK.Fx.sparks(SP, 8, RED);
  }
  if (g.hp <= 0){
    g.hp = 0;
    dead = true; deadT = RESPAWN_T;
    if (JK.msg) JK.msg('YOU HAVE FALLEN', 2.4);
    if (JK.Fx && JK.Fx.burst && JK.Player){
      SP[0] = JK.Player.pos[0]; SP[1] = JK.Player.pos[1] + 1.0; SP[2] = JK.Player.pos[2];
      JK.Fx.burst(SP, 26, RED);
    }
  }
}
var SP = [0, 0, 0];
var RED = [1.0, 0.25, 0.15];

function respawn(){
  var g = game();
  g.hp = g.hpMax || HP_MAX;
  if (g.forceMax) g.force = g.forceMax;
  dead = false; invuln = INVULN_T; sinceHit = 99;
  var P = JK.Player;
  if (P){
    P.pos[0] = 0; P.pos[2] = 6;
    P.pos[1] = (JK.Terrain && JK.Terrain.height) ? JK.Terrain.height(0, 6) : 0;
    P.vel[0] = P.vel[1] = P.vel[2] = 0;
    P.speedMul = 1;
  }
  if (JK.Fx && JK.Fx.shimmer && P){
    SP[0] = P.pos[0]; SP[1] = P.pos[1] + 1.0; SP[2] = P.pos[2];
    JK.Fx.shimmer(SP, 18, [0.6, 0.85, 1.0]);
  }
  if (JK.msg) JK.msg('THE FORCE SUSTAINS YOU', 1.6);
}

JK.Hero = {
  ent: null,
  dead: false,
  invuln: 0,
  hurt: hurt,

  init: function(){
    var g = game();
    g.hpMax = g.hpMax || HP_MAX;
    g.hp = g.hpMax;
    dead = false; deadT = 0; invuln = INVULN_T; sinceHit = 99; flashT = 0;
    hpEl = document.getElementById('hpFill');
    if (!JK.Player) return;
    ent = {
      pos: JK.Player.pos,            /* alias — tracks the player for free */
      radius: 0.55,
      height: 1.8,
      hp: g.hp,
      team: 'player',
      kind: 'hero',
      onHit: function(dmg, dir, kind){
        hurt(dmg, dir ? dir[0] : 0, dir ? dir[1] : 0, dir ? dir[2] : 0, kind);
        this.hp = game().hp;
      }
    };
    JK.Hero.ent = ent;
    if (JK.Combat && JK.Combat.register) JK.Combat.register(ent);
  },

  update: function(dt, t){
    var g = game();
    if (invuln > 0) invuln -= dt;
    if (flashT > 0) flashT -= dt;
    sinceHit += dt;
    if (dead){
      deadT -= dt;
      if (deadT <= 0) respawn();
    } else if (g.hp < g.hpMax && sinceHit > REGEN_DELAY){
      g.hp = Math.min(g.hpMax, g.hp + REGEN_RATE * dt);
    }
    if (ent) ent.hp = dead ? 0 : g.hp;
    JK.Hero.dead = dead;
    JK.Hero.invuln = invuln > 0 ? invuln : 0;
    /* the Ui module owns the bar width; we only tint on damage flash */
    if (hpEl){
      var want = flashT > 0 ? '#ff6a4a' : '';
      if (hpEl.style.filter !== (want ? 'brightness(1.6)' : ''))
        hpEl.style.filter = want ? 'brightness(1.6)' : '';
    }
  }
};
})();
