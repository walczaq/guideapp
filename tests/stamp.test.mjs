// tools/stamp-build.mjs: stamps in CI, leaves the tree alone locally, and the
// committed page still carries the marker line it rewrites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';

const MARKER = /^const BUILD_STAMP = '([^']*)';\s*\/\/ @build-stamp/m;

function runIn(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-stamp-'));
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.copyFileSync(path.join(ROOT, 'tools/stamp-build.mjs'), path.join(dir, 'tools/stamp-build.mjs'));
  fs.copyFileSync(path.join(ROOT, 'v0.5.html'), path.join(dir, 'v0.5.html'));
  const clean = { PATH: process.env.PATH, ...env };
  execFileSync(process.execPath, ['tools/stamp-build.mjs'], { cwd: dir, env: clean, stdio: 'pipe' });
  const stamp = fs.readFileSync(path.join(dir, 'v0.5.html'), 'utf8').match(MARKER)[1];
  fs.rmSync(dir, { recursive: true, force: true });
  return stamp;
}

test('the committed page carries an unstamped marker line', () => {
  const m = fs.readFileSync(path.join(ROOT, 'v0.5.html'), 'utf8').match(MARKER);
  assert.ok(m, '@build-stamp line missing from v0.5.html');
  assert.equal(m[1], 'dev', 'a stamped build line was committed');
});

test('stamps date and commit in CI', () => {
  assert.match(runIn({ CI: 'true', GITHUB_SHA: 'abcdef1234567890' }), /^\d{4}-\d{2}-\d{2} · abcdef1$/);
});

test('does nothing outside CI', () => {
  assert.equal(runIn({}), 'dev');
});
