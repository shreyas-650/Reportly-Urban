# AGENT.md – Reportly Urban

## 1. Project Overview

**Project:** Reportly Urban  
**Tagline:** Report. Track. Resolve. Verify.  
**Type:** AI-Powered Urban Issue Reporting and Civic Accountability Platform.

Reportly Urban helps citizens report urban problems such as potholes, garbage, broken streetlights, water leakage and drainage blockages. It uses AI to identify issues, routes complaints to responsible municipal departments, tracks resolution and promotes public accountability.

## 2. Fixed Technology Stack

Use this stack consistently. Do not introduce alternative technologies without approval.

**Frontend**
- React.js
- JavaScript
- Tailwind CSS
- React Router
- Lucide React

**Backend**
- Python
- FastAPI
- Pydantic

**Database & Authentication**
- Supabase
- PostgreSQL
- Supabase Auth
- Row Level Security (RLS)

**AI**
- Google Gemini Vision API
- AI-based image classification and description generation

**Maps & Storage**
- Leaflet + OpenStreetMap
- Cloudinary for image storage

**Development & Deployment**
- Git, GitHub, VS Code / Antigravity
- Vercel (frontend)
- Render (backend)

Avoid unnecessary dependencies and maintain this stack throughout development.

## 3. Design System

**Google Sans must be the primary font across the entire website**, including headings, paragraphs, buttons, forms, navigation, tables and dashboards.

- Apply typography globally through CSS.
- Use an authorized Google Sans font asset.
- Do not assume Google Sans is available through the standard Google Fonts API.
- Use appropriate fallbacks only if authorized font files are unavailable; ask before substituting.

Design requirements:
- Modern, professional civic-tech appearance.
- Clean, minimal and responsive layouts.
- Consistent spacing, colors and typography.
- Accessible contrast and clear visual hierarchy.
- Reusable components.
- Proper loading, empty and error states.
- Avoid excessive gradients, animations and unnecessary decoration.

## 4. Main Application Modules

### A. Citizen Portal
- Registration and login.
- Citizen dashboard.
- Submit complaints with photos, titles, descriptions and locations.
- AI-generated category and description suggestions.
- Unique complaint IDs and status tracking.
- Resolution verification and dispute options.
- Citizen points and badges.

### B. Municipal Admin Dashboard
- View and filter complaints.
- Assign departments and responsible officers.
- Display verified officer names, designations and authorized professional details.
- Set resolution deadlines.
- Update complaint statuses.
- Upload completion photographs.
- Manage overdue complaints and escalations.

Never invent officer identities or publish unverified personal information.

### C. Public Accountability Dashboard
- Total, resolved, unresolved and overdue complaints.
- Ward-wise and department-wise performance.
- Average resolution time.
- Repeated complaint locations and hotspots.
- Publicly accessible complaint information without exposing private data.

### D. AI Problem Detection
Use Gemini Vision to:
- Detect potholes, garbage, drainage issues, broken streetlights and water leakage.
- Suggest complaint categories.
- Generate titles and descriptions.
- Return structured results.

AI suggestions must be reviewed and confirmed by citizens.

### E. Automatic Escalation
- Configure issue-specific resolution deadlines.
- Send reminders to responsible officers.
- Mark overdue complaints.
- Escalate unresolved complaints to higher authorities.
- Maintain escalation history.

Do not assume every complaint has a 24-hour deadline.

### F. Before-and-After Verification
- Require completion photographs.
- Compare original and completion images using AI.
- Allow citizens to verify or dispute resolutions.
- Allow complaints to be reopened.
- Maintain verification history.

AI must not independently guarantee that physical work is complete.

### G. Citizen Rewards
- Points for valid, verified reports.
- Badges and ward-wise leaderboards.
- Community participation challenges.
- Prevent duplicate and fraudulent reward claims.

### H. Smart City Map
Use Leaflet and OpenStreetMap to display:
- Complaint locations.
- Resolved and unresolved issues.
- Overdue complaints.
- Repeated problem hotspots.
- Location-based filters.

## 5. Architecture and Coding Standards

**Frontend:**
- Use reusable React components.
- Separate pages, components, services and utilities.
- Keep API calls separate from UI where practical.
- Avoid unnecessarily large components.

**Backend:**
- Use modular FastAPI routers.
- Separate routes, business logic, database access and schemas.
- Use Pydantic validation.
- Handle errors properly.
- Keep AI logic separate from complaint management.

**Database:**
- Use PostgreSQL through Supabase.
- Maintain proper relationships, primary keys and foreign keys.
- Store timestamps and complaint history.
- Implement RLS and role-based permissions.

**API:**
- Follow REST conventions.
- Validate requests and return structured responses.
- Avoid duplicate endpoints.

## 6. Security

- Store credentials in environment variables.
- Never expose API keys or service-role credentials in frontend code.
- Keep `.env` out of GitHub and provide `.env.example`.
- Validate uploaded file types and sizes.
- Protect admin routes with server-side authorization.
- Implement Supabase RLS.
- Protect citizen and officer personal information.

## 7. Development Workflow

Build the application incrementally in this order:

1. Project architecture and frontend design.
2. Database and authentication.
3. Citizen complaint submission.
4. Municipal admin dashboard.
5. AI-based problem detection.
6. Public accountability dashboard and maps.
7. Automatic escalation and notifications.
8. Before-and-after verification.
9. Citizen rewards and leaderboards.
10. Testing, optimization and deployment.

**Never build the entire application in one prompt.**

For every phase:
1. Understand requirements and propose a plan.
2. Identify files to create or modify.
3. Implement only the approved phase.
4. Run and test the application.
5. Fix errors before proceeding.
6. Explain important code and decisions.
7. Summarize completed work.

Use mock data only for initial frontend development. Do not pretend unfinished functionality is working.

## 8. Antigravity Agent Instructions

- Read and follow this AGENT.md before making changes.
- Preserve the defined technology stack and architecture.
- Do not unnecessarily rewrite working code.
- Avoid duplicate files and unnecessary packages.
- Explain major architectural changes before implementing them.
- Keep code readable, modular and beginner-friendly.
- Ask before making major changes.
- Never leave important buttons non-functional.
- Explain unfamiliar code and technical decisions.
- Do not proceed to another phase until the current phase is tested.

## 9. Git and Documentation

- Maintain an updated README.md.
- Use meaningful commit messages.
- Commit after each working milestone.
- Never commit credentials, `.env` or generated build files.
- Update documentation when architecture changes.

## 10. Final Principle

Build Reportly Urban as a functional, secure, scalable and maintainable civic technology platform, not just a visually attractive website.

Prioritize functionality, reliability, security, user experience, maintainability and visual quality.

**Reportly Urban – Report. Track. Resolve. Verify.**

## Roadmap
The current phase plan is in docs/ROADMAP.md. Follow it, work one sub-phase at a time, and do not start the next sub-phase without approval.
