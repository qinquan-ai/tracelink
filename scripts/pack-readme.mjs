#!/usr/bin/env node
/**
 * README swap for `npm pack` / `npm publish`.
 *
 * The GitHub homepage README (repo index) and the npm-package README are
 * different files. The tarball must ship the consumer-facing README.npm.md as
 * its README.md, while the working tree keeps the repo-index README.md.
 *
 *   prepack:  back up the repo-index README.md to a temp file, then copy
 *             README.npm.md over README.md so the tarball ships the npm version.
 *   postpack: restore the repo-index README.md from the backup and delete it.
 *
 * Robustness:
 *   - prepack only takes a backup when one does not already exist, so a leftover
 *     backup from a previously interrupted pack is never clobbered (the original
 *     repo-index content is preserved). Running prepack again just re-applies the
 *     npm README on top.
 *   - postpack is a no-op (with a warning) when there is nothing to restore.
 *   - If a prior run was interrupted, run `node scripts/pack-readme.mjs postpack`
 *     to restore the working tree.
 *
 * Usage: node scripts/pack-readme.mjs <prepack|postpack>
 */
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(repoRoot, 'README.md');
const README_NPM = join(repoRoot, 'README.npm.md');
// Stable temp path so prepack and postpack of the same run agree.
const BACKUP = join(tmpdir(), 'tracelink-readme-repo-index.bak');

function prepack() {
  if (!existsSync(README_NPM)) {
    throw new Error(`[pack-readme] Missing ${README_NPM}; cannot build the npm README.`);
  }
  // Preserve the original repo-index README; never overwrite an existing backup
  // (that backup may be the only surviving copy after an interrupted pack).
  if (!existsSync(BACKUP)) {
    if (!existsSync(README)) {
      throw new Error(`[pack-readme] Missing ${README}; nothing to back up.`);
    }
    copyFileSync(README, BACKUP);
    console.log(`[pack-readme] Backed up repo-index README.md -> ${BACKUP}`);
  } else {
    console.warn(`[pack-readme] Backup already exists at ${BACKUP}; keeping it.`);
  }
  copyFileSync(README_NPM, README);
  console.log('[pack-readme] README.md now holds the npm (consumer) README for packing.');
}

function postpack() {
  if (existsSync(BACKUP)) {
    copyFileSync(BACKUP, README);
    rmSync(BACKUP, { force: true });
    console.log('[pack-readme] Restored repo-index README.md and removed the backup.');
  } else {
    console.warn(`[pack-readme] No backup at ${BACKUP}; leaving README.md untouched.`);
  }
}

const mode = process.argv[2];
if (mode === 'prepack') {
  prepack();
} else if (mode === 'postpack') {
  postpack();
} else {
  console.error('[pack-readme] Usage: node scripts/pack-readme.mjs <prepack|postpack>');
  process.exit(1);
}
