#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wrapper = join(appRoot, 'scripts', 'entire.mjs');
const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: appRoot, encoding: 'utf8' });
if (git.status !== 0) {
  console.error('Entire setup requires an existing local Git repository. No repository or commit was created.');
  process.exit(1);
}
const repository = git.stdout.trim();
const cache = join(appRoot, '.tools', 'entire');
// Entire deliberately recognizes only its canonical Codex hook commands.
// Give those commands a normal PATH executable; never overwrite another install.
let available = spawnSync('entire', ['version'], { encoding: 'utf8' });
if (available.error?.code === 'ENOENT') {
  const userBin = join(homedir(), '.local', 'bin');
  if (!(process.env.PATH ?? '').split(':').includes(userBin)) {
    throw new Error('Add ~/.local/bin to the Codex launch environment PATH, then rerun setup.');
  }
  const receipt = JSON.parse(await readFile(join(cache, '0.12.2', 'receipt.json'), 'utf8'));
  if (receipt.version !== '0.12.2') throw new Error('Install the pinned verified CLI first.');
  await mkdir(userBin, { recursive: true });
  const target = join(userBin, 'entire');
  await copyFile(join(cache, '0.12.2', 'entire'), target, constants.COPYFILE_EXCL);
  await chmod(target, 0o700);
  console.log('Installed the verified CLI at ~/.local/bin/entire for canonical Codex hooks.');
  available = spawnSync('entire', ['version'], { encoding: 'utf8' });
}
if (available.status !== 0 || !available.stdout.includes('Entire CLI 0.12.2')) {
  throw new Error('A different or unavailable Entire executable is on PATH; it was not overwritten.');
}
const hooksPath = join(repository, '.codex', 'hooks.json');
// Remove only experimental commands created by this script. Canonical vendor
// commands and unrelated hook integrations remain managed by their own tools.
try {
  const existing = JSON.parse(await readFile(hooksPath, 'utf8'));
  let changed = false;
  for (const [event, groups] of Object.entries(existing.hooks ?? {})) {
    for (const group of groups) {
      group.hooks = (group.hooks ?? []).filter((hook) => {
        const ours = hook.command?.includes('hooks codex ') &&
          (hook.command.includes(wrapper) || hook.command.includes(`ENTIRE_PLUGIN_DIR='${cache}/plugins'`));
        if (ours) changed = true;
        return !ours;
      });
    }
    existing.hooks[event] = groups.filter((group) => group.hooks.length);
  }
  if (changed) await writeFile(hooksPath, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const enable = spawnSync(process.execPath, [wrapper, 'enable', '--agent', 'codex', '--no-init-repo',
  '--skip-initial-commit', '--skip-push-sessions', '--telemetry=false', '--absolute-git-hook-path',
  '--checkpoint-backend', 'refs', '--project', '--yes'], { cwd: repository, stdio: 'inherit' });
if (enable.status !== 0) process.exit(enable.status ?? 1);

// Verify one standard hook for each event without changing its command or trust.
const hooks = JSON.parse(await readFile(hooksPath, 'utf8'));
let installed = 0;
for (const groups of Object.values(hooks.hooks ?? {})) {
  for (const group of groups) {
    for (const hook of group.hooks ?? []) {
      if (hook.command?.includes('exec entire hooks codex ')) installed++;
    }
  }
}
if (installed !== 7) throw new Error(`Expected seven standard Codex hooks; found ${installed}. Inspect ${hooksPath}.`);

const settingsPath = join(repository, '.entire', 'settings.json');
const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
settings.telemetry = false;
settings.strategy_options = { ...settings.strategy_options, push_sessions: false };
settings.redaction = {
  ...settings.redaction,
  betterleaks: { ...settings.redaction?.betterleaks, enabled: true },
  pii: { ...settings.redaction?.pii, enabled: true, email: true, phone: true },
  externalize_images: true,
};
await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
console.log(`Configured ${installed} standard Codex hooks and local-only capture settings.`);
console.log('No commit, upload, account change or hook trust approval was performed.');
console.log('Codex must approve the hooks through its normal /hooks flow and load them in a new session.');
console.log('Checkpoints and committed-tree Graph indexing require an authorized initial commit. Images are not redacted.');
