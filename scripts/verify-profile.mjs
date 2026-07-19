import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = await readFile(path.join(root, 'README.md'), 'utf8');
const verifyExternalUrls = process.argv.includes('--external');
const approvedPreviewSha256 = '8bf12f39278a1d01c30743664bcc735b3c60977071db9979136a79b5a44ff067';
const approvedResumeSha256 = 'de68cbb3d943e7ed0533c0fc9c7bbad3385943257109f77bfcb805d8ff713524';
const approvedActions = new Set([
  'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
]);

function countMatches(text, pattern) {
  return text.match(pattern)?.length ?? 0;
}

function assertAccessibleResume(buffer, name) {
  assert.equal(buffer.subarray(0, 5).toString('ascii'), '%PDF-', `${name}: invalid PDF signature`);
  assert.equal(buffer.length, 50_918, `${name}: unexpected tagged artifact size`);
  assert.equal(createHash('sha256').update(buffer).digest('hex'), approvedResumeSha256, `${name}: unapproved resume revision`);

  const pdf = buffer.toString('latin1');
  assert.match(pdf, /%%EOF\s*$/, `${name}: missing final PDF end marker`);
  assert.equal(countMatches(pdf, /\/Type\s+\/Page\b/g), 2, `${name}: expected two pages`);
  assert.ok(!pdf.toLowerCase().includes('yupeng-dev'), `${name}: stale GitHub identity`);
  assert.match(pdf, /\/StructTreeRoot\b/, `${name}: missing tagged-PDF structure tree`);
  assert.match(pdf, /\/MarkInfo\s*<<[\s\S]*?\/Marked\s+true[\s\S]*?>>/, `${name}: PDF is not marked as tagged`);
  assert.match(pdf, /\/Lang\s*\(en\\055US\)/, `${name}: document language must be en-US`);
  assert.match(pdf, /\/Title\s*\(Yupeng Lu \\055 AI Agent Engineer\)/, `${name}: accessible document title is missing`);
  assert.match(pdf, /\/Author\s*\(Yupeng Lu\)/, `${name}: document author is missing`);
  assert.match(pdf, /\/Metadata\s+\d+\s+0\s+R\b/, `${name}: XMP metadata stream is missing`);
  assert.match(pdf, /\/ViewerPreferences\s*<<[\s\S]*?\/DisplayDocTitle\s+true[\s\S]*?>>/, `${name}: title display preference is missing`);
  assert.equal(countMatches(pdf, /\/Tabs\s+\/S\b/g), 2, `${name}: both pages must use structural tab order`);
  assert.equal(countMatches(pdf, /\/StructParents\s+[01]\b/g), 2, `${name}: both pages need structure-parent indices`);
  assert.match(pdf, /\/ParentTreeNextKey\s+13\b/, `${name}: parent tree must cover pages and link annotations`);
  assert.equal(countMatches(pdf, /\/S\s+\/Document\b/g), 1, `${name}: expected one document structure root`);
  assert.equal(countMatches(pdf, /\/S\s+\/Sect\b/g), 10, `${name}: expected ten semantic sections`);
  assert.equal(countMatches(pdf, /\/S\s+\/P\b/g), 12, `${name}: expected 12 paragraphs`);
  assert.equal(countMatches(pdf, /\/S\s+\/H1\b/g), 1, `${name}: expected one H1`);
  assert.equal(countMatches(pdf, /\/S\s+\/H2\b/g), 4, `${name}: expected four H2 headings`);
  assert.equal(countMatches(pdf, /\/S\s+\/H3\b/g), 6, `${name}: expected six H3 headings`);
  assert.equal(countMatches(pdf, /\/S\s+\/L\b/g), 5, `${name}: expected five semantic lists`);
  assert.equal(countMatches(pdf, /\/S\s+\/LI\b/g), 22, `${name}: expected 22 list items`);
  assert.equal(countMatches(pdf, /\/S\s+\/LBody\b/g), 22, `${name}: every list item needs a list body`);
  assert.equal(countMatches(pdf, /\/S\s+\/Link\b/g), 11, `${name}: expected 11 tagged links`);
  assert.equal(countMatches(pdf, /\/StructParent\s+\d+\b/g), 11, `${name}: every link annotation needs a structure parent`);
  assert.equal(countMatches(pdf, /\/Type\s+\/OBJR\b/g), 11, `${name}: every tagged link needs an object reference`);
  assert.equal(countMatches(pdf, /\/Contents\s*\([^\r\n]*\)/g), 11, `${name}: every link needs an accessible description`);
  assert.ok(countMatches(pdf, /\/ToUnicode\s+\d+\s+0\s+R\b/g) >= 2, `${name}: fonts need Unicode maps`);
  assert.match(pdf, /\/Outlines\s+\d+\s+0\s+R\b/, `${name}: section bookmarks are missing`);
  assert.doesNotMatch(
    pdf,
    /\/(?:JavaScript|JS|OpenAction|AA|Launch|EmbeddedFile|AcroForm|Encrypt)\b/,
    `${name}: active, embedded, form, or encrypted content is forbidden`,
  );
}

assert.match(readme, /\]\(social-preview\.png\)/, 'README must embed the current social preview');
assert.doesNotMatch(readme, /endless-second-ring-preview\.png/, 'README must not reference the stale preview');

const preview = await readFile(path.join(root, 'social-preview.png'));
assert.equal(preview.subarray(1, 4).toString('ascii'), 'PNG', 'social preview must be a PNG');
assert.equal(preview.readUInt32BE(16), 1200, 'social preview width must be 1200px');
assert.equal(preview.readUInt32BE(20), 630, 'social preview height must be 630px');
assert.equal(
  createHash('sha256').update(preview).digest('hex'),
  approvedPreviewSha256,
  'social preview must match the visually approved current animation capture',
);
const previewAssets = (await readdir(root)).filter((name) => /\.png$/i.test(name));
assert.deepEqual(
  previewAssets,
  ['social-preview.png'],
  'profile must expose exactly one current preview asset',
);

assert.match(readme, /\[Current resume \(PDF\)\]\(Yupeng_Lu_Resume\.pdf\)/, 'README must link the current resume');
const resume = await readFile(path.join(root, 'Yupeng_Lu_Resume.pdf'));
assertAccessibleResume(resume, 'Yupeng_Lu_Resume.pdf');

const resumeAssets = (await readdir(root)).filter((name) => /\.(?:pdf|docx)$/i.test(name));
assert.deepEqual(resumeAssets, ['Yupeng_Lu_Resume.pdf'], 'profile must expose exactly one current resume asset');
for (const staleName of ['Resume_YupengLu.docx', '卢昱鹏简历.pdf']) {
  assert.ok(!readme.includes(staleName), `README must not reference ${staleName}`);
}

for (const match of readme.matchAll(/\]\(([^)]+)\)/g)) {
  const target = match[1];
  if (!/^https?:\/\//.test(target)) await access(path.join(root, target));
}

assert.equal((await readFile(path.join(root, '.node-version'), 'utf8')).trim(), '22.23.1', 'Node version must stay pinned');
const workflow = await readFile(path.join(root, '.github/workflows/profile-integrity.yml'), 'utf8');
assert.match(workflow, /^\s*pull_request:\s*$/m, 'CI must run for pull requests');
assert.match(workflow, /^\s*push:\s*$[\s\S]*?^\s*branches:\s*$[\s\S]*?^\s*- main\s*$/m, 'CI must run for main pushes');
assert.match(workflow, /^\s*workflow_dispatch:\s*$/m, 'CI must support manual verification');
assert.match(workflow, /^permissions:\s*\n\s+contents: read\s*$/m, 'CI must use read-only repository permissions');
assert.match(workflow, /^\s{2}profile-integrity:\s*$/m, 'CI must expose the stable profile-integrity job');
assert.match(workflow, /^\s+name: profile-integrity\s*$/m, 'CI check name must stay stable');
assert.match(workflow, /^\s+timeout-minutes: 5\s*$/m, 'CI must have a bounded timeout');
assert.match(workflow, /^\s+node-version-file: \.node-version\s*$/m, 'CI must use the repository Node pin');
assert.match(workflow, /^\s+run: node scripts\/verify-profile\.mjs\s*$/m, 'CI must run the local deterministic verifier');
assert.ok(!workflow.includes('--external'), 'CI must not depend on live network checks');
const actionUses = [...workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gm)].map((match) => match[1]);
assert.deepEqual(new Set(actionUses), approvedActions, 'CI actions must stay pinned to approved immutable SHAs');

const dependabot = await readFile(path.join(root, '.github/dependabot.yml'), 'utf8');
assert.match(dependabot, /package-ecosystem: github-actions/, 'Dependabot must monitor GitHub Actions');
assert.match(dependabot, /interval: weekly/, 'GitHub Actions updates must run weekly');

if (verifyExternalUrls) {
  const urls = [...new Set(readme.match(/https:\/\/[^)\s]+/g) ?? [])];
  for (const url of urls) {
    const response = await fetch(url, {
      headers: { 'user-agent': 'BrickerP-profile-verifier' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
    assert.ok(response.ok, `${url} returned HTTP ${response.status}`);
  }

  const repository = await fetch('https://api.github.com/repos/cookiy-ai/user-research-skill', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'BrickerP-profile-verifier' },
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(repository.ok, `GitHub repository API returned HTTP ${repository.status}`);
  const metadata = await repository.json();
  assert.ok(metadata.stargazers_count >= 100, 'user-research-skill no longer supports the 100+ stars claim');
}

console.log(`Profile link and asset integrity verified${verifyExternalUrls ? ' with live URLs' : ''}.`);
