# Intercom detach contract

`pi-subagents` exposes an event-bus contract that lets a foreground child detach from the blocking `subagent` tool call after it starts coordinating through intercom. The canonical event names and payload types are exported from `src/shared/types.ts`.

## Events

- `INTERCOM_DETACH_REQUEST_EVENT` (`"pi-intercom:detach-request"`): requester asks a foreground child to detach.
- `INTERCOM_DETACH_RESPONSE_EVENT` (`"pi-intercom:detach-response"`): child accepts or refuses the request.
- `SUBAGENT_FOREGROUND_STARTED_EVENT` (`"subagent:foreground-started"`): foreground child has spawned.
- `SUBAGENT_FOREGROUND_ENDED_EVENT` (`"subagent:foreground-ended"`): foreground child completed, failed, interrupted, or detached.

## Payloads

Use the exports in `src/shared/types.ts` as the source of truth:

```ts
interface IntercomDetachRequest {
  requestId: string;
  runId?: string;
  agent?: string;
  index?: number;
  intercomSession?: string;
}

type IntercomDetachResponse =
  | { requestId: string; accepted: true }
  | { requestId: string; accepted: false; reason: IntercomDetachRefusalReason };

interface SubagentForegroundLifecycle {
  runId: string;
  agent: string;
  index?: number;
  intercomSession: string;
  allowIntercomDetach: boolean;
}
```

`SUBAGENT_FOREGROUND_ENDED_EVENT` emits the same lifecycle identity payload.

## Sequencing

1. A foreground child spawns and emits `SUBAGENT_FOREGROUND_STARTED_EVENT`.
2. The child runs normally and may emit control/result intercom events.
3. A requester registers a response listener, then emits `INTERCOM_DETACH_REQUEST_EVENT`.
4. If the request has a well-formed string `requestId`, a foreground child with an intercom event bus responds synchronously with `INTERCOM_DETACH_RESPONSE_EVENT`.
5. On `{ accepted: true }`, the orchestrator's blocking `subagent` tool call resolves shortly after with `result.detached = true`; `SUBAGENT_FOREGROUND_ENDED_EVENT` fires and the child continues as an async-style live process.

Malformed requests with no string `requestId` are dropped because there is no addressee for the response.

## Target matching

Target fields are AND-matched against each listening child. If a field is present, it must equal the child's identity:

- `runId` matches the foreground run id.
- `agent` matches the child agent name.
- `index` matches the child index.
- `intercomSession` matches the explicit child intercom session name when set, otherwise `resolveSubagentIntercomTarget(runId, agent, index)`.

Absent fields are wildcards. There is no empty-target silent carve-out: a well-formed request always gets an accept or refusal from each listening foreground child. In multi-child cases, non-target children respond with `target_mismatch`.

## Refusal reasons

`IntercomDetachRefusalReason` is one of:

- `target_mismatch`: one or more present target fields did not match this child.
- `not_allowed`: the child agent prompt does not include `INTERCOM_BRIDGE_MARKER`, so detach is not enabled.
- `already_closed`: the child process already exited.
- `already_detached`: this child already accepted a detach request.
- `not_started`: the child has not yet started `intercom` or `contact_supervisor`. This is reachable when a control event is observed before the child has called the intercom tool.

Each refusal means the requester should stop waiting for that child and fall back to normal delivery behavior.

## Eligibility and no-bus behavior

`allowIntercomDetach` is surfaced in `SUBAGENT_FOREGROUND_STARTED_EVENT` so requesters can skip known-ineligible children. It is true only when the resolved child agent prompt includes `INTERCOM_BRIDGE_MARKER`.

A child constructed without `intercomEvents` registers no detach listener and emits no foreground lifecycle events on that bus. Requesters must treat no response as a timeout and use fallback delivery.
