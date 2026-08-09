import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetRoot = path.join(root, 'assets');

const palette = ['#F4F0E3', '#111111', '#1457FF', '#FF4B35', '#FFD83D', '#63E2B7'];
const legacyFlow = /(?:LOOP\s*\/\s*LEDGER|Strange loops\. Open ledgers\.|profile-loop-card\.svg|AI Usage Chronicle)/i;
const metadataEvidence = [
  'Independent design attempts; no ancestry or sequential replacement claim',
  '5E8F667 = 5e8f66756afc9b483beb0070524ac4cc4d7f3856',
  'B9EF619 = b9ef61997260c359005aa175a62dcb370c2007e8',
  '520E83F = 520e83f32ed20efc0beb64982b1db45c7600db9e',
  'src/rendering/BeijingDriveScene.ts',
  '7d4b0bf9876fdaa7b303ba40b4075170a73b4a6c',
  'buildOlympic',
  'buildSecondRingThreshold',
  'BrickerP/ai-usage-report',
  '/Users/yupeng/Projects/ai-usage-report',
  '6bae0fa23492ece45ae49ad57093d4f003883215',
  'external to the film repository',
];

const assets = [
  {
    file: 'human-zine-cover.svg',
    width: 1200,
    height: 630,
    alt: 'Yupeng Lu. Field Notes, Issue 00. Things I keep returning to.',
    text: ['YUPENG LU', 'FIELD NOTES · ISSUE 00', 'THINGS I KEEP RETURNING TO'],
  },
  {
    file: 'human-zine-film.svg',
    width: 1200,
    height: 720,
    alt: 'Endless Second Ring, a 48-second Beijing night drive. Open the film.',
    text: ['ENDLESS SECOND RING', 'A 48-SECOND BEIJING NIGHT DRIVE.', 'ENTER FILM ↗'],
  },
  {
    file: 'human-zine-ai-usage.svg',
    width: 1200,
    height: 720,
    alt: 'AI Usage, real model history made playable. Open the archive.',
    text: ['AI USAGE', 'REAL MODEL HISTORY, MADE PLAYABLE.', 'PLAY ARCHIVE ↗'],
  },
  {
    file: 'human-zine-process.svg',
    width: 1200,
    height: 720,
    alt: 'Three independent film design attempts ask what belongs in one scene, beside two attributed rules: film is artistic composition, not navigation; game history pattern is not model capability.',
    text: [
      'THREE ATTEMPTS. ONE QUESTION: WHAT BELONGS HERE?',
      'FROM THE FILM',
      '5E8F667 /',
      'RECOGNIZABLE',
      'LANDMARKS',
      'B9EF619 /',
      'CLEAR THE',
      'FORECOURT',
      '520E83F /',
      'REPLACE THE',
      'OLYMPIC SCENE',
      'FILM RULE',
      'ARTISTIC COMPOSITION. NOT FOR NAVIGATION.',
      'GAME RULE',
      'HISTORY PATTERN. NOT MODEL CAPABILITY.',
    ],
  },
  {
    file: 'human-zine-open-line.svg',
    width: 1200,
    height: 360,
    alt: 'Open a line to email Yupeng Lu.',
    text: ['OPEN A LINE'],
  },
];

const expectedReadme = `<img src="assets/human-zine-cover.svg" width="100%" alt="${assets[0].alt}">

<a href="https://brickerp.github.io/"><img src="assets/human-zine-film.svg" width="100%" alt="${assets[1].alt}"></a>

<a href="https://brickerp.github.io/ai-usage-report/"><img src="assets/human-zine-ai-usage.svg" width="100%" alt="${assets[2].alt}"></a>

<img src="assets/human-zine-process.svg" width="100%" alt="${assets[3].alt}">

<a href="mailto:yplmicro@gmail.com"><img src="assets/human-zine-open-line.svg" width="100%" alt="${assets[4].alt}"></a>
`;

function normalizeText(value) {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function getAttribute(attributes, name) {
  return new RegExp(`\\b${name}="([^"]+)"`).exec(attributes)?.[1];
}

function textRecords(svg) {
  return [...svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)].map((match) => ({
    attributes: match[1],
    text: normalizeText(match[2]),
  }));
}

function roleValues(svg) {
  return [...svg.matchAll(/(?:^|[\t\n\r ])role\s*=\s*(["'])([^"']+)\1/g)].map((match) => match[2]);
}

assert.deepEqual(roleValues('<svg role="img"><g data-role="blue-tape"/></svg>'), ['img'], 'data-role must not be counted as role');
assert.deepEqual(roleValues('<svg role="img"><g role="button"/></svg>'), ['img', 'button'], 'true role attributes must be counted');

function countWords(value) {
  return value.match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g)?.length ?? 0;
}

const readme = await readFile(path.join(root, 'README.md'), 'utf8');
assert.equal(readme, expectedReadme, 'README must contain only the five ordered full-width spreads and three native image anchors');
assert.doesNotMatch(readme, legacyFlow, 'README must not retain the superseded LOOP / LEDGER flow');

const expectedAnchors = [
  {
    href: 'https://brickerp.github.io/',
    src: 'assets/human-zine-film.svg',
    alt: assets[1].alt,
  },
  {
    href: 'https://brickerp.github.io/ai-usage-report/',
    src: 'assets/human-zine-ai-usage.svg',
    alt: assets[2].alt,
  },
  {
    href: 'mailto:yplmicro@gmail.com',
    src: 'assets/human-zine-open-line.svg',
    alt: assets[4].alt,
  },
];
const readmeAnchors = [...readme.matchAll(/<a href="([^"]+)"><img src="([^"]+)" width="100%" alt="([^"]+)"><\/a>/g)].map((match) => ({
  href: match[1],
  src: match[2],
  alt: match[3],
}));
assert.deepEqual(readmeAnchors, expectedAnchors, 'README must expose exactly the approved Film, AI Usage, and Open Line image anchors');
assert.equal((readme.match(/<a\b/g) ?? []).length, expectedAnchors.length, 'README must not contain extra anchors');
assert.doesNotMatch(readme, /^\s*\[[^\]]+\]\([^)]+\).*$/m, 'README must not retain bare markdown text-link rows');
assert.doesNotMatch(readme, /(?:WATCH FILM|PLAY ARCHIVE|EMAIL YUPENG|RESUME|GITHUB)\s*(?:→|↗)/i, 'README must not retain superseded text-link labels');

const assetNames = (await readdir(assetRoot)).sort();
assert.deepEqual(assetNames, assets.map(({ file }) => file).sort(), 'assets must contain exactly the five approved Human Zine spreads');

const svgs = new Map();
const visibleCopy = [];
const usedPalette = new Set();
for (const asset of assets) {
  const svg = await readFile(path.join(assetRoot, asset.file), 'utf8');
  svgs.set(asset.file, svg);
  assert.doesNotMatch(svg, legacyFlow, `${asset.file}: superseded LOOP / LEDGER flow is forbidden`);

  const rootTag = svg.match(/^<svg\b([^>]*)>/)?.[1];
  assert.ok(rootTag, `${asset.file}: missing root svg element`);
  assert.equal(getAttribute(rootTag, 'width'), String(asset.width), `${asset.file}: incorrect width`);
  assert.equal(getAttribute(rootTag, 'height'), String(asset.height), `${asset.file}: incorrect height`);
  assert.equal(getAttribute(rootTag, 'viewBox'), `0 0 ${asset.width} ${asset.height}`, `${asset.file}: incorrect viewBox`);
  assert.equal((svg.match(/<title\b/g) ?? []).length, 1, `${asset.file}: expected one title`);
  assert.equal((svg.match(/<desc\b/g) ?? []).length, 1, `${asset.file}: expected one description`);

  const records = textRecords(svg);
  const assetCopy = records.map(({ text }) => text);
  assert.deepEqual(assetCopy, asset.text, `${asset.file}: visible copy must remain exact and complete`);
  visibleCopy.push(...assetCopy);
  assert.doesNotMatch(svg, /<tspan\b[^>]*\bfont-size=/i, `${asset.file}: nested text must not override the verified source size`);
  for (const record of records) {
    const fontSize = Number(getAttribute(record.attributes, 'font-size'));
    const isReceiptIdentifier = /^(?:5E8F667|B9EF619|520E83F) \/$/.test(record.text);
    if (isReceiptIdentifier) {
      assert.equal(fontSize, 54, `${asset.file}: ${record.text} must use exactly 54px source text`);
    } else {
      assert.ok(Number.isFinite(fontSize) && fontSize >= 60, `${asset.file}: ${record.text} must use at least 60px source text`);
    }
  }

  const metadata = normalizeText(svg.match(/<metadata>([\s\S]*?)<\/metadata>/)?.[1] ?? '');
  assert.ok(metadata, `${asset.file}: missing nonvisible source metadata`);
  for (const evidence of metadataEvidence) {
    assert.ok(metadata.includes(evidence), `${asset.file}: metadata must include ${evidence}`);
  }

  const colors = [...svg.matchAll(/#[0-9A-Fa-f]{6}\b/g)].map((match) => match[0].toUpperCase());
  assert.ok(colors.includes('#F4F0E3') && colors.includes('#111111'), `${asset.file}: fixed paper and ink are required`);
  for (const color of colors) {
    assert.ok(palette.includes(color), `${asset.file}: unapproved color ${color}`);
    usedPalette.add(color);
  }
  assert.doesNotMatch(svg, /\b(?:rgb|rgba|hsl|hsla)\s*\(|currentColor/i, `${asset.file}: colors must use only the fixed hex palette`);

  const releasePaint = svg.slice(svg.indexOf('</defs>') + '</defs>'.length).trimStart();
  assert.match(
    releasePaint,
    new RegExp(`^<rect width="${asset.width}" height="${asset.height}" fill="#F4F0E3"\\/>`),
    `${asset.file}: first release-facing paint must be an opaque full-viewBox paper field`,
  );

  assert.match(svg, /<pattern\b[^>]*\bid="[^"]*grain"/, `${asset.file}: missing tactile grain`);
  assert.doesNotMatch(
    svg,
    /<(?:a|script|style|image|foreignObject|animate|animateMotion|animateTransform|set|iframe|video|audio|canvas|button|use)\b/i,
    `${asset.file}: interactive, embedded, or dynamic elements are forbidden`,
  );
  assert.doesNotMatch(svg, /\b(?:href|xlink:href|on[a-z]+|pointer-events|cursor)\s*=/i, `${asset.file}: links, event handlers, and hit zones are forbidden`);
  assert.doesNotMatch(svg, /\btabindex\s*=|\bfocusable\s*=\s*["']?true\b/i, `${asset.file}: focusable SVG content is forbidden`);
  assert.doesNotMatch(
    svg,
    /\brole\s*=\s*["'](?:application|button|checkbox|combobox|grid|gridcell|link|listbox|menu|menuitem|option|radio|scrollbar|searchbox|slider|spinbutton|switch|tab|textbox|tree|treeitem)\b/i,
    `${asset.file}: interactive role values are forbidden`,
  );
  assert.deepEqual(roleValues(svg), ['img'], `${asset.file}: only the root img role is allowed`);
  assert.doesNotMatch(svg, /@(?:import|font-face|media)|prefers-color-scheme|animation\s*:|transition\s*:/i, `${asset.file}: remote fonts, theme branches, and motion are forbidden`);
  assert.doesNotMatch(svg.replace('xmlns="http://www.w3.org/2000/svg"', ''), /https?:\/\//i, `${asset.file}: remote resources are forbidden`);
  for (const match of svg.matchAll(/url\(([^)]+)\)/g)) {
    assert.match(match[1], /^#[A-Za-z][\w.-]*$/, `${asset.file}: only local paint references are allowed`);
  }
}

for (const color of palette) assert.ok(usedPalette.has(color), `Human Zine set is missing approved palette color ${color}`);

const nativeLinkLabels = [...readme.matchAll(/\[([^\]]+)\]\([^)]+\)/g)].map((match) => match[1]);
assert.ok(countWords([...visibleCopy, ...nativeLinkLabels].join(' ')) <= 85, 'Human Zine visible copy must stay within the 85-word budget');

const cover = svgs.get('human-zine-cover.svg');
assert.match(cover, /data-role="crop-marks"/, 'cover must retain crop marks');
assert.match(cover, /data-role="blue-tape"/, 'cover must retain the cobalt tape fragment');
assert.match(cover, /data-role="halftone-wedge"/, 'cover must retain the torn halftone wedge');
assert.match(cover, /<g\b[^>]*data-role="misregistered-circle"[\s\S]*?<ellipse\b[^>]*stroke="#FF4B35"/, 'cover must retain the misregistered signal-red editorial circle');
assert.equal([...svgs.values()].reduce((count, svg) => count + (svg.match(/data-role="misregistered-circle"/g) ?? []).length, 0), 1, 'the signature editorial circle must appear only once in the Human Zine');

const film = svgs.get('human-zine-film.svg');
assert.match(film, /data-role="film-collage"/, 'film spread must retain the vector night-drive collage');
assert.match(film, /data-role="rear-car"/, 'film spread must retain the rear car and tail-light composition');
assert.doesNotMatch(film, /data-role="(?:data-terrain|archive-cubes|bar|bar-chart|chart)"/, 'film spread must remain a distinct night-drive composition');
for (const record of textRecords(film)) {
  const fontSize = Number(getAttribute(record.attributes, 'font-size'));
  assert.ok(Number.isFinite(fontSize) && fontSize >= 60, `human-zine-film.svg: title, caption, or CTA ${record.text} must use at least 60px source text`);
}
assert.equal(visibleCopy.filter((text) => text === 'ENTER FILM ↗').length, 1, 'ENTER FILM CTA must appear exactly once, on the Film spread');

const aiUsage = svgs.get('human-zine-ai-usage.svg');
assert.match(aiUsage, /data-role="data-terrain"/, 'AI Usage spread must retain the pixel/data terrain');
assert.match(aiUsage, /data-role="archive-cubes"/, 'AI Usage spread must retain the isometric archive cubes');
assert.doesNotMatch(aiUsage, /data-role="(?:film-collage|rear-car|bar|bar-chart|chart)"/, 'AI Usage spread must remain a distinct archive composition');
for (const record of textRecords(aiUsage)) {
  const fontSize = Number(getAttribute(record.attributes, 'font-size'));
  assert.ok(Number.isFinite(fontSize) && fontSize >= 60, `human-zine-ai-usage.svg: title, caption, or CTA ${record.text} must use at least 60px source text`);
}
assert.equal(visibleCopy.filter((text) => text === 'AI USAGE').length, 1, 'AI USAGE must appear exactly once, on the AI Usage spread');
assert.equal(visibleCopy.filter((text) => text === 'PLAY ARCHIVE ↗').length, 1, 'PLAY ARCHIVE CTA must appear exactly once, on the AI Usage spread');

const process = svgs.get('human-zine-process.svg');
const processCopy = textRecords(process).map(({ text }) => text);
assert.ok(!processCopy.includes('AI USAGE'), 'human-zine-process.svg: unapproved AI USAGE copy is forbidden');
assert.equal((process.match(/data-role="receipt"/g) ?? []).length, 3, 'process spread must contain three separate receipt fragments');
assert.equal((process.match(/data-role="rule-card"/g) ?? []).length, 2, 'process spread must contain two separate attributed rule cards');
assert.doesNotMatch(
  processCopy.join(' '),
  /\b(?:BEFORE|AFTER|DIFF|INSERTIONS?|DELETIONS?|ANCESTOR)\b/i,
  'process spread must not present a fake diff or ancestry story',
);

const openLine = svgs.get('human-zine-open-line.svg');
assert.match(openLine, /data-role="blue-brush-tape"/, 'open-line spread must retain the restrained upper-right cobalt brush/tape block');

console.log('Human Zine profile contract verified.');
