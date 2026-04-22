import { createDb } from '../src/db.js';
import { runReminderScheduler } from '../src/reminder_scheduler.js';
import { sleep } from '../src/retry.js';

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

function readArg(name: string): string | null {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return typeof args[idx + 1] === 'string' ? args[idx + 1] : '';
}

function parseOffsets(raw: string | null): number[] {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  return text
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.floor(n));
}

async function runOnce(db: any, opts: { dryRun: boolean; limitPerOffset?: number; offsets?: number[] }) {
  const res = await runReminderScheduler({
    db,
    dryRun: opts.dryRun,
    limitPerOffset: opts.limitPerOffset,
    offsets: opts.offsets
  });

  // eslint-disable-next-line no-console
  console.log(
    `[reminder-scheduler] offsets=${res.offsetCount} considered=${res.totalConsidered} ${opts.dryRun ? `wouldSend=${res.totalWouldSend}` : `skippedAlreadySent=${res.totalSkippedAlreadySent}`}`
  );
  for (const row of res.results) {
    // eslint-disable-next-line no-console
    console.log(
      `[reminder-scheduler] offset=${row.offsetHours}h kind=${row.kind} considered=${row.considered} ${opts.dryRun ? `wouldSend=${row.wouldSend}` : `skippedAlreadySent=${row.skippedAlreadySent}`}`
    );
  }
}

async function main() {
  const dryRun = hasFlag('--dry-run');
  const loop = hasFlag('--loop');
  const limitRaw = readArg('--limit-per-offset');
  const limitPerOffset = limitRaw ? Number(limitRaw) : undefined;
  const intervalRaw = readArg('--interval-minutes');
  const intervalMinutes = intervalRaw ? Number(intervalRaw) : 15;
  const offsets = parseOffsets(readArg('--offsets'));

  if (limitRaw && (!Number.isFinite(limitPerOffset as number) || (limitPerOffset as number) <= 0)) {
    throw new Error('Invalid --limit-per-offset value.');
  }
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    throw new Error('Invalid --interval-minutes value.');
  }

  const db = createDb();
  try {
    if (!loop) {
      await runOnce(db, { dryRun, limitPerOffset, offsets: offsets.length ? offsets : undefined });
      return;
    }

    // eslint-disable-next-line no-console
    console.log(`[reminder-scheduler] loop mode started interval=${intervalMinutes}m dryRun=${dryRun}`);
    for (;;) {
      const started = Date.now();
      try {
        await runOnce(db, { dryRun, limitPerOffset, offsets: offsets.length ? offsets : undefined });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[reminder-scheduler] run failed', err);
      }
      const elapsed = Date.now() - started;
      const waitMs = Math.max(0, Math.round(intervalMinutes * 60_000 - elapsed));
      await sleep(waitMs);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
