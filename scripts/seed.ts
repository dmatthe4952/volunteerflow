import { createDb } from '../src/db.js';
import { config } from '../src/config.js';
import { hashPassword } from '../src/auth.js';

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 120);
}

async function main() {
  if (config.env === 'production') {
    throw new Error('Seed script is not allowed in production.');
  }

  const db = createDb();
  try {
    const adminEmail = 'admin@example.com';
    const managerEmail = 'manager@example.com';
    const adminPassword = 'dev-admin-password';
    const managerPassword = 'dev-manager-password';

    const admin = await db
      .insertInto('users')
      .values({
        email: adminEmail,
        password_hash: hashPassword(adminPassword),
        display_name: 'Dev Admin',
        role: 'super_admin',
        is_active: true
      })
      .onConflict((oc) =>
        oc.column('email_norm').doUpdateSet({ display_name: 'Dev Admin', is_active: true, password_hash: hashPassword(adminPassword) })
      )
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const manager = await db
      .insertInto('users')
      .values({
        email: managerEmail,
        password_hash: hashPassword(managerPassword),
        display_name: 'Dev Manager',
        role: 'event_manager',
        is_active: true
      })
      .onConflict((oc) =>
        oc
          .column('email_norm')
          .doUpdateSet({ display_name: 'Dev Manager', is_active: true, password_hash: hashPassword(managerPassword) })
      )
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const orgName = 'VolunteerFlow Demo';
    const orgSlug = slugify(orgName);
    const org = await db
      .insertInto('organizations')
      .values({
        name: orgName,
        slug: orgSlug,
        primary_color: '#4DD4AC',
        contact_email: 'volunteers@example.com',
        created_by: admin.id
      })
      .onConflict((oc) => oc.column('slug').doUpdateSet({ name: orgName, created_by: admin.id }))
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const start = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const yyyy = start.getUTCFullYear();
    const mm = String(start.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(start.getUTCDate()).padStart(2, '0');
    const startDate = `${yyyy}-${mm}-${dd}`;

    const eventTitle = 'Community Food Drive';
    const eventSlug = slugify(eventTitle);
    const event = await db
      .insertInto('events')
      .values({
        organization_id: org.id,
        manager_id: manager.id,
        slug: eventSlug,
        title: eventTitle,
        description_html:
          '<p>Help us pack and distribute food boxes for local families. Please choose one shift.</p><p><strong>Wear closed-toe shoes.</strong></p>',
        location_name: '123 Main St, Greenville SC',
        location_map_url: 'https://maps.google.com/',
        event_type: 'one_time',
        start_date: startDate,
        end_date: startDate,
        is_published: true,
        is_archived: false
      })
      .onConflict((oc) => oc.column('slug').doUpdateSet({ title: eventTitle, is_published: true, is_archived: false }))
      .returning(['id'])
      .executeTakeFirstOrThrow();

    // Reset shifts for idempotent seeding.
    await db.deleteFrom('shifts').where('event_id', '=', event.id).execute();

    const shifts = [
      { role: 'Set Up', start: '08:00:00', end: '10:00:00', dur: 120, min: 2, max: 6 },
      { role: 'Packing', start: '10:00:00', end: '12:00:00', dur: 120, min: 4, max: 10 },
      { role: 'Clean Up', start: '12:00:00', end: '13:00:00', dur: 60, min: 2, max: 6 }
    ] as const;

    for (const s of shifts) {
      await db
        .insertInto('shifts')
        .values({
          event_id: event.id,
          role_name: s.role,
          role_description: null,
          duration_minutes: s.dur,
          shift_date: startDate,
          start_time: s.start,
          end_time: s.end,
          min_volunteers: s.min,
          max_volunteers: s.max,
          is_active: true
        })
        .execute();
    }

    // eslint-disable-next-line no-console
    console.log('Seeded demo data:');
    // eslint-disable-next-line no-console
    console.log(`- Event: ${eventTitle} (${config.appUrl}/events/${eventSlug})`);
    // eslint-disable-next-line no-console
    console.log(`- Admin: ${adminEmail} (password=${adminPassword})`);
    // eslint-disable-next-line no-console
    console.log(`- Manager: ${managerEmail} (password=${managerPassword})`);
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
