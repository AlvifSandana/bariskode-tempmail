# AGENTS.md

## Scope and package boundaries
- This is a pnpm workspace with **only 2 active packages**: `worker/` and `frontend/` (`pnpm-workspace.yaml`).
- Top-level folders like `mail-parser-wasm/`, `smtp_proxy_server/`, `pages/`, `e2e/` are not part of workspace scripts; do not assume they run in CI/dev flow.

## Source of truth commands
- Run worker dev server: `pnpm dev:worker` (root) or `pnpm --filter worker dev`.
- Run frontend dev server: `pnpm dev:frontend` (root) or `pnpm --filter frontend dev`.
- Worker tests: `pnpm --filter worker test`.
- Targeted worker test file(s): `pnpm --filter worker test -- src/auth/index.test.ts`.
- Frontend production check: `pnpm --filter frontend build` (this runs `vue-tsc -b` before `vite build`).
- Worker production check: `pnpm --filter worker build` (Wrangler prints a deprecation warning and internally uses dry-run deploy behavior).

## Validation order used in this repo
- For backend/auth changes: run targeted `worker` tests first, then `worker` build.
- For frontend/API contract changes: run `frontend` build after worker tests.

## Runtime and routing facts that are easy to miss
- Worker entrypoint is `worker/src/worker.ts`.
- Route groups mounted there:
  - `/api` and `/open_api` (alias to same common API module)
  - `/auth`, `/user_api`, `/admin_api`, `/telegram_api`
- `APP_ORIGINS` is enforced strictly for CORS: requests with `Origin` not in allowlist get `403`.

## Auth/session model (current)
- Browser user auth is **cookie session** (`tm_user_session`, HttpOnly), not localStorage user JWT.
- State-changing cookie-auth requests require CSRF double-submit (`tm_user_csrf` cookie + `X-CSRF-Token` header) and Origin/Referer validation.
- Frontend auth client already handles this in `frontend/src/api/index.ts` (`credentials: 'include'` + CSRF header injection).
- User auth JSON responses are cookie-oriented (no user token required in frontend flow).

## API/config gotchas
- Frontend base URLs are configurable via Vite env:
  - `VITE_API_BASE` (default `/api`)
  - `VITE_AUTH_BASE` (default same-origin empty prefix)
- `POST /admin_api/db_init` is a **status/check endpoint**, not a migration runner.
- DB migration is manual via Wrangler + SQL file (`db/schema.sql`).

## When editing docs
- Prefer executable truth from `package.json`, `worker/src/worker.ts`, and package-level configs over checklist prose.
- Keep auth docs aligned with cookie-session + CSRF behavior to avoid reintroducing stale JWT-localStorage guidance.
