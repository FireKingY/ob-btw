# ob-btw

Native BTW side conversations for OpenChamber. Extension version **1.3.1**.

This revision opens each BTW with the native OpenChamber chat panel.
The native panel owns the transcript, Markdown, code blocks, tables, tools, composer, permissions, and streaming.
The extension provides a session picker and opens existing sessions.
The extension contains no transcript renderer or message composer.

## Host requirement

Apply the companion host change before installing this revision.
The host source checkout belongs in `../openchamber`.
The host advertises `features.sideChat` and accepts `openSession(id, { navigation: 'side' })`.
The published OpenChamber 2.7.0 SDK does not expose this operation.
The source build uses the companion SDK source through `tsconfig.json`.
The package keeps the required SDK dependency at `2.7.0`.
The compiled scripts need no source checkout at runtime.

Without the host change, the extension shows the missing capability and leaves the current chat selected.

## Install

The host patch targets OpenChamber 2.7.0 at commit `183d935e9cb602ef6ce7f64cbf5f615e4d6b8048`.
Use sibling checkouts for the host and extension:

```bash
git clone https://github.com/FireKingY/ob-btw.git
git clone https://github.com/openchamber/openchamber.git
cd openchamber
git checkout 183d935e9cb602ef6ce7f64cbf5f615e4d6b8048
git apply --check ../ob-btw/host.patch
git apply ../ob-btw/host.patch
bun install --frozen-lockfile
bun run --cwd packages/sdk build
bun run build:web
```

Run or package the patched checkout with the [OpenChamber build instructions](https://github.com/openchamber/openchamber).
In that host, open **Settings > Extensions** and add the local `ob-btw` folder.
The repository includes the compiled panel and service scripts.

## Use

- Enter `/btw` in the main composer to open a new native side chat.
- Enter `/btw question` to send a question in a new native side chat.
- Use the native tabs to switch between multiple BTW sessions.
- Open the BTW rail icon to select an existing conversation.
- In the session menu, select **New side chat**.
- Press **Command+Option+S** on macOS or **Ctrl+Alt+S** on Windows and Linux.
- To change the shortcut, open **Settings > Keyboard Shortcuts**.
- In the command palette, search for **New side chat**.
- Select text in a message, then select **Ask in side chat**.

The selection opens a new draft with the quoted text.
The user can add a question before sending the draft.
The menu and shortcut preserve the main draft and its attachments.

The host forks the source conversation at its latest server state.
The current turn can still be running, including the first turn.
The snapshot includes the progress and tool results already in that history.
It keeps inherited messages as context.
Each side chat has its own session and composer.
Opening an empty BTW does not call a model.
The main conversation keeps its selection.
The phone and VS Code keep the existing floating BTW behavior.

The side chat shows the creation time of its snapshot.
**View source** opens the parent conversation.
Older forks retain their completed-answer timestamp and source link.
Older side chats show a snapshot label without a time.
Each prompt states that inherited tasks are reference context.
Later messages in the parent do not automatically enter the side chat.
Create another side chat to capture newer progress.
Each new fork receives the public Codex boundary prompt after its inherited history.
This note does not start model execution.
Later prompts keep the existing reminder without moving that boundary.

Each new side chat inherits the main composer's agent, provider, model, and reasoning effort.
Existing side chats keep their saved selections.
The host appends a fixed read-only instruction after the inherited history.
The instruction forbids these actions:

- File changes and Git changes.
- Service control, background work, and scheduled jobs.
- External writes, messages, publishing, and deployment.
- Requests for broader access or escalated permissions.

When a request requires changes, the side chat describes the changes for the main chat.
Later side-chat prompts repeat the instruction.
The agent definition and tool definitions stay the same.
The instruction is a prompt policy, and the existing permission system still applies.

Both `/btw` and `/btw question` focus the destination composer after the panel becomes interactive.
Text typed during creation remains in that side chat.

The live cache experiment uses the same boundary text, read-only instruction, and synthetic reference records.
Its results come from the provider's reported input and cached token counts.
The report states the model and distinguishes the controlled experiment from UI verification.
The native request capture compares the complete parent prefix and every non-message request option.
It also compares the prefix on a side-chat follow-up.

## Existing conversations

The extension keeps the identity `btw-sidebar`.
Its local service reads the existing `threads.json` from the same extension data directory.
It returns only session identifiers and titles to the picker.
The native chat reads each conversation from OpenCode.
The service writes no records and sends no model requests.
The existing file and complete sessions remain available.
Unsent drafts from version 1.0 remain in extension storage.

## Build

```bash
bun install
bun run build
bun run typecheck
bunx openchamber-guest-check
```

Build the companion SDK before building the extension.
Ship `panel/main.js` and `service/main.js` with the package.

## Verification

[CACHE-VERIFICATION.md](CACHE-VERIFICATION.md) records the provider cache counts and the exact-prefix comparison.
The `verification` folder contains aggregate results from synthetic conversations.
The patch includes the focused host tests for BTW behavior.

The standalone scripts read `BTW_HOST_DIR`, which defaults to the sibling `../openchamber` checkout.
They write new results under the system temporary directory.
Set `BTW_OUTPUT_DIR` to change that destination.

The native snapshot script requires Node.js with TypeScript support and an available `@playwright/test` installation.
Set `BTW_PLAYWRIGHT_MODULE` to use a specific module path.
Set `BTW_CHROME_EXECUTABLE` to use an installed Chrome executable.
The script starts isolated OpenChamber, OpenCode, and fixture-provider instances.

```bash
node scripts/native-live-snapshot.ts
```

The cache script requires a Responses API endpoint.
Set `BTW_CACHE_BASE_URL` and `BTW_CACHE_MODEL` for that endpoint.
If the endpoint requires a key, set `BTW_CACHE_API_KEY` in the environment.
The default endpoint is the local Magpie gateway at `http://127.0.0.1:3425/v1`.

```bash
node scripts/native-cache.ts --read-only
```

## Upstream attribution

The host patch derives from [OpenChamber](https://github.com/openchamber/openchamber).
Its MIT notice is in [LICENSE.openchamber](LICENSE.openchamber).
The fixed history-boundary prompt comes from OpenAI Codex.
Its source and Apache 2.0 notice are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
