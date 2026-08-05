# Changelog

## Unreleased

### Changed

- All orchestrator directive levels (single-level and `orchestratorDepth` chains) now explicitly nudge small-chunk decomposition: subtasks must be small (one concern, few files, verifiable in one focused pass), monolith-to-single-subagent delegation is prohibited, and independent subtasks should fan out to several small subagents in parallel instead of one large delegation.

## 0.2.0 - 2026-08-06

### Changed (Breaking)

- Orchestrator mode is **off by default**. The extension is inert until
  enabled: no directive, no tool removal/blocking, and `task` refuses with
  "Orchestrator mode is off". Enable with `Ctrl+Shift+Tab`, `/agent-tree on`,
  or `PI_AGENT_TREE_MODE=on`; the mode toggle persists per session. The
  `orchestratorModel` session-model switch is also gated on the mode now
  (previously it applied at every session start).
- `PI_AGENT_TREE_MODE=off` is now redundant (off is the default); the env var
  is only needed to override an inherited `PI_AGENT_TREE_MODE=on`.

### Added

- Keyboard shortcut to toggle orchestrator mode: `Ctrl+Shift+Tab` works out of
  the box; `Shift+Tab` is registered too and takes effect once
  `app.thinking.cycle` is rebound in `~/.pi/agent/keybindings.json` (pi
  reserves `Shift+Tab` for thinking-cycle and skips conflicting extension
  shortcuts).
- Bare `/agent-tree` (no arguments) toggles the mode like the shortcut;
  `on`/`off`/`status` still work, and `status` now mentions the shortcut.
- Spawned orchestrator levels inherit the parent's mode via
  `PI_AGENT_TREE_MODE`, so deep chains keep delegating when the mode was
  toggled on.

## 0.1.1 - 2026-08-05

### Changed

- Distribution is GitHub-only: removed the npm publish surface (`publishConfig`,
  `files`, `main`/`types`/`exports`, `prepublishOnly`) and the npm publish
  workflow. Releases are now tag-triggered GitHub Releases
  (`.github/workflows/release.yml`); install via
  `pi install git:github.com/beremaran/pi-agent-tree`.

## 0.1.0 - 2026-08-05

### Added

- Initial release: pi extension port of `@beremaran/opencode-agent-tree`.
- Orchestrator system-prompt directive installed via `before_agent_start`
  (marker-guarded, appended once; `orchestratorDepth`-aware level prompts).
- Hard tool block: `blockedTools` (default `["edit", "bash"]`, where `edit`
  covers `edit`/`write`) are removed from the orchestrator's active toolset
  via `pi.setActiveTools()` and denied in `tool_call` for every orchestrator
  process (top-level and spawned orchestrator levels via role env markers).
- `task` tool: delegates subtasks to subagents by spawning fresh `pi` JSON-mode
  processes with isolated contexts; model routing
  (frontmatter `model` > `agentModels` > `subagentModel`) and the
  worker/orchestrator-level spawn plans (`--model`, `--tools`,
  `--append-system-prompt`).
- Deep orchestration (`orchestratorDepth`): strict delegation chains
  (`Manager`, `Manager-2`, ...) with structurally pinned intermediate levels
  and a final level delegating to the routed subagents; per-level
  `orchestratorModels`; no `subagent_depth` cap (pi imposes none).
- `restrictTask` option closing the "delegate to an unrestricted agent"
  loophole.
- Config file loading (`~/.pi/agent/pi-agent-tree.json` + trusted
  `.pi/pi-agent-tree.json`, merged, project wins) with the parent's resolved
  options propagated to spawned subprocesses via `PI_AGENT_TREE_CONFIG`.
- `/agent-tree on|off|status` command with persisted mode, footer status
  (`🪜 orchestrator`), and `PI_AGENT_TREE_MODE=off` env opt-out.
- Built-in `general`/`explore` subagent definitions overridable by agent files
  (`~/.pi/agent/agents/*.md`, `.pi/agents/*.md`).
- Validation & warnings mirrored from the opencode plugin (model format,
  blockedTools names, depth integer checks, directive-tool blocking,
  agents-list divergence, phantom agent names) — invalid configs never crash
  pi; the extension logs and stays inert.
- Full open-source documentation (README, CHANGELOG, LICENSE, CONTRIBUTING,
  SECURITY, CODE_OF_CONDUCT, RELEASING) and CI (typecheck/lint/test/smoke on
  Node 22/24, tag-triggered release workflow creating the GitHub Release).
- Tests: options normalization/validation, directive rendering (byte-exact),
  delegation routing/pinning, and a module smoke test.
