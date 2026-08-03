/* Capture a gameplay scene: find the nearest bot, look at it, screenshot. */
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
  // teleport near a bot and aim at it
  var info=await p.evaluate(function(){
    var best=null,bd=1e9,P=JK.Player;
    var L=(JK.Bots&&JK.Bots.list)||[];
    for(var i=0;i<L.length;i++){var e=L[i]; if(!e||!e.pos) continue;
      var d=Math.hypot(e.pos[0]-P.pos[0],e.pos[2]-P.pos[2]); if(d<bd){bd=d;best=e;}}
    if(!best) return {none:true, bots:L.length};
    var dx=best.pos[0]-P.pos[0], dz=best.pos[2]-P.pos[2], l=Math.hypot(dx,dz)||1;
    P.pos[0]=best.pos[0]-dx/l*7; P.pos[2]=best.pos[2]-dz/l*7;
    P.pos[1]=JK.Terrain.height(P.pos[0],P.pos[2]);
    P.camYaw=Math.atan2(-dx,-dz); P.yaw=P.camYaw;
    return {bots:L.length, kind:best.kind||best.type||'?', dist:+bd.toFixed(1)};
  });
  await p.waitForTimeout(2500);
  await p.screenshot({path:path.join(outdir,'bots.png')});
  var st=await p.evaluate(function(){
    return { bots:(JK.Bots&&JK.Bots.list||[]).length,
             bolts:(JK.Blaster&&JK.Blaster.count)?JK.Blaster.count():-1,
             hp:JK.game.hp, force:JK.game.force,
             forceTag:document.getElementById('forceTag').textContent };
  });
  console.log(JSON.stringify({info:info,state:st,errors:errs.slice(0,5)},null,2));
  await b.close();
})().catch(function(e){console.error('FAIL '+e.message);process.exit(2);});
