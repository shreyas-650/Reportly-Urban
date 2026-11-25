# ReportlyUrban Roadmap

Status: Phases 1 to 7 are complete (Phase 7 = SLA rules, escalations, notifications, officer privacy hardening, map fix). Work one sub-phase at a time. Never start the next sub-phase without approval.

## Phase 8: Before-and-After Verification
- 8.1 Require a completion photo before an officer can mark a complaint resolved. Reuse the existing resolution photo/notes upload from Phase 4.3. Do not build a second upload system.
- 8.2 Compare the original and completion photos with Gemini Vision. The AI only gives a suggestion ("looks fixed" / "does not look fixed") with a confidence score. It must never independently guarantee that physical work is complete. An admin and the citizen make the real decision.
- 8.3 The citizen confirms or disputes the resolution. A dispute reopens the complaint, restarts its SLA clock, escalates it, and notifies the officer using the Phase 7 notification system. Limit the number of reopens per complaint; repeated disputes go to an admin. If the citizen does not respond within a set number of days, close it as "not confirmed by citizen", not as "verified".
- 8.4 Keep a verification history for every check and add an admin list of disputed complaints.
- Photo privacy: strip hidden location/EXIF data from stored photos; the AI must not identify faces or read number plates.

## Phase 9: AI Complaint Intelligence (starts with suggest-only)
- 9.1 AI category and priority suggestions in shadow mode (stores suggestions, changes nothing, admin accepts or overrides).
- 9.2 Department auto-assignment (only after 9.1 accuracy is proven).
- 9.3 Officer auto-assignment using eligibility and workload rules.
- 9.4 Duplicate detection: flag and link potential duplicates, never silently reject.
- 9.5 Suspicious or false claim screening: send to "needs more information" or review, never auto-reject.
- 9.6 Accuracy dashboard (including accuracy by ward) and an appeal path for complaints held back by the AI. Do NOT build any reopen feature here; reopening is Phase 8.
- 9.7 Narrow automatic rejection only for objective cases, after measuring false-positive rates.
- Rules for all of Phase 9: a feature flag that switches AI off completely; a confidence score and a saved record for every AI decision; a Gemini failure never blocks a complaint; no citizen name, phone or email is ever sent to the AI; descriptions and image text are untrusted input; share the Gemini quota/call pattern with Phase 8 instead of building a second one.

## Phase 10: Citizen Rewards
- Points for valid, verified reports (only reports verified through Phase 8), badges, ward-wise leaderboards, community challenges.
- Do NOT build duplicate or fraud detection here. Read the flags from Phase 9.4 and 9.5.

## Phase 11: Testing, Optimization and Deployment
- End-to-end testing, performance and security optimization, deployment to Vercel (frontend) and Render (backend), updated documentation.
- Also do a trial deployment right after Phase 8 to catch environment and permission problems early.

## Working rules for every phase
- Never run git checkout, restore, reset, stash, clean or rm.
- No SQL execution by the agent; migrations are written only, and the owner runs them.
- Never run the live SLA sweep or phase7_2_live.test.js.
- Do not duplicate features that an earlier phase already built; reuse them.
- Report only real command output; never fabricate counts.
