/* JK.M — column-major mat4 + vec3 helpers. Owner: core. */
var JK = window.JK = window.JK || {};
(function(){
'use strict';
var TMP = new Float32Array(16);

function make(){ var m = new Float32Array(16); m[0]=m[5]=m[10]=m[15]=1; return m; }
function ident(m){ for(var i=0;i<16;i++) m[i]=0; m[0]=m[5]=m[10]=m[15]=1; return m; }
function copy(o,a){ o.set(a); return o; }

/* o = a * b  (safe if o aliases a or b) */
function mul(o,a,b){
  for(var c=0;c<4;c++){
    var b0=b[c*4],b1=b[c*4+1],b2=b[c*4+2],b3=b[c*4+3];
    TMP[c*4]  =a[0]*b0+a[4]*b1+a[8]*b2 +a[12]*b3;
    TMP[c*4+1]=a[1]*b0+a[5]*b1+a[9]*b2 +a[13]*b3;
    TMP[c*4+2]=a[2]*b0+a[6]*b1+a[10]*b2+a[14]*b3;
    TMP[c*4+3]=a[3]*b0+a[7]*b1+a[11]*b2+a[15]*b3;
  }
  o.set(TMP); return o;
}

/* in-place post-multiply composers: m = m * X. Natural for parent->child builds. */
var B = make();
function tr(m,x,y,z){ ident(B); B[12]=x; B[13]=y; B[14]=z; return mul(m,m,B); }
function sc(m,x,y,z){ ident(B); B[0]=x; B[5]=y; B[10]=z; return mul(m,m,B); }
function rx(m,a){ var c=Math.cos(a),s=Math.sin(a); ident(B); B[5]=c; B[6]=s; B[9]=-s; B[10]=c; return mul(m,m,B); }
function ry(m,a){ var c=Math.cos(a),s=Math.sin(a); ident(B); B[0]=c; B[2]=-s; B[8]=s; B[10]=c; return mul(m,m,B); }
function rz(m,a){ var c=Math.cos(a),s=Math.sin(a); ident(B); B[0]=c; B[1]=s; B[4]=-s; B[5]=c; return mul(m,m,B); }

function persp(o,fovy,aspect,near,far){
  var f=1/Math.tan(fovy/2), nf=1/(near-far);
  o[0]=f/aspect; o[1]=0; o[2]=0; o[3]=0;
  o[4]=0; o[5]=f; o[6]=0; o[7]=0;
  o[8]=0; o[9]=0; o[10]=(far+near)*nf; o[11]=-1;
  o[12]=0; o[13]=0; o[14]=2*far*near*nf; o[15]=0;
  return o;
}

function lookAt(o,eye,ctr,up){
  var zx=eye[0]-ctr[0], zy=eye[1]-ctr[1], zz=eye[2]-ctr[2];
  var l=1/(Math.sqrt(zx*zx+zy*zy+zz*zz)||1); zx*=l; zy*=l; zz*=l;
  var xx=up[1]*zz-up[2]*zy, xy=up[2]*zx-up[0]*zz, xz=up[0]*zy-up[1]*zx;
  l=1/(Math.sqrt(xx*xx+xy*xy+xz*xz)||1); xx*=l; xy*=l; xz*=l;
  var yx=zy*xz-zz*xy, yy=zz*xx-zx*xz, yz=zx*xy-zy*xx;
  o[0]=xx; o[1]=yx; o[2]=zx; o[3]=0;
  o[4]=xy; o[5]=yy; o[6]=zy; o[7]=0;
  o[8]=xz; o[9]=yz; o[10]=zz; o[11]=0;
  o[12]=-(xx*eye[0]+xy*eye[1]+xz*eye[2]);
  o[13]=-(yx*eye[0]+yy*eye[1]+yz*eye[2]);
  o[14]=-(zx*eye[0]+zy*eye[1]+zz*eye[2]);
  o[15]=1;
  return o;
}

/* transform point [x,y,z,1] by m -> out3 */
function xp(o,m,x,y,z){
  o[0]=m[0]*x+m[4]*y+m[8]*z+m[12];
  o[1]=m[1]*x+m[5]*y+m[9]*z+m[13];
  o[2]=m[2]*x+m[6]*y+m[10]*z+m[14];
  return o;
}
/* transform direction (no translation) */
function xd(o,m,x,y,z){
  o[0]=m[0]*x+m[4]*y+m[8]*z;
  o[1]=m[1]*x+m[5]*y+m[9]*z;
  o[2]=m[2]*x+m[6]*y+m[10]*z;
  return o;
}

JK.M = { make:make, ident:ident, copy:copy, mul:mul, tr:tr, sc:sc, rx:rx, ry:ry, rz:rz,
  persp:persp, lookAt:lookAt, xp:xp, xd:xd };

JK.V = {
  set:function(o,x,y,z){ o[0]=x; o[1]=y; o[2]=z; return o; },
  copy:function(o,a){ o[0]=a[0]; o[1]=a[1]; o[2]=a[2]; return o; },
  add:function(o,a,b){ o[0]=a[0]+b[0]; o[1]=a[1]+b[1]; o[2]=a[2]+b[2]; return o; },
  sub:function(o,a,b){ o[0]=a[0]-b[0]; o[1]=a[1]-b[1]; o[2]=a[2]-b[2]; return o; },
  scale:function(o,a,s){ o[0]=a[0]*s; o[1]=a[1]*s; o[2]=a[2]*s; return o; },
  dot:function(a,b){ return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; },
  cross:function(o,a,b){ var x=a[1]*b[2]-a[2]*b[1], y=a[2]*b[0]-a[0]*b[2], z=a[0]*b[1]-a[1]*b[0];
    o[0]=x; o[1]=y; o[2]=z; return o; },
  len:function(a){ return Math.sqrt(a[0]*a[0]+a[1]*a[1]+a[2]*a[2]); },
  norm:function(o,a){ var l=Math.sqrt(a[0]*a[0]+a[1]*a[1]+a[2]*a[2])||1;
    o[0]=a[0]/l; o[1]=a[1]/l; o[2]=a[2]/l; return o; },
  lerp:function(o,a,b,t){ o[0]=a[0]+(b[0]-a[0])*t; o[1]=a[1]+(b[1]-a[1])*t; o[2]=a[2]+(b[2]-a[2])*t; return o; },
  dist:function(a,b){ var x=a[0]-b[0],y=a[1]-b[1],z=a[2]-b[2]; return Math.sqrt(x*x+y*y+z*z); }
};
})();
