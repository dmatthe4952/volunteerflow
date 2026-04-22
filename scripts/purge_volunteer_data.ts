import { createDb } from '../src/db.js';
import { purgeExpiredVolunteerPII } from '../src/purge.js';

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

function readArg(name: string): string | null {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return typeof args[idx + 1] === 'string' ? args[idx + 1] : '';
}

async function main() {
  const dryRun = hasFlag('--dry-run');
  const limitRaw = readArg('--limit');
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limitRaw && (!Number.isFinite(limit as number) || (limit as number) <= 0)) throw new Error('Invalid --limit value.');

  const db = createDb();
  try {
    const res = await purgeExpiredVolunteerPII({ db, dryRun, limit });
    // eslint-disable-next-line no-console
    console.log(
      `[purge-volunteer-data] today=${res.todayLocal} defaultDays=${res.defaultPurgeDays} considered=${res.considered} eligible=${res.eligible} ${dryRun ? 'dryRun=1' : `purgedEvents=${res.purgedEvents} deletedSignups=${res.deletedSignups} deletedNotificationSends=${res.deletedNotificationSends}`}`
    );
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
