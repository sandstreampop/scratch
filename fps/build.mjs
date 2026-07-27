// Produces a self-contained static build in dist/.
//
// The dev tree runs straight from source with an import map, which needs
// Safari 16.4+. Bundling removes that floor, cuts the module waterfall from
// ~30 requests to one, and lets esbuild tree-shake the parts of three we never
// touch — all of which matter far more on a phone than on a desktop.

import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const dev = process.argv.includes('--dev');

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const result = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/main.js')],
  bundle: true,
  format: 'esm',
  target: ['safari16', 'chrome109', 'firefox115'],
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  outfile: path.join(DIST, 'game.js'),
  legalComments: 'none',
  metafile: true,
  alias: {
    // Mirrors the import map in index.html.
    three: path.join(ROOT, 'vendor/three/three.module.js'),
  },
  plugins: [{
    name: 'three-addons',
    setup(build) {
      build.onResolve({ filter: /^three\/addons\// }, (args) => ({
        path: path.join(ROOT, 'vendor/three/addons', args.path.replace('three/addons/', '')),
      }));
    },
  }],
});

// The shipped page is the dev page with the import map and module entry
// swapped for the bundle. Keeping one source of truth for the markup avoids
// the two drifting apart.
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .replace(/\s*<script type="importmap">[\s\S]*?<\/script>/, '')
  .replace('<script type="module" src="./src/main.js"></script>',
    '<script type="module" src="./game.js"></script>');

if (html.includes('importmap') || html.includes('./src/main.js')) {
  throw new Error('build: index.html did not rewrite cleanly — check the markers');
}
fs.writeFileSync(path.join(DIST, 'index.html'), html);

// Pages serves the artifact verbatim; without this Jekyll strips paths that
// begin with an underscore.
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');

const bytes = fs.statSync(path.join(DIST, 'game.js')).size;
const inputs = Object.keys(result.metafile.inputs).length;
console.log(`dist/game.js  ${(bytes / 1024).toFixed(0)} kB  from ${inputs} modules`);
console.log(`dist/index.html  ${(fs.statSync(path.join(DIST, 'index.html')).size / 1024).toFixed(1)} kB`);
