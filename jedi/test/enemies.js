/* Render a sith and a trooper side by side at the player's normal framing. */
var path=require('path'), fs=require('fs');
var { chromium } = require('playwright-core');
(async function(){
  var outdir=process.argv[2]; fs.mkdirSync(outdir,{recursive:true});
  var b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',
    args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
  var p=await b.newPage({viewport:{width:844,height:390},hasTouch:true,isMobile:true});
  var errs=[]; p.on('pageerror',function(e){errs.push(e.message);});
  await p.goto('file://'+path.resolve(__dirname,'..','index.html'));
  await p.tap('#begin'); await p.waitForTimeout(700);
  var info=await p.evaluate(function(){
    var P=JK.Player, L=(JK.Bots&&JK.Bots.list)||[];
    var sith=null, tr=null, kinds=[];
    for(var i=0;i<L.length;i++){ if(!L[i]) continue; kinds.push(L[i].kind);
      if(!sith && /sith|elite|lord/i.test(L[i].kind||'')) sith=L[i];
      if(!tr && /troop/i.test(L[i].kind||'')) tr=L[i]; }
    // stand them 9m out, side by side, facing us
    var base=[P.pos[0], P.pos[2]-12];
    function place(e,dx){ if(!e) return; e.pos[0]=P.pos[0]+dx; e.pos[2]=P.pos[2]-11;
      e.pos[1]=JK.Terrain.height(e.pos[0],e.pos[2]);
      if('yaw' in e) e.yaw=0; if('aimYaw' in e) e.aimYaw=0; }
    place(sith,-2.2); place(tr,2.2);
    P.camYaw=0; P.yaw=0; P.camPitch=-0.12;
    return {kinds:kinds, sith:!!sith, trooper:!!tr};
  });
  await p.waitForTimeout(1400);
  await p.screenshot({path:path.join(outdir,'enemies.png')});
  console.log(JSON.stringify({info:info,errors:errs.slice(0,3)}));
  await b.close();
})().catch(function(e){console.error('FAIL '+e.message);process.exit(2);});
