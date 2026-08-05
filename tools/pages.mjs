/* Assemble the static site for GitHub Pages into dist/.
 *
 * The shipped index.html resolves three through an import map pointing at
 * /node_modules/three/build/three.module.js. That is right for local
 * development and for the ~240 tools in this directory, and wrong for Pages
 * twice over: node_modules is not in the repository, and a leading slash
 * resolves to the domain root while a project site is served from /redrock/.
 *
 * So the rewrite happens here rather than in the source file. index.html stays
 * exactly as every tool expects to find it, and the deployed copy gets a
 * relative specifier that works at any base path.
 */
import { readFile, writeFile, mkdir, rm, cp, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const THREE_SRC = join(root, 'node_modules', 'three', 'build', 'three.module.js');
const IMPORT_MAP = '"three": "/node_modules/three/build/three.module.js"';
const REWRITTEN = '"three": "./vendor/three.module.js"';

/* Social card metadata, injected here rather than into index.html so the file
   the capture suite photographs is never touched by a hosting concern. */
const SITE = 'https://starknightt.github.io/redrock/';

/* Scrapers do not resolve relative image URLs, so og:image has to be absolute
   even though everything else on the page is deliberately relative. */
const META = `<meta name="description" content="A cel-shaded downhill racing game built in Three.js. Every mesh, texture and sound is generated procedurally in code — no external assets.">
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE}">
<meta property="og:title" content="redrock — procedural cel-shaded downhill racing">
<meta property="og:description" content="A coastal mountain descent against three rivals. No models, no textures, no audio files: the entire world is generated in code at load time.">
<meta property="og:image" content="${SITE}social.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="redrock — procedural cel-shaded downhill racing">
<meta name="twitter:description" content="A coastal mountain descent against three rivals. Every asset generated in code at load time.">
<meta name="twitter:image" content="${SITE}social.png">
`;

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function main() {
  if (!await exists(THREE_SRC)) {
    console.error(`  ✗ three not found at ${THREE_SRC} — run npm ci first`);
    process.exit(1);
  }

  await rm(dist, { recursive: true, force: true });
  await mkdir(join(dist, 'vendor'), { recursive: true });

  let html = await readFile(join(root, 'index.html'), 'utf8');

  /* Fail loud rather than deploying a page that cannot resolve three. If the
     import map is ever reworded, this stops the release instead of shipping a
     blank canvas that only shows up as a console error in someone's browser. */
  if (!html.includes(IMPORT_MAP)) {
    console.error('  ✗ the import map in index.html does not match what this script rewrites.');
    console.error(`    looking for: ${IMPORT_MAP}`);
    console.error('    update tools/pages.mjs to match before deploying.');
    process.exit(1);
  }
  html = html.replace(IMPORT_MAP, REWRITTEN);

  if (!html.includes('</head>')) {
    console.error('  ✗ no </head> in index.html — cannot inject social metadata');
    process.exit(1);
  }
  html = html.replace('</head>', `${META}</head>`);

  await writeFile(join(dist, 'index.html'), html);
  await cp(join(root, 'src'), join(dist, 'src'), { recursive: true });
  await cp(THREE_SRC, join(dist, 'vendor', 'three.module.js'));

  /* The link-preview card. Fail rather than deploy a page whose og:image is a
     404, which renders as a broken card everywhere it is shared. */
  const card = join(root, 'social.png');
  if (!await exists(card)) {
    console.error('  ✗ social.png is missing — og:image would 404');
    process.exit(1);
  }
  await cp(card, join(dist, 'social.png'));

  /* Pages runs Jekyll by default, which drops files and folders beginning with
     an underscore. Nothing here starts with one today, but a future source file
     that did would vanish silently. */
  await writeFile(join(dist, '.nojekyll'), '');

  console.log('  ✓ dist/ assembled — index.html, src/, vendor/three.module.js');
}

main();
