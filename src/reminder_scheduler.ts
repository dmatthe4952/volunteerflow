import type { Kysely } from 'kysely';
import type { DB } from './db.js';
import { sendUpcomingShiftReminders } from './notifications.js';

function normalizeOffsets(offsets: number[]): number[] {
  const uniq = new Set<number>();
  for (const raw of offsets) {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 0 || n > 336) continue;
    uniq.add(n);
  }
  return Array.from(uniq).sort((a, b) => a - b);
}

export async function runReminderScheduler(params: {
  db: Kysely<DB>;
  dryRun?: boolean;
  limitPerOffset?: number;
  offsets?: number[];
}) {
  const offsets =
    Array.isArray(params.offsets) && params.offsets.length
      ? normalizeOffsets(params.offsets)
      : normalizeOffsets(
          (
            await params.db
              .selectFrom('reminder_rules')
              .select('send_offset_hours')
              .where('is_active', '=', true)
              .groupBy('send_offset_hours')
              .execute()
          ).map((r: any) => Number(r.send_offset_hours))
        );

  const results: Array<{ offsetHours: number; considered: number; wouldSend: number; skippedAlreadySent: number; kind: string }> = [];
  let totalConsidered = 0;
  let totalWouldSend = 0;
  let totalSkippedAlreadySent = 0;

  for (const offsetHours of offsets) {
    const res = await sendUpcomingShiftReminders({
      db: params.db,
      offsetHours,
      dryRun: params.dryRun,
      limit: params.limitPerOffset
    });
    results.push({ offsetHours, ...res });
    totalConsidered += res.considered;
    totalWouldSend += res.wouldSend;
    totalSkippedAlreadySent += res.skippedAlreadySent;
  }

  return {
    offsets,
    offsetCount: offsets.length,
    totalConsidered,
    totalWouldSend,
    totalSkippedAlreadySent,
    results
  };
}
