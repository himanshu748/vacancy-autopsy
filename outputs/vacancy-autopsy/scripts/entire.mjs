#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pinned to the official stable release checked on 2026-10-30. Installation
// requires no login. Forwarded commands retain their documented side effects.
const version = '0.12.2';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheRoot = join(projectRoot, '.tools', 'entire');
const binDir = join(cacheRoot, version);
const checksums = {
  darwin_arm64: 'ec8f8a325e0f8f0b0c17781906273b5e21bc125b0bb6cfbc0c61cad8dfccba4f',
  darwin_x64: '91d1fc3cd564286ac3221f12b1d5990882b296a88fa9024786e937dc02dc6f70',
  linux_arm64: 'f08a1b8c6352d3f78076268dc67b0b273d7f62dbab94b15aec028e7b4257ad0c',
  linux_x64: 'bfc5c8d5b599f328775b89b735db020c963e307b6a324fc30ce371fe8fa789e8',
};
const platform = `${process.platform}_${process.arch}`;
if (!(platform in checksums)) {
  console.error('Use Entire’s official installer for this platform: https://docs.entire.com/installation');
  process.exit(1);
}
const binary = join(binDir, 'entire');
const environment = {
  ...process.env,
  ENTIRE_NO_AUTO_UPDATE: '1',
  ENTIRE_TELEMETRY_OPTOUT: '1',
  ENTIRE_CONFIG_DIR: join(cacheRoot, 'config'),
  ENTIRE_PLUGIN_DIR: join(cacheRoot, 'plugins'),
  XDG_CACHE_HOME: join(cacheRoot, 'cache'),
  PATH: `${binDir}:${process.env.PATH ?? ''}`,
};

async function install() {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const asset = `entire_${process.platform}_${arch}.tar.gz`;
  const url = `https://github.com/entireio/cli/releases/download/v${version}/${asset}`;
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Official release download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== checksums[platform]) throw new Error('Entire release checksum mismatch; installation stopped.');
  const archive = join(binDir, asset);
  await writeFile(archive, bytes, { mode: 0o600 });
  const extraction = spawnSync('tar', ['-xzf', archive, '-C', binDir, 'entire', 'git-remote-entire'], { encoding: 'utf8' });
  if (extraction.status !== 0) throw new Error('Could not extract the two official release executables.');
  for (const name of ['entire', 'git-remote-entire']) {
    const path = join(binDir, name);
    if (!(await lstat(path)).isFile()) throw new Error('Unexpected executable type in the release archive.');
    await chmod(path, 0o700);
  }
  await writeFile(join(binDir, 'receipt.json'), JSON.stringify({ version, asset, url, sha256: actual, installedAt: new Date().toISOString() }, null, 2));
  const result = spawnSync(binary, ['version'], { env: environment, encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.includes(`Entire CLI ${version}`)) throw new Error('Installed Entire version did not match the pinned release.');
  process.stdout.write(result.stdout);
  console.log(`Verified official release SHA-256: ${actual}`);
}

try {
  const args = process.argv.slice(2);
  if (args[0] === '--install') {
    await install();
  } else {
    await readFile(join(binDir, 'receipt.json'));
    const result = spawnSync(binary, args.length ? args : ['help'], { env: environment, stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  console.error(error?.code === 'ENOENT' ? 'Install the pinned Entire CLI first: npm run entire:install' : error.message);
  process.exitCode = 1;
}
