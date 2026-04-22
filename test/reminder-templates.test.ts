import { describe, expect, test } from 'vitest';
import { buildReminderTemplateContext, renderReminderTemplate } from '../src/reminder_templates.js';

describe('reminder template merge tags', () => {
  test('builds all supported tags and renders a template', () => {
    const ctx = buildReminderTemplateContext({
      volunteerFirstName: 'Ada',
      volunteerLastInitial: 'L',
      eventTitle: 'Neighborhood Canvass',
      eventDescriptionHtml: '<p>Knock doors<br/>Bring water</p>',
      organizationName: 'Test Org',
      shiftRole: 'Greeter',
      shiftDate: '2026-05-03',
      shiftStartTime: '09:00:00',
      shiftEndTime: '11:00:00',
      locationName: '123 Main St',
      locationMapUrl: 'https://maps.example.com',
      cancelUrl: 'https://local/cancel/abc',
      eventUrl: 'https://local/events/slug',
      managerName: 'Pat Manager',
      managerEmail: 'pat@example.com'
    });

    const rendered = renderReminderTemplate(
      [
        'Hi {{ volunteer_first_name }} {{ volunteer_last_initial }}',
        '{{ event_title }}',
        '{{ event_description_plain }}',
        '{{ organization_name }}',
        '{{ shift_role }}',
        '{{ shift_date }}',
        '{{ shift_start_time }} {{ shift_end_time }} {{ shift_duration }}',
        '{{ location_name }}',
        '{{ location_map_url }}',
        '{{ cancel_url }}',
        '{{ event_url }}',
        '{{ manager_name }}',
        '{{ manager_email }}'
      ].join('\n'),
      ctx
    );

    expect(rendered).toContain('Hi Ada L');
    expect(rendered).toContain('Neighborhood Canvass');
    expect(rendered).toContain('Knock doors');
    expect(rendered).toContain('Bring water');
    expect(rendered).toContain('Test Org');
    expect(rendered).toContain('Greeter');
    expect(rendered).toContain('Sunday, May 3, 2026');
    expect(rendered).toContain('9:00 AM');
    expect(rendered).toContain('11:00 AM');
    expect(rendered).toContain('2 hours');
    expect(rendered).toContain('123 Main St');
    expect(rendered).toContain('https://maps.example.com');
    expect(rendered).toContain('https://local/cancel/abc');
    expect(rendered).toContain('https://local/events/slug');
    expect(rendered).toContain('Pat Manager');
    expect(rendered).toContain('pat@example.com');
  });

  test('unknown merge keys resolve to empty string', () => {
    const ctx = buildReminderTemplateContext({});
    const rendered = renderReminderTemplate('A{{ unknown_key }}B', ctx);
    expect(rendered).toBe('AB');
  });
});
