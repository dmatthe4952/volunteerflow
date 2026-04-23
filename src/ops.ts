import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { config } from './config.js';
import type { DB } from './db.js';
import { sendEmail } from './email.js';

export function requireAdminToken(req: any) {
  const token = req?.headers?.['x-admin-token'];
  if (!config.adminToken) throw new Error('ADMIN_TOKEN is not configured on the server.');
  if (typeof token !== 'string' || token !== config.adminToken) {
    const err: any = new Error('Forbidden');
    err.statusCode = 403;
    throw err;
  }
}

export async function cancelEventAndNotify(params: { db: Kysely<DB>; slugOrId: string; message: string }) {
  const cancellationMessage = params.message.trim().slice(0, 4000);
  if (!cancellationMessage) throw new Error('Cancellation message is required.');

  const event = await params.db
    .selectFrom('events')
    .innerJoin('organizations', 'organizations.id', 'events.organization_id')
    .select([
      'events.id',
      'events.slug',
      'events.title',
      'events.location_name',
      'events.location_map_url',
      'events.cancelled_at',
      'organizations.name as organization_name'
    ])
    .where(sql<boolean>`(events.slug = ${params.slugOrId} or events.id::text = ${params.slugOrId})`)
    .executeTakeFirst();

  if (!event) throw new Error('Event not found.');
  if (event.cancelled_at) {
    return { alreadyCancelled: true as const, notified: 0 };
  }

  await params.db
    .updateTable('events')
    .set({ cancelled_at: new Date().toISOString(), cancellation_message: cancellationMessage })
    .where('id', '=', event.id)
    .execute();

  const signups = await params.db
    .selectFrom('signups')
    .innerJoin('shifts', 'shifts.id', 'signups.shift_id')
    .select([
      'signups.id as signup_id',
      'signups.email',
      'signups.first_name',
      'signups.cancel_token',
      'shifts.role_name',
      'shifts.shift_date',
      'shifts.start_time',
      'shifts.end_time'
    ])
    .where('signups.status', '=', 'active')
    .where('shifts.event_id', '=', event.id)
    .execute();

  let notified = 0;
  for (const s of signups) {
    const cancelUrl = s.cancel_token ? `${config.appUrl}/cancel/${encodeURIComponent(s.cancel_token)}` : '';
    const subject = `[CANCELLED] ${event.title}`;
    const text = [
      `Hello ${s.first_name},`,
      '',
      `The following event has been cancelled:`,
      `${event.title} (${event.organization_name})`,
      '',
      `Your signup: ${s.role_name} on ${String(s.shift_date)} at ${String(s.start_time)}–${String(s.end_time)}`,
      event.location_name ? `Location: ${event.location_name}` : '',
      event.location_map_url ? `Map: ${event.location_map_url}` : '',
      '',
      `Message from the organizer:`,
      cancellationMessage,
      '',
      cancelUrl ? `If you still need to cancel your signup record: ${cancelUrl}` : '',
      '',
      `— LocalShifts`
    ]
      .filter((line) => line !== '')
      .join('\n');

    const inserted = await params.db
      .insertInto('notification_sends')
      .values({
        kind: 'event_cancelled',
        event_id: event.id,
        signup_id: s.signup_id,
        to_email: s.email,
        subject,
        body: text,
        status: 'queued'
      })
      .onConflict((oc) => oc.columns(['kind', 'signup_id']).doNothing())
      .returning(['id'])
      .executeTakeFirst();

    if (!inserted) continue; // already sent

    try {
      await sendEmail({ to: s.email, subject, text }, { db: params.db });
      notified++;
      await params.db
        .updateTable('notification_sends')
        .set({ status: 'sent', sent_at: new Date().toISOString(), error: null })
        .where('id', '=', inserted.id)
        .execute();
    } catch (err: any) {
      await params.db
        .updateTable('notification_sends')
        .set({ status: 'failed', error: String(err?.message ?? err) })
        .where('id', '=', inserted.id)
        .execute();
    }
  }

  return { alreadyCancelled: false as const, notified };
}
