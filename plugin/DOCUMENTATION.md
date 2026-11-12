# BTW coordinator

The OpenCode plugin owns live-conversation reservations and the main request's system baseline.
It exposes the shared `LIVE_BTW_RPC` contract from the companion SDK.
It registers no model-facing tools and changes no tool definitions.

## Invariants

- RPC calls use the session's canonical directory.
- A root has at most one live reservation across clients.
- If a client disappears, its reservation expires after five minutes.
- Publication requires the reservation token and its registered candidate session.
- Native prompt admission requires the current head and an unexpired reservation for that head.
- One prepared head admits one question. A retry keeps the same native message ID.
- The current root head must still match the head captured at reservation time.
- Context preparation uses native SDK fork and import operations in the host adapter.
- The adapter confirms that the previous head is idle before building its replacement.
- A failed operation removes temporary snapshots and unpublished candidates.
- A failed model send retains the prepared transcript for recovery.
- Confirmed admission schedules the previous transcript for retirement.
- Retirement clears transcript data with `files: false`, preserving a small redirect session.
- Deferred retirement stays on the root and retries after a later successful send.
- The native message origin identifies a side question or final answer across rebuilds.
- A retired v2 head keeps aliases for its own new side messages only.
- Imported main messages and replayed questions do not expand each retired head's alias map.
- Main goal, review and approval state never becomes live-side control state.
- The only inherited OpenChamber metadata is validated project context pins.
- When the coordinator is available, ordinary BTW uses a captured prefix.
- Live BTW accepts an existing main conversation immediately after the plugin loads.
- An empty reservation prefix selects native system assembly from the copied snapshot and instruction entries.
- A missing capture never supplies an empty or fabricated system prompt.
- Captures that arrive during native preparation apply to the next side question.
- A context hook restores the captured system only for the same agent, provider and model.
- Parent deletion removes its saved prefix through the event stream.
- Prefix values and conversation content never enter logs.

## Why the coordinator lives in OpenCode

Every browser and desktop client of one OpenCode instance reaches the same location plugin.
A browser lock covers only one origin and browser profile.
The coordinator's reservation survives client disconnects and plugin reloads in session metadata.

## Why retired sessions remain as redirects

Session and message links can outlive a context rebuild.
A redirect retains their logical owner and message origins without retaining another full main snapshot.

## Why prefix capture uses the context hook

OpenCode keeps an initial instruction baseline and appends later instruction updates to history.
A fork seeds a new baseline from current values.
The hook captures the original baseline that the provider request actually uses.
If the main session changes its baseline, live snapshots keep their copy until retirement.
If no capture exists, native system assembly keeps existing conversations usable without another main request.
The first side system prefix can differ from the earlier main request after an instruction change.
Later questions use the main baseline after the hook captures it.
