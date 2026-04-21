import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { config } from '../src/config.js';
import { restoreDatabaseFromJson } from './db_json.js';

function usage(): never {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/run.mjs db-restore-json --file <path> [--yes] [--batch-size <n>]');
  process.exit(2);
}

function parseArgs(argv: string[]): { file: string; yes: boolean; batchSize: number | undefined } {
  let file = '';
  let yes = false;
  let batchSize: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    if (a === '--yes' || a === '-y') {
      yes = true;
      continue;
    }
    if (a.startsWith('--file=')) {
      file = a.slice('--file='.length).trim();
      continue;
    }
    if (a === '--file') {
      file = String(argv[i + 1] ?? '').trim();
      i += 1;
      continue;
    }
    if (a.startsWith('--batch-size=')) {
      batchSize = Number(a.slice('--batch-size='.length));
      continue;
    }
    if (a === '--batch-size') {
      batchSize = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (!a.startsWith('-') && !file) {
      file = a;
      continue;
    }
  }

  if (!file) usage();
  if (batchSize !== undefined && (!Number.isFinite(batchSize) || batchSize <= 0)) {
    throw new Error('Invalid --batch-size.');
  }

  return { file, yes, batchSize };
}

async function confirmRestore(file: string): Promise<boolean> {
  if (!input.isTTY) return false;
  const rl = readline.createInterface({ input, output });
  try {
    // eslint-disable-next-line no-console
    console.log(`About to restore backup from ${file}.`);
    // eslint-disable-next-line no-console
    console.log('This will DELETE existing data in app tables before restore.');
    const ans = (await rl.question('Type "restore" to continue: ')).trim().toLowerCase();
    return ans === 'restore';
  } finally {
    rl.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.yes) {
    const ok = await confirmRestore(args.file);
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error('Restore cancelled. Pass --yes to skip confirmation.');
      process.exit(1);
    }
  }

  const res = await restoreDatabaseFromJson({
    databaseUrl: config.databaseUrl,
    file: args.file,
    batchSize: args.batchSize
  });

  // eslint-disable-next-line no-console
  console.log(`[db-restore-json] restored file=${res.file}`);
  // eslint-disable-next-line no-console
  console.log(`[db-restore-json] tables=${res.tables} rows=${res.rows}`);
  for (const [table, count] of Object.entries(res.rowCounts)) {
    // eslint-disable-next-line no-console
    console.log(`[db-restore-json] ${table}=${count}`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
