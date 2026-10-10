import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetRoot = path.join(root, 'assets');

const palette = ['#F4F0E3', '#111111', '#1457FF', '#FF4B35', '#FFD83D', '#63E2B7'];
const legacyFlow = /(?:LOOP\s*\/\s*LEDGER|Strange loops\. Open ledgers\.|profile-loop-card\.svg|AI Usage Chronicle)/i;
const legacyMetadataEvidence = [
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

const coreAssets = [
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

const memoryAsset = {
  file: 'human-zine-memory.svg',
  width: 1200,
  height: 900,
};
const assets = [...coreAssets, memoryAsset];

// The one live spread: an SVG rendered on request by projects/profile-cards.
// It is the literal form of experiment 001, so it links to it and sits below
// the text, right after the zine cover.
const liveCard = {
  href: 'experiments/001-a-profile-with-memory/README.md',
  src: 'https://profile-cards.brickerp.workers.dev/card.svg',
  alt: 'Live status card rendered at the edge by a Cloudflare Worker: last fill, scan p95, heartbeat, and latest commit. Enter experiment 001, A Profile With Memory.',
};
const liveCardLine = `<a href="${liveCard.href}"><img src="${liveCard.src}" width="100%" alt="${liveCard.alt}"></a>`;

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

function imageAnchors(markdown) {
  return [...markdown.matchAll(/<a href="([^"]+)"><img src="([^"]+)" width="100%" alt="([^"]+)"><\/a>/g)].map((match) => ({
    href: match[1],
    src: match[2],
    alt: match[3],
  }));
}

async function readLocalReference(base, reference) {
  const resolved = path.resolve(base, reference);
  assert.ok(resolved.startsWith(`${root}${path.sep}`), `local reference must remain inside the repository: ${reference}`);
  return readFile(resolved, 'utf8');
}

async function listRelativePaths(directory, prefix = '') {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    results.push(relative);
    if (entry.isDirectory()) results.push(...await listRelativePaths(path.join(directory, entry.name), relative));
  }
  return results;
}

const readme = await readFile(path.join(root, 'README.md'), 'utf8');
assert.doesNotMatch(readme, legacyFlow, 'README must not retain the superseded LOOP / LEDGER flow');

// One positioning line, verbatim, shared with brickerp.github.io (/, /hire, /about) and the X bio.
const POSITIONING = 'AI agent & backend engineer — I take agents from demo to production: MCP tools, guardrails, evals, billing, real-time systems.';
const HIRE_URL = 'https://brickerp.github.io/hire/';
assert.match(readme, /^# Yupeng Lu\n\n/, 'README must open with the H1 name');
assert.ok(readme.startsWith(`# Yupeng Lu\n\n**${POSITIONING}**\n\n`), 'the bold positioning line must follow the H1, verbatim');
assert.doesNotMatch(readme, /^\*\*(?:Backend Engineer|AI Agent Engineer|Backend \/ AI Platform Engineer)\b/m, 'superseded role lines are forbidden');
assert.doesNotMatch(readme, /re-measure pending|pending re-measure|\bpending\b/i, 'README must not lead with a pending measurement');
assert.doesNotMatch(readme, /AI x Finance|markets (?:&|and) macro|especially for finance/i, 'finance is an exhibit, not the positioning');
assert.doesNotMatch(readme, /brickerp\.github\.io\/resume(?!\.pdf)/, 'the resume link must point at the PDF that exists');

const sectionIndex = (heading) => {
  const index = readme.indexOf(`\n### ${heading}\n`);
  assert.notEqual(index, -1, `README must carry a “${heading}” section`);
  return index;
};
const proofIndex = sectionIndex('Proof');
const hireIndex = sectionIndex('Hire me');
const nowIndex = sectionIndex('Now');
assert.ok(proofIndex < hireIndex && hireIndex < nowIndex, 'sections must run Proof → Hire me → Now');

const header = readme.slice(0, proofIndex);
assert.match(header, /Baidu \(MeDo/, 'the header must name the current role at Baidu (MeDo)');
assert.match(header, /Cookiy/, 'the header must name the Cookiy agent platform work');
assert.ok(header.includes(`](${HIRE_URL})`), 'the header must link /hire/');
assert.doesNotMatch(header, /<[A-Za-z!/]/, 'the header must stay plain Markdown without HTML');

const proofRows = readme.slice(proofIndex, hireIndex).split('\n').filter((line) => /^\| \*\*/.test(line));
assert.equal(proofRows.length, 4, 'the proof table must hold exactly four exhibits');
const exhibitContracts = [
  { label: /Agent platform & revenue backend — Baidu · MeDo/, links: ['https://brickerp.github.io/resume.pdf'] },
  {
    label: /Public MCP\/CLI surfaces — Cookiy AI/,
    links: [
      'https://www.npmjs.com/package/cookiy-cli',
      'https://www.npmjs.com/package/cookiy-mcp',
      'https://github.com/cookiy-ai/user-research-skill',
    ],
  },
  { label: /Production real-time system/, links: ['https://brickerp.github.io/work/quant/', 'https://d2c9pzwpavuktk.cloudfront.net/'] },
  { label: /Side projects/, links: ['https://github.com/BrickerP/fed-pulse', 'https://github.com/BrickerP/auction-tape'] },
];
for (const [index, row] of proofRows.entries()) {
  const contract = exhibitContracts[index];
  assert.match(row, contract.label, `proof row ${index + 1} must be ${contract.label}`);
  for (const link of contract.links) assert.ok(row.includes(`](${link})`), `proof row ${index + 1} must link ${link}`);
}
assert.match(proofRows[2], /Strategy and P&L stay private/, 'the real-time exhibit must keep strategy and P&L private');

const hireSection = readme.slice(hireIndex, nowIndex);
assert.ok(hireSection.includes(`](${HIRE_URL})`), 'Hire me must link /hire/');
assert.match(hireSection, /\(mailto:yplmicro@gmail\.com\)/, 'Hire me must carry the email');
assert.match(hireSection, /Part-time contract/, 'Hire me must state the part-time contract scope');
assert.match(hireSection, /No overlap with my employer/, 'Hire me must state the employer boundary');
assert.match(readme.slice(nowIndex), /\]\(https:\/\/x\.com\/trashConsumer\)/, 'Now must link the X account');

// Every figure in the README traces to resume.html / public-profile.json on brickerp.github.io,
// or is a stated availability or goal. Add a figure here only together with its source.
const tracedFigures = new Set([
  '41', '4', '1,040', '5.5K', '14', '59', '27', '40/40', '0', '600+', '19', '26', '291', // resume.html
  '01', '48', // technical sheet № 01, the 48-second film
  '20', '1,000', // availability (~20 h/week) and the stated X goal
]);
const prose = readme.replace(/\]\([^)]+\)/g, ']').replace(/<img\b[^>]*>/g, '').replace(/<a\b[^>]*>/g, '');
for (const raw of prose.match(/(?<![A-Za-z\d])\d[\d,./]*(?:\+|K)?(?![A-Za-z])/g) ?? []) {
  const figure = raw.replace(/[.,/]+$/, '');
  assert.ok(tracedFigures.has(figure), `README figure “${figure}” has no traced source; add the source before the figure`);
}

for (const [, label, href] of readme.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
  assert.match(href, /^(?:https:\/\/|mailto:)/, `link ${label} must use https or mailto: ${href}`);
}

// The zine cover may stay only below the text, where it cannot push the header or proof off the first screen.
const coverLine = `<img src="assets/human-zine-cover.svg" width="100%" alt="${coreAssets[0].alt}">`;
const coverIndex = readme.indexOf(coverLine);
if (coverIndex !== -1) {
  assert.ok(coverIndex > nowIndex, 'the zine cover must sit below the Now section');
}
assert.equal(readme.split(liveCardLine).length, 2, 'README must contain exactly one live status card');
assert.ok(readme.indexOf(liveCardLine) > nowIndex, 'the live status card must sit below the Now section');
if (coverIndex !== -1) {
  assert.ok(readme.includes(`${coverLine}\n\n${liveCardLine}\n`), 'the live status card must directly follow the zine cover');
}
assert.match(liveCard.src, /^https:\/\/profile-cards\.brickerp\.workers\.dev\/card\.svg$/, 'the live status card must be served by the profile-cards Worker');
assert.ok(countWords(liveCard.alt) >= 6, 'the live status card must provide a meaningful alt description');
assert.match(liveCard.alt, /\blive\b/i, 'the live status card alt must say that it is live');
assert.match(liveCard.alt, /A Profile With Memory/i, 'the live status card alt must identify experiment 001');
await readLocalReference(root, liveCard.href);
assert.equal((readme.match(/src="https?:\/\//g) ?? []).length, 1, 'the live status card must be the only remote image in the README');
assert.equal((readme.match(/<img\b/g) ?? []).length, (coverIndex === -1 ? 0 : 1) + 1, 'the cover and the live status card are the only images the README may embed');
assert.equal((readme.match(/<a\b/g) ?? []).length, 1, 'the live status card is the only HTML anchor the README may carry');

const experimentsIndex = await readFile(path.join(root, 'experiments', 'README.md'), 'utf8');
assert.doesNotMatch(experimentsIndex, /PAST FIXATIONS/i, 'phase one must not fabricate an empty past');
assert.match(experimentsIndex, /^\[← Profile\]\(\.\.\/README\.md\)$/m, 'archive must link back to the profile');
assert.match(experimentsIndex, /^## CURRENT \/ 001$/m, 'archive must identify current experiment 001');
assert.match(experimentsIndex, /^## FOUND BEFORE ISSUE 001$/m, 'archive must identify the found-before-001 section');
const chronologyDisclaimer = 'The before-issue-001 classification is author-reported from private source history and is not independently verifiable from this public page.';
assert.ok(experimentsIndex.includes(chronologyDisclaimer), 'archive must disclose the private-source chronology boundary');
const expectedArchiveAnchors = [
  ['001-a-profile-with-memory/README.md', '../assets/human-zine-memory.svg'],
  ['found/get-date-love/README.md', 'found/get-date-love/portal.svg'],
  ['found/quant-trading/README.md', 'found/quant-trading/portal.svg'],
];
const archiveAltContracts = [
  [/A Profile With Memory/i, /editorial|collage|zine/i, /enter|detail/i],
  [/Get Date Love/i, /case file|dossier/i, /enter|detail/i],
  [/Quant Trading/i, /paper research|research sheet|tractor-feed/i, /enter|detail/i],
];
const archiveAnchors = imageAnchors(experimentsIndex);
assert.deepEqual(archiveAnchors.map(({ href, src }) => [href, src]), expectedArchiveAnchors, 'archive portals must retain current, January, then April order');
for (const [index, { href, src, alt }] of archiveAnchors.entries()) {
  assert.ok(countWords(alt) >= 6, `archive portal ${src} must provide meaningful alt text`);
  const [work, editorialForm, detailDestination] = archiveAltContracts[index];
  assert.match(alt, work, `archive portal ${src} alt must identify the work`);
  assert.match(alt, editorialForm, `archive portal ${src} alt must identify its editorial form`);
  assert.match(alt, detailDestination, `archive portal ${src} alt must identify the detail destination`);
  await readLocalReference(path.join(root, 'experiments'), href);
  await readLocalReference(path.join(root, 'experiments'), src);
}

const experimentDetail = await readFile(path.join(root, 'experiments', '001-a-profile-with-memory', 'README.md'), 'utf8');
const profileHistory = [
  ['91A7A77', '91a7a77faf8492d1aaedd975cca404dc3890657e'],
  ['35AA305', '35aa3052a2765879a5c0973260f11042b81ca55e'],
  ['B130094', 'b130094cb5f273bbb20cec5cff163eafb511f638'],
  ['D71F9F3', 'd71f9f3c92a1c615d6b49a59da9bf1f40ddfffb1'],
];
assert.match(experimentDetail, /^\[← Thought Experiments\]\(\.\.\/README\.md\)$/m, 'experiment detail must link back to the archive');
for (const [label, hash] of profileHistory) {
  assert.match(
    experimentDetail,
    new RegExp(`\\[${label}\\]\\(https://github\\.com/BrickerP/BrickerP/commit/${hash}\\)`),
    `experiment 001 must link the full ${label} commit receipt`,
  );
}
assert.deepEqual(
  [...experimentDetail.matchAll(/\b[0-9a-f]{40}\b/g)].map((match) => match[0]).sort(),
  profileHistory.map(([, hash]) => hash).sort(),
  'experiment 001 must contain exactly the four approved full commit receipts',
);
assert.doesNotMatch(experimentDetail, /PAST FIXATIONS/i, 'phase one detail must not display an empty past');

const assetNames = (await readdir(assetRoot)).sort();
assert.deepEqual(assetNames, assets.map(({ file }) => file).sort(), `assets must contain exactly the ${assets.length} approved Human Zine spreads`);

const svgs = new Map();
const visibleCopy = [];
const usedPalette = new Set();
for (const asset of assets) {
  const isCoreAsset = coreAssets.some(({ file }) => file === asset.file);
  const svg = await readFile(path.join(assetRoot, asset.file), 'utf8');
  svgs.set(asset.file, svg);
  if (isCoreAsset) assert.doesNotMatch(svg, legacyFlow, `${asset.file}: superseded LOOP / LEDGER flow is forbidden`);

  const rootTag = svg.match(/^<svg\b([^>]*)>/)?.[1];
  assert.ok(rootTag, `${asset.file}: missing root svg element`);
  assert.equal(getAttribute(rootTag, 'width'), String(asset.width), `${asset.file}: incorrect width`);
  assert.equal(getAttribute(rootTag, 'height'), String(asset.height), `${asset.file}: incorrect height`);
  assert.equal(getAttribute(rootTag, 'viewBox'), `0 0 ${asset.width} ${asset.height}`, `${asset.file}: incorrect viewBox`);
  assert.equal((svg.match(/<title\b/g) ?? []).length, 1, `${asset.file}: expected one title`);
  assert.equal((svg.match(/<desc\b/g) ?? []).length, 1, `${asset.file}: expected one description`);

  const records = textRecords(svg);
  const assetCopy = records.map(({ text }) => text);
  assert.doesNotMatch(svg, /<tspan\b[^>]*\bfont-size=/i, `${asset.file}: nested text must not override the verified source size`);
  if (isCoreAsset) {
    assert.deepEqual(assetCopy, asset.text, `${asset.file}: visible copy must remain exact and complete`);
    visibleCopy.push(...assetCopy);
    for (const record of records) {
      const fontSize = Number(getAttribute(record.attributes, 'font-size'));
      const isReceiptIdentifier = /^(?:5E8F667|B9EF619|520E83F) \/$/.test(record.text);
      if (isReceiptIdentifier) {
        assert.equal(fontSize, 54, `${asset.file}: ${record.text} must use exactly 54px source text`);
      } else {
        assert.ok(Number.isFinite(fontSize) && fontSize >= 60, `${asset.file}: ${record.text} must use at least 60px source text`);
      }
    }
  }

  const metadata = normalizeText(svg.match(/<metadata>([\s\S]*?)<\/metadata>/)?.[1] ?? '');
  assert.ok(metadata, `${asset.file}: missing nonvisible source metadata`);
  if (isCoreAsset) {
    for (const evidence of legacyMetadataEvidence) {
      assert.ok(metadata.includes(evidence), `${asset.file}: metadata must include ${evidence}`);
    }
  } else {
    assert.match(metadata, /Thought experiment 001: A Profile With Memory\./, `${asset.file}: missing experiment identity`);
    assert.match(metadata, /linear main-branch history of this profile/i, `${asset.file}: receipts must be identified as linear main history`);
    assert.deepEqual(
      [...metadata.matchAll(/\b[0-9a-f]{40}\b/g)].map((match) => match[0]).sort(),
      profileHistory.map(([, hash]) => hash).sort(),
      `${asset.file}: metadata must contain only the four profile commit receipts`,
    );
    assert.doesNotMatch(metadata, /(?:\/Users\/|BeijingDriveScene|buildOlympic|buildSecondRingThreshold|ai-usage-report)/, `${asset.file}: unrelated film, AI, or machine-local evidence is forbidden`);
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

const memoryRecords = textRecords(svgs.get(memoryAsset.file));
for (const [semanticRole, minimumSize] of [
  ['memory-question-line', 60],
  ['memory-cta', 60],
  ['memory-history-label', 54],
]) {
  const semanticRecords = memoryRecords.filter(({ attributes }) => getAttribute(attributes, 'data-role') === semanticRole);
  assert.ok(semanticRecords.length > 0, `${memoryAsset.file}: missing ${semanticRole} text`);
  for (const record of semanticRecords) {
    const fontSize = Number(getAttribute(record.attributes, 'font-size'));
    assert.ok(Number.isFinite(fontSize) && fontSize >= minimumSize, `${memoryAsset.file}: ${semanticRole} text must use at least ${minimumSize}px source text`);
  }
}

assert.ok(countWords(visibleCopy.join(' ')) <= 85, `The original ${coreAssets.length} Human Zine spreads must stay within the 85-word budget`);

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

const foundExperiments = [
  {
    directory: 'found/get-date-love',
    identity: /Private product experiment in 2026\.01/i,
    headline: /\bGET DATE LOVE\b/,
    question: /CAN AI CROSS A CULTURE WITHOUT OPTIMIZING INTIMACY\?/,
    boundary: /PRIVATE CODE \/ PUBLIC QUESTION/,
    semanticDescription: /case[\s\S]*translation[\s\S]*redaction/i,
    excludedDescription: /greenbar|tractor-feed|perforat|research record/i,
    detailHeadings: ['## The question', '## What existed', '## What it exposed', '## Public boundary'],
  },
  {
    directory: 'found/quant-trading',
    identity: /Private research experiment in 2026\.04/i,
    headline: /\bQUANT TRADING\b/,
    question: /CAN A MARKET HYPOTHESIS SURVIVE AN AUDIT\?/,
    boundary: /PAPER RESEARCH \/ NOT INVESTMENT PERFORMANCE/,
    semanticDescription: /greenbar[\s\S]*tractor-feed[\s\S]*research record/i,
    excludedDescription: /case file|translation|redaction/i,
    detailHeadings: ['## Public boundary'],
    detailBoundary: 'This page describes a research method, not investment performance.',
    // The detail page is a short pointer to the public technical sheet; that one URL is the only remote reference allowed.
    detailPointer: ['Technical sheet № 01', 'https://brickerp.github.io/work/quant/'],
  },
];

const foundDetailForbidden = /(?:https?:\/\/|\b[0-9a-f]{7,40}\b|(?:^|[\s`])(?:src|source|app|packages?)\/|\b(?:screenshots?|configs?|users?|chats?|avatars?|metrics?|deploy(?:ed|ment)?|P&L|returns?|win rate|accounts?|investment advice|live trading|tech stack|frameworks?|libraries|database|endpoints?|architecture)\b)/i;
const foundPublicCorpus = [experimentsIndex];
for (const experiment of foundExperiments) {
  const experimentDirectory = path.join(root, 'experiments', experiment.directory);
  const portal = await readFile(path.join(experimentDirectory, 'portal.svg'), 'utf8');
  foundPublicCorpus.push(portal);
  const portalRoot = portal.match(/^<svg\b([^>]*)>/)?.[1];
  assert.ok(portalRoot, `${experiment.directory}/portal.svg: missing root svg element`);
  assert.equal(getAttribute(portalRoot, 'width'), '1200', `${experiment.directory}/portal.svg: width must remain 1200`);
  assert.equal(getAttribute(portalRoot, 'height'), '720', `${experiment.directory}/portal.svg: height must remain 720`);
  assert.equal(getAttribute(portalRoot, 'viewBox'), '0 0 1200 720', `${experiment.directory}/portal.svg: viewBox must match its release size`);
  assert.equal(getAttribute(portalRoot, 'role'), 'img', `${experiment.directory}/portal.svg: root role must be img`);
  const labelledBy = getAttribute(portalRoot, 'aria-labelledby')?.split(/\s+/) ?? [];
  assert.equal(labelledBy.length, 2, `${experiment.directory}/portal.svg: aria-labelledby must reference title and description`);
  assert.equal((portal.match(/<title\b/g) ?? []).length, 1, `${experiment.directory}/portal.svg: exactly one title is required`);
  assert.equal((portal.match(/<desc\b/g) ?? []).length, 1, `${experiment.directory}/portal.svg: exactly one description is required`);
  for (const id of labelledBy) assert.match(portal, new RegExp(`<(?:title|desc)\\b[^>]*\\bid="${id}"`), `${experiment.directory}/portal.svg: missing labelled element ${id}`);
  assert.deepEqual(roleValues(portal), ['img'], `${experiment.directory}/portal.svg: only the root img role is allowed`);
  assert.doesNotMatch(
    portal,
    /<(?:a|script|style|image|foreignObject|animate|animateMotion|animateTransform|set|iframe|video|audio|canvas|button|use)\b/i,
    `${experiment.directory}/portal.svg: interactive, embedded, or dynamic elements are forbidden`,
  );
  assert.doesNotMatch(portal, /\b(?:href|xlink:href|on[a-z]+|pointer-events|cursor|tabindex)\s*=/i, `${experiment.directory}/portal.svg: links, handlers, and hit zones are forbidden`);
  assert.doesNotMatch(portal, /\bfocusable\s*=\s*["']?true\b/i, `${experiment.directory}/portal.svg: focusable content is forbidden`);
  assert.doesNotMatch(portal, /@(?:import|font-face|media)|prefers-color-scheme|animation\s*:|transition\s*:/i, `${experiment.directory}/portal.svg: remote fonts, themes, and motion are forbidden`);
  assert.doesNotMatch(portal.replace('xmlns="http://www.w3.org/2000/svg"', ''), /https?:\/\//i, `${experiment.directory}/portal.svg: remote resources are forbidden`);
  for (const match of portal.matchAll(/url\(([^)]+)\)/g)) assert.match(match[1], /^#[A-Za-z][\w.-]*$/, `${experiment.directory}/portal.svg: only local paint references are allowed`);

  const portalRecords = textRecords(portal);
  for (const record of portalRecords) {
    assert.match(getAttribute(record.attributes, 'font-family') ?? '', /Arial|sans-serif|system-ui|-apple-system/i, `${experiment.directory}/portal.svg: visible text must use a system font stack`);
    const fontSize = Number(getAttribute(record.attributes, 'font-size'));
    assert.ok(Number.isFinite(fontSize) && fontSize >= 60, `${experiment.directory}/portal.svg: core text ${record.text} must use at least 60px source text`);
  }
  const portalCopy = portalRecords.map(({ text }) => text).join(' ');
  assert.match(portalCopy, experiment.headline, `${experiment.directory}/portal.svg: missing approved headline`);
  assert.match(portalCopy, experiment.question, `${experiment.directory}/portal.svg: missing approved question`);
  assert.match(portalCopy, experiment.boundary, `${experiment.directory}/portal.svg: missing approved public boundary`);
  const portalDescription = normalizeText(portal.match(/<desc\b[^>]*>([\s\S]*?)<\/desc>/)?.[1] ?? '');
  assert.match(portalDescription, experiment.semanticDescription, `${experiment.directory}/portal.svg: accessible description must identify its distinct visual semantics`);
  assert.doesNotMatch(portalDescription, experiment.excludedDescription, `${experiment.directory}/portal.svg: visual semantics must remain distinct from the other found experiment`);

  const rawDetail = await readFile(path.join(experimentDirectory, 'README.md'), 'utf8');
  let detail = rawDetail;
  if (experiment.detailPointer) {
    const [pointerLabel, pointerHref] = experiment.detailPointer;
    const pointerLink = `[${pointerLabel}](${pointerHref})`;
    assert.equal(rawDetail.split(pointerLink).length, 2, `${experiment.directory}/README.md: must point to the technical sheet exactly once`);
    detail = rawDetail.replace(pointerLink, pointerLabel);
  }
  if (experiment.detailBoundary) {
    assert.ok(detail.includes(experiment.detailBoundary), `${experiment.directory}/README.md: missing public boundary sentence`);
  }
  foundPublicCorpus.push(detail);
  for (const heading of experiment.detailHeadings) assert.match(detail, new RegExp(`^${heading}$`, 'm'), `${experiment.directory}/README.md: missing ${heading}`);
  assert.match(detail, experiment.identity, `${experiment.directory}/README.md: missing approved experiment identity and month`);
  assert.ok(detail.includes(chronologyDisclaimer), `${experiment.directory}/README.md: missing chronology disclaimer`);
  assert.match(detail, /^\[← Experiment Archive\]\(\.\.\/\.\.\/README\.md\)$/m, `${experiment.directory}/README.md: archive backlink must remain relative`);
  assert.doesNotMatch(detail, foundDetailForbidden, `${experiment.directory}/README.md: contains private implementation evidence, user data, deployment claims, or financial claims`);
}

const approvedFoundCorpus = foundPublicCorpus
  .join('\n')
  .replaceAll('http://www.w3.org/2000/svg', '')
  .replaceAll('width="100%"', '')
  .replace(/not investment performance/gi, 'approved-visible-boundary')
  .replace(/separated from investment performance/gi, 'approved-description-boundary')
  .replace(/no performance claim/gi, 'approved-metadata-boundary');
const forbiddenFoundCorpus = [
  ['public or private repository URL', /https?:\/\/|\b(?:github|gitlab)\.com\//i],
  ['commit hash', /\b[0-9a-f]{7,40}\b/i],
  ['source or machine path', /(?:^|[\s"'(])(?:\/Users\/|[A-Za-z]:\\|(?:src|source|app|packages?)\/)|\b[\w.-]+\.(?:ts|tsx|js|jsx|py|go|java|rs|sql|env|toml|ya?ml)\b/im],
  ['configuration or secret value', /\b(?:configs?|configuration|secrets?|tokens?|api keys?|credentials?|passwords?)\b/i],
  ['person identity or location', /\b(?:full name|real name|email|phone|address|identity|person|people|location|city|country|street)\b|\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i],
  ['conversation or image evidence', /\b(?:conversations?|chats?|messages?|photos?|screenshots?|avatars?|portraits?)\b/i],
  ['metric, score, percentage, or currency', /\b(?:metrics?|scores?|percentages?|USD|CNY|RMB|EUR|HKD|dollars?|yuan)\b|\d+(?:\.\d+)?%|[$€£¥]/i],
  ['financial result or advice', /\b(?:returns?|revenues?|profits?|profitability|performance|P&L|win rate|accounts?|investment advice)\b/i],
  ['live production or release claim', /\b(?:live production|live system|live service|production|deployed|deployment|released|launched|shipped)\b/i],
  ['claimed result', /\b(?:claimed results?|results?|outcomes?|achieved|improved|increased|decreased|success|successful)\b/i],
];
for (const [label, pattern] of forbiddenFoundCorpus) assert.doesNotMatch(approvedFoundCorpus, pattern, `Found public corpus must not expose ${label}`);

const experimentPaths = await listRelativePaths(path.join(root, 'experiments'));
assert.ok(experimentPaths.every((entry) => !/^(?:found-get-date-love|found-quant-trading)(?:\/|$)/.test(entry)), 'superseded flat found-experiment paths must remain removed');
assert.ok(experimentPaths.every((entry) => !/^(?:000|002|003)(?:[-/]|$)/.test(entry)), 'numbered experiments 000, 002, and 003 must remain absent in this phase');
for (const relative of experimentPaths.filter((entry) => /\.(?:md|svg)$/i.test(entry))) {
  assert.doesNotMatch(await readFile(path.join(root, 'experiments', relative), 'utf8'), /PAST FIXATIONS/i, `${relative}: phase one must not fabricate a past-fixations section`);
}

console.log('Profile README contract verified: positioning line, four exhibits, hire section, traced figures, archived spreads.');
