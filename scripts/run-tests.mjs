import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const files = [];

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(entryPath);
    } else if (entry.name.endsWith('.test.ts')) {
      files.push(entryPath);
    }
  }
}

walk(join(root, 'test'));
files.sort();

const args = ['--require', 'ts-node/register', '--test'];
if (process.argv.includes('--coverage')) {
  args.push('--experimental-test-coverage');
}
args.push(...files);

const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
