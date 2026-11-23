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
