# Free Render + Neon deployment

This setup serves the UI and API at one HTTPS address. Render's internal search
scheduler is disabled. GitHub Actions wakes the service and calls POST /sync/due
hourly at minute 17. It runs only due search groups, with a PostgreSQL advisory
lock to prevent overlapping scheduled requests. Failed groups remain due.
Local development retains the internal scheduler by default.

## Accounts and deployment

1. Push the application and `.github/workflows/scheduled-searches.yml` to the
   default branch of your GitHub repository. Never commit `.env` or cookies.
2. Create a Neon Free project near your Render region. Copy the **direct**
   PostgreSQL connection string with `sslmode=require` (disable connection pooling
   in Neon's Connect dialog). The scheduler uses a session advisory lock and must
   not use Neon's transaction-mode pooled endpoint.
3. In Render, create a Blueprint from this repository using `render.yaml`.
   It creates one Free Node web service and no Render database or paid services.
4. Enter the Neon string as DATABASE_URL using Render's private environment settings.
   No FB_COOKIE is required; the connector defaults to logged-out page tokens. Start in mock mode if
   you want to verify deployment without live Facebook access.
5. Deploy. The application automatically creates/updates its database schema.
   Open `/health` and then the root URL on your phone. Enter the generated
   API_TOKEN in the app Settings and use the same HTTPS URL as its API URL.
6. In GitHub repository Settings > Secrets and variables > Actions, add:
   - RENDER_APP_URL: the HTTPS Render service URL (no path).
   - SCHEDULER_TOKEN: the generated SCHEDULER_TOKEN from Render (not API_TOKEN).
7. Create search groups in the app, add enabled searches, and set each group to
   an interval of at least 60 minutes. Ungrouped searches and manual-only groups
   are not automatically run. A fresh Neon database has none of your local data;
   recreate the searches or separately migrate your existing database.
8. In GitHub Actions, run “Scheduled searches” manually. Confirm it succeeds,
   then inspect the app's run history and listings. Test a live Facebook search:
   Facebook may restrict logged-out searches from a hosting IP.

## Free-tier operation and limitations

- The workflow retries the read-only health request to allow Render to wake.
  It waits up to nine minutes for the search POST, without automatically retrying
  that POST. A timeout can leave work running on Render; check run history before
  retrying. Successful groups advance only after their searches complete.
- If a process crashes mid-group, some completed profiles may run again next time.
  Listing and alert persistence already deduplicates entries. This is not an
  exactly-once job queue. Manual search runs aren't covered by the scheduler lock.
- Render Free can restart/sleep; scheduled executions are best effort. GitHub
  schedules can be delayed and run only from the default branch. Public-repository
  schedules may disable after 60 days without repository activity.
- GitHub Free private repositories include 2,000 runner minutes/month shared with
  other workflows. Hourly jobs averaging two minutes use about 1,488 minutes in a
  31-day month; three-minute jobs exceed 2,000. Start with a small search group,
  check actual usage, and reduce cadence if needed. Keep paid Actions overages
  disabled if $0 is a hard requirement. This is not guaranteed unlimited hosting.
- No database queries are made by the background scheduler when
  SCHEDULER_ENABLED=false. Neon can suspend after inactivity; actual search work
  and browsing still consume its compute/storage allowances.
- Monitor Neon storage: listing snapshots/history grow over time. This change
  doesn't delete existing history or add a retention policy.
- Keep API_TOKEN and SCHEDULER_TOKEN private. The UI is publicly loadable, but
  production API data requires API_TOKEN. Scheduled calls use SCHEDULER_TOKEN.
- FB_COOKIE is optional. Only opt into authenticated access if you choose to use it.

Pricing references:
- https://render.com/docs/free
- https://neon.com/pricing
- https://docs.github.com/en/billing/reference/product-usage-included
