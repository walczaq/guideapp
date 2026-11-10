// Stamps the build line shown in the app's About screen with the deploy date
// and commit, so "which build is this phone running?" always has a true
// answer without anyone remembering to bump it by hand.
//
// Runs as wrangler's [build] command (see wrangler.toml), i.e. on every
// deploy — the GitHub Action and Cloudflare Workers Builds alike. It rewrites
// the one line in v0.5.html marked `@build-stamp`, in the deploy checkout only.
//
// It must never break a deploy: any problem is logged and the script still
// exits 0, leaving the committed placeholder ("dev") in place. Outside CI it
// does nothing, so a local `wrangler dev`/`deploy` doesn't dirty the tree.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const FILE = new URL('../v0.5.html', import.meta.url);
const LINE = /^(const BUILD_STAMP = ')[^']*(';\s*\/\/ @build-stamp.*)$/m;

try {
  const env = process.env;
  if (!env.CI && !env.WORKERS_CI && !env.FN_STAMP) {
    console.log('[stamp-build] not in CI — leaving the build stamp as committed');
    process.exit(0);
  }
  let sha = env.WORKERS_CI_COMMIT_SHA || env.GITHUB_SHA || '';
  if (!sha) {
    try { sha = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* no git */ }
  }
  const date = new Date().toISOString().slice(0, 10);
  const stamp = sha && /^[0-9a-f]{7,40}$/i.test(sha) ? `${date} · ${sha.slice(0, 7)}` : date;

  const html = readFileSync(FILE, 'utf8');
  if (!LINE.test(html)) {
    console.warn('[stamp-build] @build-stamp line not found in v0.5.html — nothing stamped');
    process.exit(0);
  }
  writeFileSync(FILE, html.replace(LINE, `$1${stamp}$2`));
  console.log(`[stamp-build] build stamped: ${stamp}`);
} catch (err) {
  console.warn('[stamp-build] skipped:', err && err.message);
}
