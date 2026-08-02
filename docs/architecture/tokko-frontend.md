# Tokko frontend

_Tokko React SPA (src/main.jsx) — a single-file control plane (family/addresses/rules/decisions/wallet), page+tab state machine, /api/me hydration, Vite build into public/. NO product-browsing UI._

`src/main.jsx` (~471 lines) — a **single-file React 19 SPA, no router library**. Part of [tokko-overview](tokko-overview.md).
It is a **control plane, NOT a shopping UI** — actual product search/checkout happens server-side / via the messaging
agent ([tokko-hermes-agent](tokko-hermes-agent.md)); the SPA only surfaces resulting **decisions** for approval + card/mandate status.

## Structure
- Imports `./api`, CSS, and lazily `@clerk/clerk-js`. Mounted at `#root` via `createRoot` (idempotency guard `window.__tokkoReactRoot`).
- **Routing = a `page` string state machine** in `App()`: `loading → landing/explainer → auth → family → delivery →
  spending → dashboard`. No URL routing except `/sso-callback` (Google) + `?clerk_oauth=complete`. `routeAuthenticated` gates
  onboarding by server flags `familyComplete → deliveryComplete → spendingComplete → dashboard`.
- **Dashboard tabs** (bottom nav): **Home · Needs you · Family · Wallet · More** (sub-views under More: addresses, activity,
  settings). ⚠ **No "Ask Tokko"/product-browsing tab** despite README language.
- **State = hooks only** (no Context/Redux): one `state` object (the `/api/me` payload) lifted into `App`, threaded via
  props (`state`/`onState`/`setState`); components keep local `useState`. Theme in `localStorage` (`tokko-theme`).
- **Hydration:** `boot()` calls `/api/me` → route to onboarding stage or dashboard; guest → landing. `Dashboard.refresh()`
  re-fetches `/api/me` + `/api/decisions?status=all` + `/api/activity`.

## API client (src/api.js)
`api(path,options)` thin `fetch`: `credentials:'same-origin'` (HttpOnly session cookie), auto JSON, throws typed
`ApiError(message,status,details)` on non-2xx. Empty-state/error handled at call sites (`.catch(()=>({...defaults,error}))`
so partial failures still render; mandate 409 treated as "no mandates"). Phone helpers `phoneParts`/`normalizeLocalPhone`/`toE164`.
⚠ `setupFromUserState`/`onboardingPayload`/`resultContent`/`resultText` in api.js are **not imported by main.jsx** — dead/alt-flow code.

## Key flows wired to backend
- **Auth** (`AccountAccess`): Clerk-JS in browser for email-code + Google; backend `/api/config` (clerk key + flags),
  `/api/auth/{signup,signup/verify,login,clerk/session,logout}`. Google: `authenticateWithRedirect → /sso-callback →
  handleRedirectCallback → getToken → POST /api/auth/clerk/session`. Test hook `window.__tokkoClerkEmail` bypasses real Clerk.
- **Family editor:** builds members array, validates unique phones incl. owner, `PUT /api/onboarding/profile`.
- **Addresses:** CRUD `/api/addresses*` + `/api/addresses/select`; assign memberIds + delivery contact; onboarding needs a selected address.
- **Decision inbox ("Needs you"):** renders pending `/api/decisions`; Approve/Decline → `POST /api/decisions/:id/resolve`;
  `safety_stop` type shows Decline only. Pending count badges the nav.
- **Card + mandate (Prava):** `SpendingManager` (labeled "Wallet") saves care rules `PUT /api/care-rules`; **Add card** `POST
  /api/payments/tokenization-session` → `window.location.assign(approvalUrl)` (⚠ **full-page navigation, NOT a new tab**,
  contrary to README); **Add mandate** `POST /api/payments/mandates/session`. On return `?pravaCard`/`?pravaMandate` +
  window `focus` → `refreshPayments` re-pulls `/api/payments/{payment-methods,mandates}` + `/api/me`.

## Build / serve (vite.config.js)
`publicDir:"frontend-public"` (static assets copied verbatim), `build.outDir:"public"` (built SPA emitted into `public/`,
which the backend serves). Dev proxy `/api → 127.0.0.1:3456`. `index.html` minimal (`#root` + module script), mobile-first
(`viewport-fit=cover`, theme-color `#174f3b`).
