# Third-party notices

## OpenChamber

The host patch modifies OpenChamber at commit `183d935e9cb602ef6ce7f64cbf5f615e4d6b8048`.
The patch records those modifications in unified diff format.
OpenChamber is copyright 2025 Bohdan Triapitsyn and uses the MIT License.
The original notice is in `LICENSE.openchamber`.

## OpenAI Codex

The `BTW_HISTORY_BOUNDARY` text in `host.patch` reproduces the public Codex history-boundary prompt without changes.
The added `BTW_READ_ONLY_INSTRUCTION` follows that text as a separate policy.

Source: https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/context-fragments/src/side_conversation.rs

Copyright 2025 OpenAI.
The source uses the Apache License, Version 2.0.
The license is in `LICENSE.codex`.
The original upstream notice is in `NOTICE.codex`.
