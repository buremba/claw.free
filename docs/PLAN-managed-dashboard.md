# Managed Mode Dashboard

## Overview

After a user deploys via Managed mode, they should be able to return to claw.free, log in with Google, and see their deployed clawdbots. From the dashboard they can check status, troubleshoot, and manage deployments.

## User Flow

```
Returning user visits claw.free
  → Clicks "Login with Google" (top-right nav)
  → OAuth (reuses same client, narrower scope — just openid+email)
  → Redirected to /dashboard
  → Sees list of their deployed clawdbots
  → Can check status, SSH, restart, or delete a VM
```

## Data Model

### KV Keys

- `user:{googleId}` — User record: `{ email, googleId, deployments: string[] }`
- `deploy:{id}` — Already exists. Add `googleId` field so deployments are tied to a user.

During the deploy flow (`/api/deploy/start`), after creating the VM, store the `googleId` (from the OAuth token's `id_token`) on the deployment record and append the deployment ID to the user's deployment list.

## Pages to Add

### `/dashboard` (`src/routes/dashboard.tsx`)

- Requires auth — if no session cookie/token, redirect to OAuth
- Fetches `GET /api/deployments` (returns user's deployments)
- Shows a card per clawdbot:
  - VM name, project, zone, IP
  - Status indicator (running / stopped / unreachable)
  - Last checked timestamp
  - Actions: Check Status, Restart VM, Delete VM

### Nav update (`src/routes/__root.tsx`)

- Add a minimal top-right "Login" / avatar button
- When logged in, links to `/dashboard`

## API Endpoints to Add

### `functions/api/deployments.ts` (GET)

- Authenticates user via session cookie
- Reads `user:{googleId}` from KV
- For each deployment ID, reads `deploy:{id}`
- Returns list of deployments with status

### `functions/api/deploy/[id]/status.ts` (POST)

- Authenticates user, verifies ownership
- Uses stored refresh token to get fresh access token
- Calls `GET compute.googleapis.com/.../instances/{vm}` with user's token
- Returns VM status + external IP + serial console output (last N lines)

### `functions/api/deploy/[id]/restart.ts` (POST)

- Authenticates user, verifies ownership
- Calls `POST compute.googleapis.com/.../instances/{vm}/reset`
- Returns operation ID
- **Warning**: This will make the server briefly unreachable

### `functions/api/deploy/[id]/delete.ts` (POST)

- Authenticates user, verifies ownership
- Calls `DELETE compute.googleapis.com/.../instances/{vm}`
- Removes deployment from user record
- Cleans up KV

## Auth for Dashboard

The deploy flow already does OAuth with `compute` + `cloud-platform` scopes. For the dashboard login (returning users who aren't deploying), we need:

1. A separate auth entry point: `GET /api/auth/google?mode=dashboard`
   - Scopes: `openid email https://www.googleapis.com/auth/compute` (compute for status checks)
   - Stores session with refresh token
2. Session cookie: Set an HTTP-only cookie `claw_session={sessionId}` after OAuth callback
   - The dashboard reads this cookie to authenticate API requests
   - 7-day expiry, refreshed on each visit

## Troubleshooting Features

### Status Check
- VM running state (RUNNING / TERMINATED / STAGING)
- External IP reachability (ping or HTTP check to port 18789)
- Last 50 lines of serial console output (helps debug startup failures)

### Restart
- Hard reset the VM via GCP API
- Show warning: "This will make the server unreachable for 1-2 minutes"
- Poll operation status until complete

### Serial Console
- Fetch via `compute.googleapis.com/.../getSerialPortOutput`
- Display in a scrollable monospace box
- Useful for diagnosing startup script failures

## Risks & Mitigations

- **Server unreachable after restart**: Show clear warning before any destructive action. Managed mode already implies claw.free has access, but the user should understand operations can cause brief downtime.
- **Stale refresh tokens**: If the refresh token expires or is revoked, prompt the user to re-authenticate.
- **KV consistency**: Deployments are keyed by UUID. User records maintain a list of deployment IDs. If KV write fails, the deployment still exists in GCP — we can reconcile by listing VMs tagged `openclaw` in the user's project.

## Implementation Order

1. Add `googleId` to deploy records during `POST /api/deploy/start` (decode `id_token` from OAuth)
2. Create user records in KV during OAuth callback
3. Add session cookie flow (set on callback, read on API requests)
4. Create `GET /api/deployments` endpoint
5. Create `/dashboard` page with deployment cards
6. Add status check endpoint + UI
7. Add restart endpoint + UI with warning
8. Add delete endpoint + UI with confirmation
9. Add nav login/avatar to root layout
