#!/usr/bin/env node
// Concatenate jedi/src/*.js (sorted) into template.html at /*INJECT*/ -> jedi/index.html
var fs = require('fs'), path = require('path');
var dir = __dirname, srcDir = path.join(dir, 'src');
var files = fs.readdirSync(srcDir).filter(function(f){ return /\.js$/.test(f); }).sort();
var parts = files.map(function(f){
  return '/* ===== ' + f + ' ===== */\n' + fs.readFileSync(path.join(srcDir, f), 'utf8');
});
var js = parts.join('\n');
if (/<\/script/i.test(js)) { console.error('FATAL: source contains </script'); process.exit(1); }
var tpl = fs.readFileSync(path.join(dir, 'template.html'), 'utf8');
var marker = '/*INJECT*/';
if (tpl.indexOf(marker) < 0) { console.error('FATAL: no INJECT marker'); process.exit(1); }
var out = tpl.replace(marker, function(){ return js; });
fs.writeFileSync(path.join(dir, 'index.html'), out);
console.log('built jedi/index.html  (' + (out.length/1024).toFixed(1) + ' KB) from:\n  ' + files.join('\n  '));
