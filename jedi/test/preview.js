#!/usr/bin/env node
/* Build a standalone playable HTML to an ARBITRARY path, so an agent can render
 * and iterate without racing the shared jedi/index.html.
 *
 *   node jedi/test/preview.js /tmp/.../mypreview.html
 */
var fs = require('fs'), path = require('path');
var dir = path.join(__dirname, '..'), srcDir = path.join(dir, 'src');
var out = process.argv[2];
if (!out){ console.error('usage: node jedi/test/preview.js <out.html>'); process.exit(1); }
var files = fs.readdirSync(srcDir).filter(function(f){ return /\.js$/.test(f); }).sort();
var js = files.map(function(f){
  return '/* ===== ' + f + ' ===== */\n' + fs.readFileSync(path.join(srcDir, f), 'utf8');
}).join('\n');
if (/<\/script/i.test(js)){ console.error('FATAL: source contains </script'); process.exit(1); }
var tpl = fs.readFileSync(path.join(dir, 'template.html'), 'utf8');
fs.writeFileSync(out, tpl.replace('/*INJECT*/', function(){ return js; }));
console.log('preview -> ' + out + '  (' + files.length + ' modules)');
