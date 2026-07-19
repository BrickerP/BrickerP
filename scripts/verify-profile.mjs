import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = await readFile(path.join(root, 'README.md'), 'utf8');
const verifyExternalUrls = process.argv.includes('--external');
const approvedPreviewSha256 = '8bf12f39278a1d01c30743664bcc735b3c60977071db9979136a79b5a44ff067';
const approvedResumeSha256 = '3a4ceeebef174745fa8117dafee31d5741eb63f23891b60f47e1c94ad9eeff7e';
const approvedActions = new Set([
  'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
]);

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
assert.equal(resume.subarray(0, 5).toString('ascii'), '%PDF-', 'current resume must have a PDF signature');
assert.equal(createHash('sha256').update(resume).digest('hex'), approvedResumeSha256, 'current resume must match the visually approved revision');
assert.ok(!resume.toString('latin1').toLowerCase().includes('yupeng-dev'), 'current resume must not retain the stale GitHub identity');

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
