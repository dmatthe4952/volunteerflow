import readline from 'node:readline/promises';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { config } from '../src/config.js';
import { runMigrations } from '../src/migrations.js';
import { findLatestBackupFile, restoreDatabaseFromJson } from './db_json.js';

type InitMode = 'empty' | 'restore';

function usage(): never {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/run.mjs db-init [--mode empty|restore] [--file <backup.json>] [--yes]');
  process.exit(2);
}

function parseArgs(argv: string[]): { mode: InitMode | null; file: string | null; yes: boolean } {
  let mode: InitMode | null = null;
  let file: string | null = null;
  let yes = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';

    if (a === '--yes' || a === '-y') {
      yes = true;
      continue;
    }

    if (a.startsWith('--mode=')) {
      const raw = a.slice('--mode='.length).trim();
      if (raw === 'empty' || raw === 'restore') mode = raw;
      else usage();
      continue;
    }

    if (a === '--mode') {
      const raw = String(argv[i + 1] ?? '').trim();
      if (raw === 'empty' || raw === 'restore') mode = raw;
      else usage();
      i += 1;
      continue;
    }

    if (a.startsWith('--file=')) {
      file = a.slice('--file='.length).trim() || null;
      continue;
    }

    if (a === '--file') {
      file = String(argv[i + 1] ?? '').trim() || null;
      i += 1;
      continue;
    }
  }

  return { mode, file, yes };
}

async function promptMode(): Promise<InitMode> {
  const rl = readline.createInterface({ input, output });
  try {
    // eslint-disable-next-line no-console
    console.log('Select initialization mode:');
    // eslint-disable-next-line no-console
    console.log('  1) no data (schema only)');
    // eslint-disable-next-line no-console
    console.log('  2) recover from JSON backup');
    const ans = (await rl.question('Enter 1 or 2: ')).trim();
    if (ans === '2') return 'restore';
    return 'empty';
  } finally {
    rl.close();
  }
}

async function promptRestoreFile(suggested: string | null): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const prompt = suggested
      ? `Backup JSON path [default: ${suggested}]: `
      : 'Backup JSON path: ';
    const ans = (await rl.question(prompt)).trim();
    return ans || suggested || '';
  } finally {
    rl.close();
  }
}

async function confirmRestore(file: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    // eslint-disable-next-line no-console
    console.log(`Will restore backup from: ${file}`);
    // eslint-disable-next-line no-console
    console.log('This will delete current data in app tables before restore.');
    const ans = (await rl.question('Type "restore" to continue: ')).trim().toLowerCase();
    return ans === 'restore';
  } finally {
    rl.close();
  }
}

function maybeRedactDatabaseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<invalid DATABASE_URL>';
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let mode = args.mode;
  if (!mode) {
    if (!input.isTTY) {
      throw new Error('Missing --mode in non-interactive shell. Use --mode empty|restore.');
    }
    mode = await promptMode();
  }

  // eslint-disable-next-line no-console
  console.log(`[db-init] target=${maybeRedactDatabaseUrl(config.databaseUrl)}`);
  // eslint-disable-next-line no-console
  console.log('[db-init] running migrations...');

  await runMigrations({
    databaseUrl: config.databaseUrl,
    migrationsDir: path.join(process.cwd(), 'migrations'),
    log: (line) => {
      // eslint-disable-next-line no-console
      console.log(`[db-init] ${line}`);
    }
  });

  if (mode === 'empty') {
    // eslint-disable-next-line no-console
    console.log('[db-init] completed (schema ready, no data restore requested).');
    return;
  }

  let file = args.file;
  if (!file) {
    const latest = await findLatestBackupFile();
    if (!input.isTTY) {
      if (!latest) throw new Error('No backup file specified and no backup JSON found under ./backups.');
      file = latest;
    } else {
      file = await promptRestoreFile(latest);
    }
  }

  if (!file) throw new Error('Backup file path is required for restore mode.');

  if (!args.yes) {
    if (!input.isTTY) throw new Error('Restore requires --yes in non-interactive mode.');
    const ok = await confirmRestore(file);
    if (!ok) {
      throw new Error('Restore cancelled.');
    }
  }

  const res = await restoreDatabaseFromJson({
    databaseUrl: config.databaseUrl,
    file
  });

  // eslint-disable-next-line no-console
  console.log(`[db-init] restore complete tables=${res.tables} rows=${res.rows}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
