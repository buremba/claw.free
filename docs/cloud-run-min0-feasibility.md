# Cloud Run `min-instances=0` Feasibility for OpenClaw Runtime

## Goal

Decide whether claw.free can move bot runtime from user-owned GCE VMs to Cloud Run with:

- `min-instances=0` (scale to zero)
- webhook delivery (Telegram/Slack)
- preferably no OpenClaw core code changes

This document is for the next agent to evaluate, challenge, and execute.

## TL;DR

- **As-is:** Not reliable with `min-instances=0`.
- **Without changing OpenClaw core:** Still feasible, but requires a **wrapper/runtime redesign** around OpenClaw.
- **If no redesign is desired:** Stay on GCE.

## Current Runtime Assumptions (from repo)

The current deployment model is VM-native:

- Long-lived stateful directories on local disk (`/var/lib/openclaw`): `startup-script.sh:4`
- Local mutable config file (`openclaw.json`): `startup-script.sh:9`
- VM bootstrapping with apt + node + git clone at startup: `startup-script.sh:100`, `startup-script.sh:126`
- `systemd` services for provider and gateway: `startup-script.sh:190`, `startup-script.sh:211`
- OpenClaw gateway expected as a persistent process: `startup-script.sh:221`
- Provider keeps global in-memory auth/session state: `provider/server.js:28`
- Provider runs child auth flows (`claude setup-token`, `codex login --device-auth`): `provider/server.js:81`, `provider/server.js:129`

## Why `min=0` Breaks As-Is

With `min-instances=0`, instance restarts/cold starts are normal. Current behavior depends on process continuity.

Primary failure modes:

1. In-memory auth flow state disappears when instance scales to zero/restarts.
2. Child auth subprocesses can die mid-flow.
3. Boot-time setup model is too heavy for request-driven cold starts.
4. Webhook retries/duplicates can cause repeated side effects without idempotency.
5. Slack timing constraints (ack quickly) conflict with cold-start plus long processing.

## GCS Mount Clarification

GCS mount helps with file persistence, but does not replace a workflow state store:

- Good for: config snapshots, logs, artifacts.
- Weak for: low-latency per-message state, idempotency keys, locks/leases, short-lived auth session state.

Treat storage as:

- **Object/file persistence:** GCS
- **Workflow + idempotency state:** Redis/Firestore/SQL

## Feasibility Matrix

### Option A: Keep Current Design

- Platform: GCE
- Reliability: high (for current architecture)
- Engineering lift: low
- Maintains current product promise: user-owned 24/7 VM

### Option B: Cloud Run `min=0` Without Meaningful Redesign

- Reliability: low
- Expected issues: dropped setup flows, duplicate processing, restart edge cases
- Recommendation: **do not ship**

### Option C: Cloud Run `min=0` With Wrapper Redesign (OpenClaw core unchanged)

- Reliability: medium to high if done correctly
- Engineering lift: medium/high
- Changes mostly in claw.free provider/runtime orchestration, not OpenClaw core
- Recommendation: viable pre-launch if team commits to migration work

## Minimum Viable Cloud Run Architecture (for `min=0`)

Per-bot service (or per-tenant routing with strict isolation), webhook-first:

1. Webhook ingress endpoint returns fast ack.
2. Ingress writes normalized event to queue + idempotency store.
3. Worker path pulls event, loads conversation/auth state from external store.
4. Wrapper invokes OpenClaw CLI/gateway interactions as needed.
5. State updates are atomic and persisted after every step.

Required controls:

- `concurrency=1` (initially) for deterministic behavior.
- Idempotency key per event (`provider + chat + event_id`).
- Retry-safe command execution with step markers.
- Time-bounded operations with resumable state machine.

## Gaps and Potential Solutions

1. **In-memory provider stage state**
- Gap: `state` object in `provider/server.js` is volatile.
- Solution: move state to Redis/Firestore keyed by bot + chat/session.

2. **Child-process auth continuity**
- Gap: auth subprocess lifecycle tied to instance lifecycle.
- Solution: convert to resumable steps; persist phase transitions and tokens; avoid requiring a single long process lifespan.

3. **Webhook duplicate deliveries**
- Gap: no strict idempotency guard today.
- Solution: atomic de-dup store with TTL and processed marker.

4. **Cold start + response SLA**
- Gap: heavy work in request path risks timeout/retry.
- Solution: ack fast, queue work, async completion messages.

5. **Mutable local filesystem assumptions**
- Gap: runtime expects stable local file semantics.
- Solution: restrict mutable local state; persist canonical state externally; use GCS only for non-transactional files.

6. **`systemd`/VM init coupling**
- Gap: startup model tied to VM services.
- Solution: prebuilt immutable container image with explicit entrypoint/supervision.

7. **Operational updates via PR merge**
- Gap: fine for app code, weak for runtime config toggles.
- Solution: separate runtime config/secrets from image builds (Secret Manager/env metadata).

## Suggested Implementation Phases

### Phase 0: Spike (1-2 days)

Objective: prove/disprove `min=0` behavior quickly.

- Deploy minimal Cloud Run service with webhook ack + queue stub.
- Add idempotency key write/read.
- Force scale-to-zero and replay webhook bursts.
- Measure duplicate handling, cold-start latency, and retry behavior.

Exit criteria:

- No duplicate side effects in replay test.
- p95 ack within provider constraints.
- Recovery from forced restart without manual intervention.

### Phase 1: State Externalization

- Replace `provider/server.js` global state with persistent state backend.
- Add explicit state machine schema and transition table.
- Persist every transition and user-visible step result.

### Phase 2: Async Execution Model

- Split webhook ingress from job execution.
- Add queue + worker.
- Implement idempotent command runner.

### Phase 3: Storage Strategy

- Move workflow/session/dedupe to Redis/Firestore.
- Keep file artifacts in GCS only where appropriate.
- Add migration/backup tooling.

### Phase 4: Production Hardening

- Observability: structured logs, trace IDs, per-event lineage.
- Chaos tests: kill/restart during setup flows.
- Load tests: webhook storm and duplicate event replay.

## Reliability Checklist (must pass before launch)

1. Instance restart during setup never corrupts state.
2. Duplicate webhook events are safely ignored/replayed.
3. Any failed step is retryable without manual repair.
4. End-to-end setup can survive at least one cold start mid-flow.
5. Config/token writes are atomic and auditable.
6. Rollback path exists for bad image deploy.

## Decision Framework

Choose GCE if:

- You want current behavior with minimal changes.
- You value predictable long-lived process semantics over platform simplicity.

Choose Cloud Run `min=0` only if:

- You are willing to redesign wrapper orchestration for stateless ingress + persisted workflow state.
- You accept higher initial engineering lift before launch.

## Open Questions for Next Agent

1. Single-tenant service per bot vs multi-tenant worker pool?
2. Redis vs Firestore for state + idempotency (cost/latency/ops tradeoff)?
3. Which exact webhook ack SLA targets are required for Telegram and Slack in our flow?
4. Which auth subflows can be redesigned to avoid long-lived child process dependency?
5. What is the failure budget (acceptable setup retry rate) for launch?

## Note on External Review

Attempted to request a second opinion via local Claude CLI in this environment, but it returned `Invalid API key` at runtime, so no additional model review was captured in this pass.

