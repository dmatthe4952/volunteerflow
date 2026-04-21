import { config } from '../src/config.js';
import { backupDatabaseToJson } from './db_json.js';

function parseOutArg(argv: string[]): string | undefined {
  const outFlag = argv.find((a) => a.startsWith('--out='));
  if (outFlag) return outFlag.slice('--out='.length).trim() || undefined;

  const outIdx = argv.findIndex((a) => a === '--out');
  if (outIdx >= 0) return argv[outIdx + 1]?.trim() || undefined;

  return undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const outFile = parseOutArg(args);

  const res = await backupDatabaseToJson({
    databaseUrl: config.databaseUrl,
    outFile
  });

  // eslint-disable-next-line no-console
  console.log(`[db-backup-json] wrote ${res.outFile}`);
  // eslint-disable-next-line no-console
  console.log(`[db-backup-json] tables=${res.tables} rows=${res.rows}`);
  for (const [table, count] of Object.entries(res.rowCounts)) {
    // eslint-disable-next-line no-console
    console.log(`[db-backup-json] ${table}=${count}`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
