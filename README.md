# Reportly Urban

> **Report. Track. Resolve. Verify.**  
> AI-Powered Civic Issue Reporting and Accountability Platform.

Reportly Urban empowers citizens to report municipal problems (potholes, garbage accumulation, broken streetlights, water leakage, drainage blockages) and track resolutions transparently.

---

## Architecture Overview

```
Reportly-Urban/
├── frontend/     # React.js + Vite + Tailwind CSS Citizen Portal
├── backend/      # Future Python + FastAPI Service (Phase 2)
├── .gitignore
└── README.md
```

---

## Phase 1: Citizen Portal Frontend

The Citizen Portal provides an intuitive interface for citizens to report civic grievances, track progress in real time, and view city-wide reported issues.

### Key Capabilities
- **Civic Issue Reporting:** Categorized complaints with photo preview, ward assignment, and automated complaint ID generation.
- **Explore Issues:** Search and filter civic issues across categories, statuses, and wards.
- **Issue Timeline & Tracking:** Step-by-step progress tracking from submission to resolution.
- **Citizen Dashboard:** Personal complaints overview with live resolution statistics.
- **Design System:** Built with Google Sans typography, civic color palette, and responsive layouts.

---

## Getting Started (Frontend)

### Prerequisites
- Node.js (v18+)
- npm or pnpm

### Installation & Run

```bash
cd frontend
npm install
npm run dev
```

The application will start on `http://localhost:5173`.

---

## Phase 7: Automatic SLA Sweep Scheduler

`public.run_sla_sweep(p_batch_limit, p_triggered_by)` is **idempotent and overlap-safe**:
- Acquires a non-blocking PostgreSQL transaction advisory lock (`pg_try_advisory_xact_lock`) and row locks (`FOR UPDATE SKIP LOCKED`) so overlapping sweeps never double-process complaints (`skipped_locked`).
- Processes each complaint inside an isolated subtransaction (savepoint) and enforces database unique constraints for reminders, completed escalation levels, and per-recipient notifications.
- **Important Legacy Warning:** Do **not** enable any recurring schedule until legacy `NULL sla_deadline` backlog decisions are finalized, because the first sweep notifies and escalates all already-overdue complaints.

### Option A — In-Database Scheduling via `pg_cron` (NOT EXECUTED)

`pg_cron` is available (`1.6.4`) on Supabase but is currently **not installed**. Do **not** run this until explicitly approved and legacy data handling is settled:

```sql
-- NOT EXECUTED: Run manually only when approved and legacy data is handled
CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'reportly_sla_sweep_every_5m',
  '*/5 * * * *',
  $$SELECT public.run_sla_sweep(100, 'pg_cron');$$
);
```

- **Role / Permission Note:** `cron.schedule()` executes jobs as the job owner (`postgres`). Because `public.run_sla_sweep(INT, TEXT)` is `SECURITY DEFINER` owned by `postgres` with `REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO service_role;`, `postgres` retains execution rights directly without granting execute access to `anon` or `authenticated`. No wrapper function is needed when scheduled by a superuser/`postgres` role.

### Option B — External HTTP Scheduler (FastAPI Internal Endpoint)

Any external cron runner (GitHub Actions, Render Cron, Cloud Scheduler, etc.) can invoke the protected backend endpoint over **HTTPS**:

- **Method & URL:** `POST https://<backend-host>/api/internal/sla-sweep`
- **Required Header:** `X-Sweep-Secret: <SLA_SWEEP_SECRET>` (minimum 32 random characters; verified with `hmac.compare_digest`).
- **Optional Parameter:** `batch_limit` (`1..250`, defaults to `SLA_SWEEP_DEFAULT_BATCH=100` via query string or JSON body). `triggered_by` is hardcoded server-side to `'fastapi-scheduler'` and cannot be overridden.
- **Browser / CORS Isolation:** Cross-origin browser `Origin` requests are rejected (`403`) with zero CORS headers, and all responses emit `Cache-Control: no-store`.
- **Rate Limiting:** Dedicated per-IP sliding window (`SLA_SWEEP_RATE_LIMIT_PER_MINUTE`, default `6`/minute).

