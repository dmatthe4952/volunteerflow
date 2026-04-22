**Local Shifts**

Self-Hosted Volunteer Shift Signup System

Product Requirements Document | v2.21 | April 17, 2026

**1. Purpose & Scope**

**Local Shifts is a lightweight, self-hosted web application that replaces commercial services like SignupGenius for organizations that recruit volunteers for time-slotted events. It is designed to run in Docker on a standard VPS and targets a single organization that manages events on behalf of themselves and partner organizations.**

Local Shifts is developed for and by Indivisible Upstate SC (IUSC) and its Voter Engagement Team (VET), but is architected generically so any similar organization can self-host it.

**Scope policy: This platform is intended exclusively for PUBLIC activities — canvassing events, phone banks, food bank signups, protest marshaling, river cleanups, and similar open civic activities. It is NOT intended for private, members-only, or operationally sensitive events where volunteer lists would create legal or safety risk if subpoenaed.**

**Core design principles:**

* Security-first: no WordPress, no plugin ecosystem attack surface; minimal dependencies
* Frictionless volunteer experience: sign up with only a name and email — no account creation, no login
* Privacy by default: first name + last initial only; volunteers may use aliases; data purged automatically after events
* Operator control: all data stays on your server; no third-party SaaS dependency
* Low maintenance: containerized, auto-updating reminder emails, straightforward backup

**2. User Roles**

**2.1 Role Overview**

| **Role** | **Description** | **Authentication** |
| --- | --- | --- |
| Admin | Single system owner. Creates Event Manager accounts, manages global settings, and has full manager capabilities — can create and manage events directly and can impersonate any Event Manager to view their perspective. | Username + password + optional 2FA |
| Event Manager | Assigned by Admin. Creates and manages their own events, views volunteer signups, sends broadcasts. | Username + password |
| Volunteer | Any member of the public. Signs up for shifts using only first name + last initial. No account required. Aliases are explicitly permitted. | None (token-based cancel links only) |

**2.2 User Narratives**

**Volunteer**

I want to find volunteering opportunities near me. I visit the homepage and the app detects my approximate location from my IP address and shows a banner: "Showing events near Greenville, SC." If that's wrong, I click it and type in my zip code, then pick a radius — maybe 10 miles, maybe 20. The event list updates to show only what's nearby.

I browse events sorted by date, with any featured ones pinned at the top. Each card shows the event name, organization, date, location, and tags like 'Canvassing' or 'Food Bank.' I can filter by tag if I'm looking for something specific.

I click into an event and see the full description, the location with a map link, and a list of shifts with their roles, times, and how many slots are still open. I find a shift that works and click 'Sign Me Up.' A small form asks for my first name, last initial, and email address. A note tells me I can use a nickname or alias — no one's checking. I submit and immediately get a confirmation email with all the details.

Before my shift I get reminder emails. If something comes up and I need to cancel, there's a one-click cancel button right in the email — no login, no hunting around. If I want to see everything I'm currently signed up for across all events, there's a link in any email that says 'View all my signups.' I click it, enter my email, and get a link sent to me. I click the link and see everything at a glance, with the option to cancel any of them from that same page.

**Event Manager**

I manage events for a local organization. I log in and my dashboard shows me everything at once: upcoming shifts, open slots, and any alerts about shifts that are running low on volunteers.

Creating a new event is quick. I pick my organization from a dropdown and its logo and color scheme are automatically applied — all my events have the same look without any extra work. I fill in the event details, upload an image if I have one, and add shifts using role templates I've saved: 'Setup Crew,' 'Check-In,' 'Distribution.' I set a minimum and maximum volunteer count per shift. Before I publish, I set up two reminder emails using the default templates — one 24 hours out, one 2 hours before — and customize the text slightly.

Once the event is live, I get an email every time someone signs up or cancels. If a cancellation drops a shift below my minimum, the notification flags it as urgent. I can check the full roster at any time, manually add someone who signed up by phone, or remove someone if needed. If I need to send a last-minute update to everyone, I use the broadcast feature.

If I have to cancel the whole event, I enter a message explaining why, confirm, and the system emails everyone who's signed up. I don't have to send individual emails or go find their addresses.

**Admin**

I set up the platform once and mostly stay out of the way. I configure the SMTP connection, set the system-wide default for how long volunteer data is kept after an event, and create the organizations with their logos and brand colors. When a new manager joins, I create their account, assign them to an organization, and they're ready to go.

From my dashboard I can see everything happening across all managers and events. I can access any event directly — I don't need to impersonate anyone just to fix a typo or check a roster. If I want to see exactly what a manager sees, I can enter their view with one click; a banner reminds me whose view I'm in and I can exit any time. Those sessions are logged.

When someone submits a public event request via the website form, I get an email with their details already filled in. I decide what to do with it: forward it to the right manager, create a new organization and manager account and invite the submitter to take over, or set it aside. There's no approval queue — I handle it however makes sense for that situation.

**3. Recommended Technology Stack**

| **Layer** | **Technology** | **Rationale** |
| --- | --- | --- |
| Language | TypeScript (compiled to Node.js) | Type-safe development; catches schema mismatches at compile time; minimal runtime overhead |
| Runtime | Node.js 20 LTS | Excellent async I/O for email + web; huge ecosystem; LTS stability |
| Web Framework | Fastify | Faster than Express; built-in schema validation; low overhead |
| Templating | Nunjucks (server-rendered HTML) | No client-side framework needed; simpler security model; fast page loads |
| Database | PostgreSQL 16 | Relational model fits events/shifts/signups perfectly; ACID; excellent Docker image |
| ORM / Query | Kysely | Type-safe SQL query builder; no magic; easy to audit; no heavy ORM abstraction |
| Email | Nodemailer + SMTP | Works with PurelyMail or any SMTP relay; no vendor lock-in |
| Job Scheduler | pg-boss | Postgres-backed job queue for reminder emails; no separate Redis needed |
| File Storage | Local filesystem (Docker volume) | Event images stored on disk; simple; no S3 complexity for small scale |
| CSS | Tailwind CSS (CDN build) | Utility-first; no build step needed at CDN scale; clean responsive UI |
| Reverse Proxy | Traefik v3 | Automatic HTTPS via Let's Encrypt; label-based Docker routing; actively maintained |
| Containerization | Docker Compose | Single compose file; easy deploy; reproducible environment |
| IP Geolocation | MaxMind GeoLite2 (local DB) | Free offline database; no external API call; queried locally for IP-to-city lookup on homepage. Updated via periodic download. |
| Address Geocoding | Nominatim (OpenStreetMap API) | Free geocoding API; called at event save time to resolve location\_name to lat/lng. Rate limit: 1 req/sec — sufficient for event creation. |

Traefik handles TLS termination automatically via Let's Encrypt. The Node app listens on an internal port (3000) and is never exposed directly to the internet.

**4. Data Model**

**4.1 Organizations (Schemes)**

**An Organization represents a named entity (your org or a partner org) under which events can be grouped. It provides customizable branding per event context.**

| **Field** | **Type** | **Notes** |
| --- | --- | --- |
| id | UUID (PK) |  |
| name | varchar(120) | e.g. 'Greenville Food Bank' |
| slug | varchar(60) | URL-safe identifier, e.g. 'greenville-food-bank' |
| logo\_url | varchar(255) | Optional logo image path |
| primary\_color | char(7) | Hex color for event page theming, e.g. '#2E86C1' |
| contact\_email | varchar(120) | Default reply-to for this org's events |
| created\_by | UUID (FK → users) | Admin or Event Manager who created it |
| created\_at | timestamptz |  |

**4.2 Events**

| **Field** | **Type** | **Notes** |
| --- | --- | --- |
| id | UUID (PK) |  |
| organization\_id | UUID (FK → organizations) | Which org this event belongs to |
| manager\_id | UUID (FK → users) | Event Manager responsible |
| title | varchar(200) |  |
| description | text | Rich text (HTML); shown on public event page |
| location\_name | varchar(200) | Human-readable address, e.g. '123 Main St, Greenville SC' |
| location\_lat | decimal(9,6) (nullable) | Latitude, geocoded from location\_name at save time via Nominatim. Null if geocoding fails. |
| location\_lng | decimal(9,6) (nullable) | Longitude, geocoded from location\_name at save time via Nominatim. Null if geocoding fails. |
| location\_map\_url | varchar(500) | Full Google Maps URL (copy-paste from browser) |
| image\_path | varchar(255) | Path to uploaded event image on server |
| event\_type | enum('one\_time','recurring') |  |
| recurrence\_rule | varchar(200) | iCal RRULE string for recurring events; null for one-time |
| start\_date | date | First (or only) occurrence date |
| end\_date | date | Last occurrence date for recurring; same as start\_date for one-time |
| is\_published | boolean | false = draft, not shown on public listing |
| is\_archived | boolean | true = hidden from listings, data retained |
| is\_featured | boolean | true = shown prominently at top of homepage. Default: false |
| cancelled\_at | timestamptz (nullable) | Set when manager cancels the event. Null = active. |
| cancellation\_message | text (nullable) | Required message entered by manager when cancelling; sent to all active signups. |
| confirmation\_email\_note | text (nullable) | Optional extra note appended to the signup confirmation email for this event. Useful for parking instructions, what to wear, etc. |
| purge\_after\_days | integer (nullable) | Days after last shift to purge volunteer PII. Null = use system default. Can be set by Event Managers or Admin at event creation/edit time. |
| created\_at | timestamptz |  |
| updated\_at | timestamptz |  |

**4.3 Shifts**

**A Shift is one time slot within an event. An event can have many shifts. For recurring events, each occurrence generates its own set of Shift rows.**

| **Field** | **Type** | **Notes** |
| --- | --- | --- |
| id | UUID (PK) |  |
| event\_id | UUID (FK → events) |  |
| role\_name | varchar(120) | e.g. 'Set Up' — drawn from Role Templates or entered freely |
| role\_description | varchar(500) | Optional: e.g. 'Arrange tables and chairs, bring gloves' |
| duration\_minutes | integer | e.g. 120 for a 2-hour shift |
| shift\_date | date | The actual calendar date of this shift occurrence |
| start\_time | time |  |
| end\_time | time | Derived from start\_time + duration, or set manually |
| min\_volunteers | integer | Soft minimum; shown to manager as 'understaffed' warning |
| max\_volunteers | integer | Hard cap; signup blocked when reached |
| is\_active | boolean | Manager can pause a shift without deleting it |

**4.4 Signups**

| **Field** | **Type** | **Notes** |
| --- | --- | --- |
| id | UUID (PK) |  |
| shift\_id | UUID (FK → shifts) |  |
| first\_name | varchar(80) |  |
| last\_initial | char(1) | Volunteer's last initial. Aliases explicitly permitted — noted in UI. |
| email | varchar(120) | Stored; never shown publicly |
| cancel\_token | varchar(64) | Unique random token; embedded in cancellation URLs in emails |
| cancel\_token\_expires\_at | timestamptz | Tokens expire 7 days after the event date |
| cancelled\_at | timestamptz | Null = active signup; not-null = cancelled |
| cancellation\_note | text | Optional note from volunteer when cancelling |
| created\_at | timestamptz | Signup timestamp |

No password, no account, no login. The cancel token embedded in each email is the volunteer's only credential.

**4.5 Tags**

**Tags are short labels applied to events for categorization and public filtering. Multiple tags can be applied to a single event. Both Admin and Event Managers can create tags. System-reserved tags are automatically managed by the application and cannot be deleted by users.**

| **Field** | **Type** | **Notes** |
| --- | --- | --- |
| id | UUID (PK) |  |
| name | varchar(50) | Display name, e.g. 'Understaffed', 'Urgent', 'Canvassing', 'Food Bank' |
| slug | varchar(50) | URL-safe, lowercase identifier, e.g. 'understaffed', 'canvassing' |
| is\_system | boolean | true = reserved tag managed automatically by the application. Cannot be deleted by users. Default: false. |
| created\_by | UUID (FK → users) | Admin or Event Manager who created it; null for system tags |
| created\_at | timestamptz |  |

**4.6 EventTags**

**Junction table linking Tags to Events. An event can have many tags; a tag can be applied to many events.**

| **Field** | **Type** | **Notes** |
| --- | --- | --- |
| event\_id | UUID (FK → events) | Composite primary key |
| tag\_id | UUID (FK → tags) | Composite primary key |

**4.7 Role Templates**

**Role Templates are reusable shift definitions managed by an Event Manager. When creating an event, managers can pick from their templates to pre-fill shift fields rather than typing from scratch each time.**

| **Field** | **Type** | **Notes** |
| --- | --- | --- |
| id | UUID (PK) |  |
| manager\_id | UUID (FK → users) | Templates are per-manager (not global) |
| role\_name | varchar(120) | e.g. 'Set Up' |
| role\_description | varchar(500) | e.g. 'Arrange tables and chairs' |
| duration\_minutes | integer | Default duration in minutes |
| default\_min\_volunteers | integer |  |
| default\_max\_volunteers | integer |  |

**4.8 Reminder Rules**

**Each event can have up to 3 reminder rules. A background job evaluates these daily and sends emails to active (non-cancelled) signups for upcoming shifts.**

| **Field** | **Type** | **Notes** |
| --- | --- | --- |
| id | UUID (PK) |  |
| event\_id | UUID (FK → events) |  |
| send\_offset\_hours | integer | Hours before shift start to send reminder. e.g. 24 = 1 day before, 4 = morning-of |
| subject\_template | varchar(300) | Email subject with merge tags |
| body\_template | text | Email body with merge tags (HTML supported) |
| is\_active | boolean | Manager can disable a rule without deleting it |

**4.9 Notification Sends (email audit log)**

**A unified outgoing email log. Every email the system sends — confirmations, reminders, cancellations, broadcasts, and event cancellation notices — is recorded here. Provides deduplication (via the kind + signup\_id unique index), delivery status tracking, and a full audit trail. Supersedes a narrower 'sent\_reminders' deduplication-only approach.**

| **Field** | **Type** | **Notes** |
| --- | --- | --- |
| id | UUID (PK) |  |
| kind | text | e.g. 'signup\_confirmation', 'reminder', 'cancellation\_confirm', 'event\_cancelled', 'broadcast' |
| event\_id | UUID (FK → events, nullable) | Set for event-level notifications (e.g. event cancellation notice) |
| signup\_id | UUID (FK → signups, nullable) | Set for signup-level notifications (confirmations, reminders, cancellations) |
| to\_email | varchar(120) | Recipient address |
| subject | text | Email subject as sent |
| body | text | Email body as sent (plain text) |
| status | text | 'queued' | 'sent' | 'failed' |
| error | text (nullable) | SMTP error message if status = 'failed' |
| created\_at | timestamptz | When the send was attempted |
| sent\_at | timestamptz (nullable) | When the send succeeded |

The unique constraint on (kind, signup\_id) prevents duplicate sends if the reminder job runs twice in the same window.

**4.10 Impersonation Log**

**Records when Admin enters and exits 'View As Manager' mode. Only session boundaries are logged — individual actions taken during impersonation are not recorded.**

| **Field** | **Type** | **Notes** |
| --- | --- | --- |
| id | UUID (PK) |  |
| super\_admin\_id | UUID (FK → users) | The Admin who initiated impersonation |
| impersonated\_manager\_id | UUID (FK → users) | The Event Manager being viewed as |
| started\_at | timestamptz | When the impersonation session began |
| ended\_at | timestamptz (nullable) | When the session ended. Null if session is still active. |

**4.11 Volunteer Email Tokens**

**Short-lived tokens used to authenticate the 'My Signups' magic-link flow. When a volunteer requests their signups page, the server generates a token, emails it as a link, and stores a hash here. The token is single-use and expires after one hour.**

| **Field** | **Type** | **Notes** |
| --- | --- | --- |
| id | UUID (PK) |  |
| email | varchar(120) | The volunteer's email address used for lookup |
| token\_hash | varchar(64) | SHA-256 hash of the raw token sent in the email. Raw token never stored. |
| created\_at | timestamptz | When the token was issued |
| expires\_at | timestamptz | One hour after created\_at |
| used\_at | timestamptz (nullable) | Set when the token is consumed. Prevents reuse. |

Tokens are scoped to an email address, not a specific signup. One token gives access to all active signups for that email.

**5. Public-Facing Features (Volunteer Experience)**

**5.1 Event Listing Page**

* Up to 3 featured events (is\_featured = true) are displayed first, with a 'Featured' visual badge, before all other events. If more than 3 events are marked featured, the 3 most recently updated are shown.
* Below featured events: all other published, non-archived events with upcoming shifts, in chronological order by date
* Events where all shifts have passed are automatically hidden from this listing (cron job runs daily)
* 'View Past Events' link available to access archived events
* Each event card shows: event image, title, organization name, date(s), location, tags, approximate distance from the visitor's detected location (e.g. '4 miles away'), and open volunteer slots remaining
* Events with zero remaining slots across all shifts are visually marked as 'Full' but remain visible
* Events where location\_lat/location\_lng could not be geocoded show without a distance label
* Filter bar: filter by tag (e.g. 'Canvassing', 'Food Bank', 'Urgent'); filter by organization (if multiple orgs present)
* Fully responsive for mobile

This page lives at the root of the subdomain, e.g. https://localshifts.org/

**5.2 Location Detection & Proximity Filtering**

**On first visit, the server reads the visitor's IP address and queries the local MaxMind GeoLite2 database to determine their approximate city and coordinates. No data is logged or stored — this is a real-time query used only to pre-filter the event list.**

* A dismissible location banner appears at the top of the listing page: "Showing events near Greenville, SC — change location?"
* If GeoLite2 cannot resolve the IP (e.g. private network, VPN), the default falls back to showing all events with no distance filter
* The visitor can click 'change location' at any time to open the location picker:
  + Zip code field: visitor types a US zip code
  + Radius dropdown: 5 miles / 10 miles / 20 miles / 50 miles / Show all
  + 'Use my current location' button (HTML5 Geolocation API — browser asks permission)
* The chosen location and radius are stored in a session cookie and applied to all subsequent page loads during the session
* The URL updates to reflect the filter (e.g. /?zip=29601&radius=20) so the filtered view is shareable and bookmarkable
* The proximity filter is applied via Haversine formula in the PostgreSQL query — no PostGIS extension required
* Events with null lat/lng are always shown at the bottom of the list regardless of filter, with no distance label

The GeoLite2 .mmdb database file is bundled in the Docker image or mounted as a volume. Admin is responsible for periodic updates (MaxMind releases twice monthly). A helper script is provided in the repo to re-download it.

**5.3 Event Detail Page**

* Shows full event description, date/time details, location name with a linked 'View on Google Maps' button
* Displays the event image prominently
* Displays all tags applied to the event
* Lists all shifts in a table/card layout. Each shift shows:
  + Role name and description
  + Date, start time, end time
  + Slots remaining (e.g. '3 of 5 slots open') — or a 'Full' badge when max\_volunteers reached
  + A 'Sign Me Up' button (disabled/greyed when full)
* Shifts are ordered by date and start time

**5.4 Signup Flow**

* Clicking 'Sign Me Up' opens a simple inline form (no page redirect) with fields:
  + First Name
  + Last Initial (single character)
  + Email Address
* A note beneath the name fields reads: "Any name is fine — you can use a nickname or alias."
* On submit, server validates inputs: required fields, valid email format, valid single character for last initial, not already signed up with same email for same shift
* If max\_volunteers is already reached (race condition check), the form rejects with a friendly message and refreshes slot counts
* On success, a confirmation email is sent to the volunteer immediately
* The page updates to show the volunteer's slot as filled — no page reload required

No account is created. No password is set. The volunteer's only 'credential' is the cancel token in their email.

**5.5 Cancellation Flow**

* Every confirmation email and reminder email contains a unique, one-click cancellation link
* The link format is: https://localshifts.org/cancel/{cancel\_token}
* Clicking the link shows a simple confirmation page with the shift details and a 'Yes, Cancel My Signup' button
* An optional text area allows the volunteer to leave a brief cancellation note for the manager
* On confirmation, the signup is marked cancelled (soft delete — data is retained until scheduled purge)
* The shift slot count is immediately updated (the slot reopens)
* A cancellation notification email is sent to the Event Manager immediately
* Tokens expire 7 days after the event date; expired token links show a friendly expiry message

**5.6 Past Events Archive**

* Accessible at /events/past — disabled by default; enabled by Admin in system settings
* When enabled: shows event title, organization, date(s), location, and tags — no volunteer data ever shown
* Events appear here once all their shifts have passed
* When disabled: /events/past returns 404 and no link to it appears on the homepage

**5.7 Public Event Request Form**

**A simple contact form at /add-event for partner organizations or individuals who want to list an event. It is not linked from homepage navigation — shared as a direct URL when needed.**

* Accessible at /add-event — publicly accessible, no login required
* Form fields:
  + Event title (required)
  + Proposed date (required)
  + Proposed start time (required)
  + Organization name (required — free text)
  + Event description (optional)
  + Your name (required)
  + Your email (required)
  + Your phone number (optional)
* On submit: an email is sent to the Admin with all the above details. No database record is created. No account is created.
* The submitter sees: "Thanks! We received your event request and will follow up at [email]."
* Admin decides what to do with the request manually: forward to an existing manager, create a new organization and manager account and invite the submitter, or set it aside. There is no in-app review queue.

The form fields are designed to give the Admin everything needed to create the event easily if they choose to act on it.

**5.8 My Signups**

**A magic-link-based page that lets a volunteer see and manage all their active signups across all events without creating an account. Every confirmation and reminder email includes a 'View all my signups' link that triggers this flow.**

* Accessible at /my — a simple form with one field: email address
* On submit: the server looks up all active (non-cancelled) signups for that email across all events
* If any are found: a magic link is generated and emailed to that address. The link points to /my/:token and is valid for one hour.
* If none are found: the same 'check your email' response is shown — no confirmation either way whether the email is in the system (prevents enumeration)
* Clicking the magic link opens /my/:token which shows a list of all active signups for that email:
  + Each row shows: event title, shift date and time, role name, location, and a 'Cancel This Signup' button
  + Events are sorted chronologically — soonest first
  + Cancelled or past signups are not shown
* Clicking 'Cancel This Signup' follows the same cancellation flow as the single-signup cancel link: shows a brief confirmation with an optional note field, then cancels the signup and notifies the manager
* The token is single-use: once the page is loaded, the token is marked used and cannot be used again. Reloading the page after cancelling redirects to /my with a 'Your link has expired — request a new one' message.
* Every confirmation and reminder email includes a secondary link labeled 'View all my signups' that goes to /my with the volunteer's email pre-filled

The /my page itself does not require a token — it's just a form. Only /my/:token requires authentication.

**6. Admin & Manager Features**

**6.1 Admin Dashboard**

* Overview cards: total events, total upcoming shifts, total signups this month, understaffed shifts
* User management: create, edit, deactivate Event Manager accounts
* Organization management: create, edit, delete Organization schemes (name, logo, color, contact email)
* Tag management: create, edit, delete any tag (including tags created by Event Managers); view a count of events using each tag; system tags are listed but cannot be deleted
* System settings: SMTP configuration, default email templates, timezone, application name/branding, and default\_purge\_days (system-wide default purge window; recommended: 7)
* View all events across all managers
* Direct event management: Admin can access all Event Manager screens (/manager/\*) and create or manage events directly — no need to act as a specific manager
* 'View As [Manager]' mode: click any Event Manager's name in the user list to enter impersonation view. A persistent banner ('Viewing as [Manager Name] — Click to exit') is displayed throughout. Admin retains full permissions in this mode. Session start and end times are recorded in the Impersonation Log (section 4.10).

**6.2 Event Manager Dashboard**

* My Events list: cards for each event with quick stats (shifts, filled slots, open slots)
* Upcoming shifts panel: a chronological feed of the next 14 days of shifts with live fill status
* Understaffed alerts: banner/badge when any upcoming shift has fewer signups than min\_volunteers
* Quick-create button for new events

**6.3 Event Creation & Editing**

**A multi-step form (or single long form) with the following sections:**

* Step 1 — Basics: Title, Organization (dropdown), Description (rich text editor), Event Image upload (JPEG/PNG, max 5 MB, auto-resized to 1200px wide), Tags (multi-select from available tags — checkboxes or typeahead chip selector), Featured checkbox ("Show this event at the top of the homepage"), Data Retention override ("Purge volunteer data [X] days after last shift — leave blank for system default")
* Step 2 — Schedule: Event type (one-time vs. recurring). For one-time: single date picker. For recurring: start date, end date, recurrence pattern (weekly on selected days, or custom RRULE entry). Preview of generated occurrence dates shown before saving.
* Step 3 — Location: Location name text field, Google Maps URL field (with helper: 'Paste the full URL from your browser's address bar while viewing the location on Google Maps')
* Step 4 — Shifts: Add one or more shifts per event. Each shift can be added from a Role Template or created from scratch. Fields: role name, description, date (pre-filled from event date for one-time; selectable for recurring), start time, duration, min volunteers, max volunteers. Drag-to-reorder shifts.
* Step 5 — Reminders: Configure up to 3 reminder rules. For each: offset (hours before shift), email subject, email body. Default templates are pre-filled from system defaults but fully editable. Available merge tags shown as clickable chips: {{volunteer\_first\_name}}, {{event\_title}}, {{shift\_date}}, {{shift\_start\_time}}, {{shift\_role}}, {{location\_name}}, {{location\_map\_url}}, {{cancel\_url}}
* Preview & Publish: Review all settings. Save as Draft or Publish immediately.

**6.4 Role Template Management**

* A dedicated 'Role Templates' section in the manager's settings
* Create, edit, delete templates: role name, description, default duration, default min/max volunteers
* Templates are personal to each Event Manager (not shared globally unless Admin creates global templates in a future version)

**6.5 Signup Management**

* Per-event signup roster: a table of all signups grouped by shift, showing name (first name + last initial), email, signup time, status (active/cancelled)
* Manager can manually remove a signup (treated as cancellation; notification sent to volunteer)
* Manager can manually add a signup (useful for phone/in-person signups): enter first name, last initial, and email; system sends confirmation email
* Export to CSV: all signups for an event, or all upcoming signups across events
* Broadcast email: compose and send an ad-hoc email to all active signups for a specific event or shift (useful for last-minute updates)

**6.6 Cancellation Notifications to Manager**

* When a volunteer cancels, the assigned Event Manager receives an email immediately
* Email contains: volunteer first name + last initial, event title, shift role, shift date/time, optional cancellation note, and a link to the signup roster
* If the cancellation drops the shift below min\_volunteers, the notification is flagged as urgent in the subject line

**6.7 Tag Management**

* Both Admin and Event Managers can create tags from the tag management screen or inline during event creation
* Admin can edit or delete any tag (including tags created by Event Managers). Deleting a tag removes it from all events.
* Event Managers can edit or delete tags they created, but not tags created by Admin or other managers
* System-reserved tags (is\_system = true) are listed for reference but cannot be edited or deleted by any user — they are managed automatically by the application
* System-reserved tags in V1:
  + 'Understaffed' — automatically applied to an event when any upcoming shift has fewer signups than min\_volunteers; automatically removed when all upcoming shifts meet or exceed their min\_volunteers threshold
* Tag names must be unique (case-insensitive). Attempting to create a duplicate tag name shows an error.

**6.8 Event Cancellation**

**An Event Manager (or Admin) can cancel an entire event at any time before or after it starts. Cancellation is a distinct, irreversible action — it is not the same as archiving or unpublishing.**

* A 'Cancel This Event' button is available on the event detail/edit screen for published and draft events
* Clicking the button opens a confirmation dialog that:
  + States clearly that cancellation cannot be undone
  + Requires the manager to enter a cancellation message (required, not optional) explaining why the event was cancelled
  + Shows a count of active signups that will be notified
* On confirmation, the server sets cancelled\_at = now() and stores the cancellation\_message on the event record
* The event is immediately hidden from the public listing and event detail page (or shows a 'Cancelled' banner if a direct URL is visited)
* An Event Cancellation Notice email is sent immediately to all active (non-cancelled) signups for every shift of the event
* The cancellation email includes: event title, original date/time, cancellation message from the manager, and the manager's contact email
* No further reminder emails are sent for cancelled events (the reminder scheduler checks cancelled\_at before sending)
* Cancelled events remain in the database with all shift and signup records intact until the normal purge window elapses
* The event appears in the manager's event list with a 'Cancelled' badge for reference

Cancellation is permanent. There is no 'uncancel' — to restore a cancelled event, create a new one.

**7. Email System**

**7.1 Email Types**

| **Email Type** | **Trigger** | **Recipient** | **Cancel Link Included?** |
| --- | --- | --- | --- |
| Signup Confirmation | Volunteer submits signup form | Volunteer | Yes — plus 'View all my signups' link |
| Reminder | Cron job, per Reminder Rule offset | Volunteer (active signups only) | Yes — plus 'View all my signups' link |
| Cancellation Confirmation | Volunteer cancels via token link | Volunteer | No |
| Cancellation Alert | Volunteer cancels via token link | Event Manager | No |
| Event Cancellation Notice | Manager cancels entire event | All active signups (all shifts of the event) | No |
| Manager Broadcast | Manager sends ad-hoc message | All active signups (event or shift) | Yes (appended automatically) |
| Manual Removal Notice | Manager removes a signup | Volunteer | No |
| My Signups Magic Link | Volunteer requests their signups page at /my | Volunteer | N/A (the email IS the link) |
| Event Request Notification | Someone submits /add-event form | Admin | No |

**7.2 SMTP Configuration**

* Configured by Admin in System Settings
* Fields: SMTP host, port, secure (TLS/STARTTLS), username, password, 'From' name, 'From' address
* PurelyMail.com is the recommended default (standard SMTP, port 587 STARTTLS)
* A 'Send Test Email' button on the settings page sends a test message to the admin's own address
* SMTP credentials stored encrypted at rest in the database (AES-256)

**7.3 Reminder Scheduling**

* A pg-boss job runs every 15 minutes
* It queries for shifts where: shift start time is within (now + offset\_hours) AND a *notification\_sends* record does not already exist for this signup + rule combination
* Sends the reminder and writes to *notification\_sends* to prevent duplicates
* Cancelled signups are excluded from all reminder sends
* If SMTP delivery fails, the job retries up to 3 times with exponential backoff before logging an error

**7.4 Email Merge Tags**

**All email templates (system defaults and per-event overrides) support the following merge tags:**

| **Tag** | **Resolves To** |
| --- | --- |
| {{volunteer\_first\_name}} | Volunteer's first name |
| {{volunteer\_last\_initial}} | Volunteer's last initial |
| {{event\_title}} | Title of the event |
| {{event\_description\_plain}} | Plain-text version of event description |
| {{organization\_name}} | Name of the organization |
| {{shift\_role}} | Role name of the shift |
| {{shift\_date}} | Date of the shift (formatted, e.g. 'Saturday, April 12, 2026') |
| {{shift\_start\_time}} | Start time (e.g. '9:00 AM') |
| {{shift\_end\_time}} | End time (e.g. '11:00 AM') |
| {{shift\_duration}} | Duration in plain English (e.g. '2 hours') |
| {{location\_name}} | Location name string |
| {{location\_map\_url}} | Google Maps URL (full hyperlink) |
| {{cancel\_url}} | Full URL with unique cancel token |
| {{event\_url}} | Public URL of the event detail page |
| {{manager\_name}} | Event Manager's display name |
| {{manager\_email}} | Event Manager's email (for reply-to) |

**8. Security Requirements**

**8.1 Admin Authentication**

* Single login endpoint at /login — there are no separate /admin/login or /manager/login URLs. After successful login, the server redirects based on the user's role: Admin → /admin/dashboard, Event Manager → /manager/dashboard.
* The login link is NOT shown in the public homepage navigation. It is accessed by direct URL only (e.g. bookmark, back-channel link). This reduces visibility of the admin surface to casual site visitors.
* Passwords hashed with bcrypt (cost factor 12 minimum)
* Session management via secure, httpOnly, sameSite=strict cookies with server-side session store (Postgres-backed)
* Session expiry: 8 hours of inactivity; 24-hour absolute maximum
* Rate limiting on login endpoint: 10 attempts per 15 minutes per IP, then temporary lockout
* Optional TOTP-based 2FA for Admin account (QR code enrollment in settings)
* No password reset via email link (to avoid account takeover via email compromise); Admin resets manager passwords directly from the user management panel

**8.2 Volunteer Token Security**

* Cancel tokens generated with 32 bytes of cryptographically secure random data (crypto.randomBytes), encoded as hex (64 chars)
* Tokens are not stored in plain text — only a HMAC-SHA256 hash is stored; raw token only lives in the email
* Tokens expire 7 days after the event date

**8.3 Input Validation & Sanitization**

* All form inputs validated server-side with Fastify schema validation (JSON Schema)
* HTML in description fields sanitized with DOMPurify (server-side via jsdom) to prevent stored XSS
* File uploads: type checked by magic bytes (not just extension), size limited to 5 MB, stored outside web root with randomized filenames
* Parameterized queries throughout (Kysely enforces this by default — no raw string interpolation)

**8.4 Infrastructure**

* Node.js process runs as a non-root user inside the container
* Traefik handles all TLS; internal traffic is HTTP only (not exposed outside Docker network)
* Database port not exposed outside Docker internal network
* Environment variables (DB credentials, SMTP password, session secret) passed via .env file, never committed to source control
* Fail2ban or similar recommended at VPS level for SSH protection (out of app scope, but documented in deploy guide)

**8.5 Impersonation Audit Log**

* When Admin enters 'View As Manager' mode, the session is recorded in the impersonation\_log table (section 4.10)
* The log records: which Admin entered impersonation, which manager was impersonated, session start time, and session end time
* Individual actions taken during an impersonation session are NOT recorded — only session boundaries
* Admin can view the impersonation log from the admin dashboard
* Log entries are retained indefinitely (not subject to the volunteer data purge policy)

**9. Deployment Architecture**

**9.1 Docker Compose Services**

| **Service** | **Image** | **Purpose** |
| --- | --- | --- |
| app | Custom Node.js 20 Alpine | Main web application + pg-boss scheduler |
| db | postgres:16-alpine | Primary data store |
| traefik | traefik:v3-alpine | Reverse proxy + automatic TLS via Let's Encrypt |

All services communicate on an isolated Docker bridge network. Only Traefik exposes ports 80 and 443 to the host.

**9.2 Volumes**

* postgres\_data — persistent PostgreSQL data
* uploads — event images and other uploaded assets
* traefik\_data — Traefik's TLS certificate store (persists across restarts)
* geoip — MaxMind GeoLite2 .mmdb database file, mounted into the app container

**9.3 Environment Configuration**

**A single .env file at the project root configures all services:**

* DATABASE\_URL — Postgres connection string
* SESSION\_SECRET — 64-character random string
* SMTP\_HOST, SMTP\_PORT, SMTP\_USER, SMTP\_PASS, SMTP\_FROM\_NAME, SMTP\_FROM\_EMAIL
* APP\_URL — Public base URL (e.g. https://localshifts.org)
* APP\_TIMEZONE — IANA timezone (e.g. America/New\_York)
* UPLOAD\_MAX\_BYTES — Default 5242880 (5 MB)
* DEFAULT\_PURGE\_DAYS — System-wide default days after last shift to purge signup PII (recommended: 7)
* GEOIP\_DB\_PATH — Absolute path to the MaxMind GeoLite2-City.mmdb file inside the container (e.g. /geoip/GeoLite2-City.mmdb)

**9.4 Database Migrations**

* Migrations managed with a simple migration runner (e.g. node-pg-migrate or Kysely's built-in migrator)
* Migrations run automatically on app startup before accepting connections
* Each migration is a numbered SQL file in /migrations; never modified after creation

**9.5 Backups**

* A companion cron job script (pg\_dump | gzip) is documented and optionally included as a docker-compose profile
* Recommended: daily dump to a mounted volume or rsync to off-server storage

**10. Data Retention Policy**

**10.1 Philosophy**

Local Shifts is scoped to public civic activities only. Even so, volunteer PII (first name, last initial, email address) should be retained only as long as operationally necessary. This policy exists to minimize legal and privacy risk from data subpoenas, breaches, or server compromise.

Limiting the site to public activities (protests, canvassing, food banks, river cleanups, etc.) means volunteer lists are not sensitive in themselves — but purging them promptly after events is still best practice.

**10.2 Purge Behavior**

* Each event has a purge\_after\_days value, set at event creation or edit time. If left blank, the system-wide DEFAULT\_PURGE\_DAYS value is used (recommended default: 7).
* A daily cron job evaluates all events: if (last\_shift\_date + purge\_after\_days) < today AND the event has not already been purged, the purge executes automatically.
* What gets purged: all Signup records for that event are hard-deleted — first\_name, last\_initial, email, cancel\_token\_hash, and all associated *notification\_sends* rows are permanently removed.
* What is retained: Event and Shift records are kept after purge for historical reference and reporting. Only volunteer PII is deleted.
* Purge is idempotent: running it on an already-purged event (with no remaining signups) is a no-op.
* Admin can manually trigger an immediate purge for any specific event from the admin dashboard.
* Once purged, signup data cannot be recovered. This is intentional.

**10.3 Public Listing Behavior**

* Events are automatically hidden from the main public listing (/) once all of their shifts have passed. This is handled by the same daily cron job (or a combined job).
* Past events are accessible at /events/past — a public archive page showing event title, organization, date(s), location, and tags only (no volunteer data shown publicly at any time).
* This page is DISABLED by default. Admin must explicitly enable it in system settings. When disabled, /events/past returns 404 and no 'View Past Events' link appears on the homepage.

**10.4 Manager Visibility**

* Event Managers can see the purge window setting for their own events (read-only display in event details).
* Event Managers cannot change the purge window after an event is published without Admin involvement.
* Admin can adjust the purge window for any event at any time, including after publication.

**11. Screen Inventory**

| **Route** | **Name** | **Access** |
| --- | --- | --- |
| / | Public Event Listing (with location detection) | Public |
| /events/past | Past Events Archive | Public (toggleable by Admin) |
| /events/:slug | Public Event Detail + Signup | Public |
| /cancel/:token | Volunteer Cancellation Confirmation | Public (token required) |
| /my | My Signups — Email Entry | Public |
| /my/:token | My Signups — Active Signups List | Public (magic link token required) |
| /add-event | Public Event Request Form | Public |
| /login | Login (role-based redirect) | Public |
| /admin/dashboard | Admin Dashboard | Admin |
| /admin/users | User Management | Admin |
| /admin/organizations | Organization Management | Admin |
| /admin/tags | Tag Management | Admin |
| /admin/settings | System Settings (SMTP, defaults, purge window) | Admin |
| /admin/view-as/:userId | View As Manager (impersonation) | Admin |
| /manager/dashboard | Event Manager Dashboard | Event Manager + Admin |
| /manager/events | My Events List | Event Manager + Admin |
| /manager/events/new | Create Event (multi-step) | Event Manager + Admin |
| /manager/events/:id/edit | Edit Event | Event Manager + Admin |
| /manager/events/:id/signups | Signup Roster | Event Manager + Admin |
| /manager/events/:id/broadcast | Broadcast Email Compose | Event Manager + Admin |
| /manager/templates | Role Template Management | Event Manager + Admin |
| /manager/settings | Manager Profile & Preferences | Event Manager + Admin |

**12. Non-Functional Requirements**

* Performance: page load under 500ms for all public pages on a 1 vCPU / 1 GB RAM VPS (expected traffic is low, <100 concurrent users)
* Availability: no specific SLA required; Docker restart policies handle crashes automatically
* Browser support: all modern browsers (Chrome, Firefox, Safari, Edge); no IE11 requirement
* Mobile: fully responsive, optimized for volunteer sign-up on mobile phones
* Accessibility: semantic HTML, ARIA labels on forms, sufficient color contrast (WCAG AA)
* Logging: structured JSON logs (Fastify's built-in Pino logger); log to stdout for Docker log collection
* Codebase: well-commented, flat structure, no unnecessary abstraction layers; easy for a single developer to maintain

**13. Out of Scope (V1)**

* OAuth / social login for volunteers
* Volunteer hour tracking or history across events
* Waitlist management (V2 candidate)
* SMS reminders
* Payments or liability waivers
* Calendar (.ics) export (V2 candidate)
* Multi-language / i18n
* White-label per-organization subdomain routing
* Mobile native app
* Scheduled (future-dated) broadcast emails (V2 candidate)
* Subdomain-based routing (e.g. greenville.localshifts.org → filtered event list for Greenville) — V2 candidate; V1 uses URL parameters instead
* Admin global Role Templates shared across all managers (V2 candidate)
* Tag-based email segmentation (broadcast to volunteers with a specific tag)
* Per-volunteer signup history or repeat-volunteer recognition

**14. Resolved Questions**

The following questions were open in previous PRDs and have been resolved as of v2.2 (April 11, 2026):

| **#** | **Question** | **Decision** |
| --- | --- | --- |
| 1 | Should Role Templates be per-manager only, or should Admin be able to define global templates that all managers can use? | Per-manager only for V1. Admin global templates deferred to V2. |
| 2 | For recurring events, should each occurrence be a separate event page URL, or should one event page show all occurrences with their own shift tables? | One event page URL; all occurrences listed as shift rows grouped by date. |
| 3 | Should the broadcast email feature allow scheduling (send at a future time) or only immediate sends? | Immediate sends only for V1. Scheduled sends deferred to V2. |
| 4 | Should volunteers be able to sign up for multiple shifts within the same event (e.g., set-up AND clean-up)? | Yes, allowed. No restriction on signing up for multiple shifts per event. |
| 5 | Is there a need for a public-facing 'My Signups' page where a volunteer can see all their active signups by entering their email address? | Out of scope for V1. Volunteers manage signups via the cancel link in their email. V2 candidate. |
| 6 | Should cancellations reopen the slot immediately and silently, or should the manager have the option to approve the reopening? | Immediate silent reopen. Waitlist/approval flow deferred to V2. |
| 7 | Who can create and manage tags — Admin only, or also Event Managers? | Both Admin and Event Managers can create tags. Admin can edit/delete any tag; managers can only edit/delete their own. System tags cannot be deleted by anyone. |
| 8 | Should any tags be system-reserved and auto-applied by the system? | Yes. 'Understaffed' is a system-reserved tag, automatically applied when any upcoming shift has fewer signups than min\_volunteers, and auto-removed when resolved. |
| 9 | Should Event Managers be able to override the purge window for their own events? | Yes. Managers can set purge\_after\_days per event at creation or edit time. Admin can also override at any time. |
| 10 | Should there be a cap on simultaneously featured events on the homepage? | Cap at 3. If more than 3 events are marked featured, the 3 most recently updated are displayed. |
| 11 | Should Admin 'View As Manager' impersonation sessions be recorded in an audit log? | Yes, session boundaries only (start/end times). Individual actions within a session are not logged. |
| 12 | Should the /events/past public archive page be enabled or disabled by default? | Disabled by default. Admin must explicitly enable it in system settings. |

**15. Open Questions**

All prior open questions have been resolved (see Section 14). One action item remains pending external verification:

| **#** | **Question** | **Impact** |
| --- | --- | --- |
| 1 | PurelyMail SMTP: confirm actual sending rate limits (hourly/daily caps) to ensure large reminder batches won't be throttled for high-signup-count events. | Reminder send rate limiting logic; may need batching or send-window spreading. Action: verify before production deployment. |

**16. Glossary**

| **Term** | **Definition** |
| --- | --- |
| Event | A volunteer opportunity with one or more shifts. Can be one-time or recurring. |
| Shift | A specific time slot within an event, with a role, start/end time, and volunteer capacity. |
| Signup | A record of a volunteer committing to a shift. Created without a user account. |
| Organization / Scheme | A named entity (your org or a partner org) used to group and brand events. |
| Tag | A short label applied to events for categorization and public filtering. Multiple tags can be applied to a single event. |
| EventTag | A junction record linking a Tag to an Event. |
| Featured Event | An event with is\_featured = true, displayed prominently at the top of the public event listing. |
| Role Template | A saved shift definition that can be reused across multiple events. |
| Reminder Rule | A per-event rule that triggers automated reminder emails at a configurable time before a shift. |
| Cancel Token | A unique, cryptographically secure token embedded in emails; allows a volunteer to cancel without logging in. |
| Event Manager | A staff or volunteer account that can create and manage events. Created by Admin. |
| Admin | The single system owner account with full access to all system settings, data, and manager capabilities. |
| Purge Window | The number of days after an event's last shift before volunteer PII (signup records) is automatically hard-deleted. Set per-event or inherited from system default. |
| Past Event | An event whose last shift date has passed. Hidden from the main public listing but accessible via the Past Events archive (when enabled). |
| System Tag | A tag with is\_system = true, automatically applied and removed by the application. Cannot be deleted by users. Example: 'Understaffed'. |
| Impersonation Log | An audit record of when Admin entered and exited 'View As Manager' mode, stored in the impersonation\_log table. |
| Event Cancellation | An irreversible manager action that marks an entire event as cancelled, hides it from the public listing, and immediately notifies all active signups via email. |
| Event Request | A submission from the public /add-event form. Triggers an email to the Admin with the proposed event details. The Admin handles it manually — no in-app approval queue. |
| Notification Sends | A unified email audit log table recording every outgoing email (confirmation, reminder, cancellation notice, broadcast, etc.) with its delivery status and error details. |
| My Signups | A magic-link-based page (/my) where a volunteer can view all their active signups across all events and cancel any of them, without logging in. Triggered by a link in any confirmation or reminder email. |
| Volunteer Email Token | A short-lived, single-use token stored in the volunteer\_email\_tokens table, used to authenticate access to the My Signups page. Valid for one hour. Emailed as a clickable link. |
| Location Detection | IP-based geolocation on the homepage using the MaxMind GeoLite2 local database. Determines the visitor's approximate city and coordinates to pre-filter nearby events. |
| Proximity Filter | The zip code + radius filter on the event listing page, allowing visitors to view events within a specified distance (5, 10, 20, or 50 miles) from a given location. |
| Haversine Formula | A mathematical formula for calculating the great-circle distance between two lat/lng coordinates. Used in the PostgreSQL query to filter events by proximity. No PostGIS extension required. |

End of Document — Local Shifts PRD v2.2