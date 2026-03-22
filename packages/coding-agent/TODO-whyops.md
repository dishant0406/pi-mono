# WhyOps Integration Todo

Last updated: 2026-03-22

## Scope

Integrate WhyOps into `pi-coding-agent` using:

- direct agent registration via `POST /api/entities/init`
- manual event sending via `POST /api/events/ingest`
- no proxy mode
- explicit request/response tool spans
- explicit trace/span/step bookkeeping on the pi side

## Working Notes

- One pi session should map to one WhyOps `traceId`.
- Pi `sessionId` should be the WhyOps trace anchor for interactive thread continuity.
- The built-in extension lifecycle is the cleanest integration seam for events.
- We should prefer explicit `stepId` / `parentStepId` instead of relying on server auto-resolution.
- We should not hardcode credentials in code or docs. Runtime env only.
- We should register the current prompt/tool configuration before sending trace events.

## Todo

- [x] Create a persistent task file for the WhyOps integration.
  - Done: created this file as the working plan, checklist, and progress log.

- [x] Add core WhyOps API types and a minimal client module.
  - Done: added `src/core/whyops.ts` with typed payloads for agent init and manual events.
  - Done: added `WhyOpsClient.initAgent()` for `POST /api/entities/init`.
  - Done: added `WhyOpsClient.ingestEvents()` for `POST /api/events/ingest`.
  - Done: added explicit auth header support for bearer token or direct auth-context headers.
  - Follow-up: validate response handling and endpoint error behavior once local checks can run.

- [x] Add local trace/span/step/idempotency bookkeeping.
  - Done: added `src/core/whyops-trace.ts`.
  - Done: added per-run trace state with explicit step counters and parent tracking.
  - Done: added LLM span helpers, tool request/response span helpers, and tool-result step helpers.
  - Done: added deterministic idempotency key generation using stable JSON hashing.
  - Follow-up: tighten parent-step relationships if WhyOps graph output suggests a better shape.

- [x] Implement batching, retry, and shutdown flush for event delivery.
  - Done: added `src/core/whyops-batcher.ts`.
  - Done: added bounded batch accumulation with timer-based flush and size-based flush.
  - Done: added exponential backoff retries for ingest calls.
  - Done: added `close()` to support final flush on shutdown.
  - Follow-up: confirm retry/backoff settings under real network failure conditions.

- [x] Build a built-in inline extension that maps pi lifecycle events to WhyOps manual event types.
  - Done: added `src/core/whyops-extension.ts`.
  - Done: added direct agent init from current system prompt and discovered tool definitions.
  - Done: mapped lifecycle hooks for `before_provider_request`, `message_end`, `tool_execution_start`, `tool_execution_end`, and `session_shutdown`.
  - Done: emits `user_message`, `llm_response`, `llm_thinking`, `tool_call_request`, `tool_call_response`, `tool_result`, and `error`.
  - Follow-up: verify payload shapes against real WhyOps traces and adjust normalization if needed.

- [x] Register agent versions from the effective system prompt and active tool definitions.
  - Done: the WhyOps extension builds init payloads from `ctx.getSystemPrompt()` and `pi.getAllTools()`.
  - Done: init payloads are fingerprinted so unchanged configurations do not re-register unnecessarily.
  - Remaining: output schemas are still generic placeholders because pi tools do not expose formal result schemas today.

- [x] Wire WhyOps into CLI and SDK startup paths.
  - Done: added `src/core/whyops-runtime.ts` for env-based extension creation.
  - Done: wired CLI startup in `src/main.ts`.
  - Done: wired the SDK default loader path in `src/core/sdk.ts`.
  - Note: custom callers who pass their own `resourceLoader` still control their own extension stack.

- [x] Fix user-message normalization and session trace continuity.
  - Done: stopped sending raw provider request payloads as `user_message.content`.
  - Done: moved `user_message` emission to normalized pi `message_end` events for user messages.
  - Done: changed WhyOps trace scoping from per-agent-run to per-pi-session using `sessionId`.
  - Follow-up: verify how resumed historical sessions should appear in WhyOps after process restart or reload.

- [ ] Document env vars and behavior in README / CLI help / changelog.
  - Expected env vars: `WHYOPS_API_KEY`, `WHYOPS_BASE_URL`, `WHYOPS_AGENT_NAME`.

- [ ] Add tests for init, event mapping, batching, retry behavior, and telemetry failure isolation.
  - Goal: telemetry must never break normal agent execution.
  - Current validation state: dependencies are now installed and `npx tsx packages/coding-agent/src/cli.ts --help` works.
  - Current blocker: full `npm run check` still fails on an existing workspace resolution error in `packages/coding-agent/src/bun/register-bedrock.ts` for `@mariozechner/pi-ai/bedrock-provider`.

## Progress Log

- 2026-03-22: Initial detailed plan captured after reviewing pi-coding-agent lifecycle and updated WhyOps docs.
- 2026-03-22: Added the first implementation scaffold in `src/core/whyops.ts` for agent init and raw event ingestion.
- 2026-03-22: Added `src/core/whyops-trace.ts` for local trace/span/step/idempotency bookkeeping.
- 2026-03-22: Added `src/core/whyops-batcher.ts` for batched delivery, retry handling, and shutdown flush support.
- 2026-03-22: Added `src/core/whyops-extension.ts` to map pi runtime lifecycle events into WhyOps manual events.
- 2026-03-22: Wired WhyOps startup injection through `src/main.ts` and `src/core/sdk.ts` using env-based extension factory creation.
- 2026-03-22: Verified that direct agent registration is now implemented from the effective prompt and discovered tools, with payload fingerprinting to avoid redundant init calls.
- 2026-03-22: Installed workspace dependencies after working around a TLS certificate-chain issue for the SheetJS tarball.
- 2026-03-22: Confirmed the source CLI entrypoint works with `npx tsx packages/coding-agent/src/cli.ts --help`.
- 2026-03-22: Re-ran `npm run check`; WhyOps local lint/type issue was fixed, and the remaining failing check is an unrelated Bedrock provider subpath resolution error.
- 2026-03-22: Updated the WhyOps mapping so `user_message` comes from pi's normalized user message model instead of raw provider transport JSON.
- 2026-03-22: Updated WhyOps trace lifetime to reuse pi `sessionId` across prompts in the same interactive session.
- 2026-03-22: Re-ran repo `npm run check` after the trace fix; the remaining failure is still the unrelated Bedrock subpath resolution error in `src/bun/register-bedrock.ts`.
