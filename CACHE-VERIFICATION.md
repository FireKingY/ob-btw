# Side-chat cache verification

The earlier placement test used `codex/gpt-6.1-sol` through the local Magpie Responses API.
Version 1.5 uses the same boundary placement.
Its new scenarios measure request equality with a deterministic provider.
The requests use synthetic reference records, the exact public Codex boundary text, and the current read-only instruction.
The boundary matches the pinned [public source](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/context-fragments/src/side_conversation.rs).

Five requests run in sequence with the same model and fixed instruction.
Each response contains five output tokens.
The cache ratio is `cached_tokens / input_tokens` from the provider response.

| Request | Input tokens | Cached tokens | Cache ratio |
| --- | ---: | ---: | ---: |
| First parent request | 10,047 | 3,968 | 39.49% |
| Repeated parent request | 10,047 | 9,856 | 98.10% |
| Boundary and read-only instruction after inherited history | 10,466 | 9,856 | 94.17% |
| Repeated side request | 10,466 | 10,240 | 97.84% |
| Boundary and read-only instruction at the front | 10,470 | 3,968 | 37.90% |

The first request already includes 3,968 cached tokens.
Cache availability can change as the provider processes successive requests.
The front control uses one additional user-message envelope.
The report retains the input counts for each case.

These calls go directly to the live provider gateway.
Separate browser tests use real OpenCode to examine the stored transcript order and composer focus.
Those tests cover `/btw`, `/btw question`, the menu, the shortcut, and selected text.
A recording provider also examines the final requests from real OpenCode and the native OpenChamber UI.
The main conversation runs as Build, and the new side chat also uses Build.
The captured side request preserves all 4 messages of the latest running parent request as an identical serialized prefix.
The comparison includes message roles, text, assistant tool calls, and tool results.
Both serialized prefixes have this SHA-256:

`39120967f94376542f68c023f42aa236e643b92189c9d28db41a3d8568319feb`

The model, tool definitions, and all other request options match exactly.
The fixed boundary and read-only instruction follow the inherited history.
The side question follows those instructions.
A side-chat follow-up preserves the complete previous side request as its prefix.
Its new reminder follows that prefix.
Appending the boundary alone sends no provider request.
Project conversations can produce different ratios because their models, tools, and context differ.

The current numerical evidence is in `verification/cache-read-only-live.json`.
The earlier boundary-only experiment remains in `verification/cache-live.json`.
The native agent and prefix comparison is in `verification/same-agent-after.json`.
The public record contains comparison results and hashes.
Raw requests contain local environment instructions and stay outside this repository.
The earlier behavior, with Build in the parent and Plan in the side chat, is in `verification/same-agent-before.json`.
The earlier completed-turn request comparison remains in `verification/wire.json`.

## Live side conversations

`/live-btw` rebuilds its context before each question.
The latest main snapshot remains the prefix.
Earlier side questions, their original premises and final answers follow that prefix.
The current question follows the closing marker.

Native imports also receive the main session's instruction entries.
The live send skips knowledge synchronization that can replace those captured entries.
The integration scenario includes a custom instruction and a pinned-context entry.
It compares complete serialized messages and every other model request option.
It also covers draft migration, reload, session links and snapshot-read failure.

The live replay comparison is separate from the controlled provider cache measurements in this report.
The script uses a deterministic fixture provider and does not measure a live provider's cache ratio.
Version 1.5 adds a coordinator inside OpenCode.
Its context hook captures the main request's system baseline.
The native adapter still lets OpenCode serialize all inherited messages.
The coordinator restores the captured baseline for the same agent, provider and model.

The coordinator scenario changes an instruction entry after the first main request.
The next main request retains the original system baseline and carries the update in history.
Both live BTW and ordinary BTW preserve that complete main prefix in the recorded provider request.
The scenario also checks concurrent clients, expired sends, snapshot cleanup and stable message links.
The results are in `verification/coordinator-proof.json`.
Draft and quotation behavior is recorded in `verification/quote-migration-proof.json`.
That scenario also covers selected-text insertion and undo restoration after a live rebuild.
The ordinary BTW regression is in `verification/ordinary-snapshot-proof.json` and `verification/ordinary-prefix-proof.json`.
Clean publication checks are recorded in `verification/release-proof.json`.

Version 1.5.1 preserves the messages in RPC errors.
The cold-source scenario enables the coordinator after the main conversation already has history.
It checks the visible explanation, the retained draft and successful retry after the next main request.
That retry also preserves the complete main prefix, tools and request options.
The result is in `verification/cold-source-proof.json`.
