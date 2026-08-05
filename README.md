# @beremaran/pi-agent-tree

A [pi](https://pi.dev) extension that turns the model into an **orchestrator**: every request is decomposed into subtasks and **delegated to subagents via the `task` tool**, never done by the orchestrator itself. You decide which model powers the subagents and which powers the orchestrator.

> **Port:** this is a faithful port of the
> [@beremaran/opencode-agent-tree](https://github.com/beremaran/opencode-agent-tree)
> opencode plugin. The enforcement model (prompt directive + hard tool block +
> model routing + structural delegation pinning) carries over; the mechanics
> are adapted to pi's extension API. See
> [Differences from the opencode plugin](#differences-from-the-opencode-plugin).

- Zero-config setup: one config file, one required option.
- Ships built-in subagents (`general`, `explore`) plus every agent you define in
  `~/.pi/agent/agents/*.md` or `.pi/agents/*.md`.
- Enforcement is layered: prompt directive + active-tool removal + hard tool block.

## How it forces orchestration

Three independent enforcement layers:

1. **System prompt directive** — a strict orchestrator prompt is appended to
   the session system prompt (`before_agent_start`, marker-guarded so it is
   installed exactly once). Subagent prompts are untouched.
2. **Active-tool removal** — blocked hands-on tools (`edit`, `bash` by
   default) are physically removed from the orchestrator's active toolset via
   `pi.setActiveTools()`. The model cannot call a tool it cannot see.
3. **Hard tool block** — as a second layer, `tool_call` denies the blocked
   tools in every orchestrator process (top-level session and, via role env
   markers, spawned orchestrator levels).

If a model ever ignores the directive, layers 2 and 3 still make it delegate:
the tools it would need to do the work directly are gone or denied.

## Installation

As a pi package from npm:

```bash
pi install npm:@beremaran/pi-agent-tree
```

From git:

```bash
pi install git:github.com/beremaran/pi-agent-tree
```

Or as a local extension (for development — see
[Development](#development)):

```bash
pi -e ./src/index.ts
```

> Config is read at session start. **Start a new session (or `/reload`) after
> changing the config file.**

## Configuration

pi extensions have no options mechanism, so the extension reads a JSON config
file, merged from two locations (project wins, and only when the project is
trusted):

| Path | Scope |
| ---- | ----- |
| `~/.pi/agent/pi-agent-tree.json` | Global (all projects) |
| `.pi/pi-agent-tree.json` | Project-local (needs a trusted project) |

Minimal example (`~/.pi/agent/pi-agent-tree.json`):

```json
{
  "subagentModel": "huggingface/deepseek-v4-flash"
}
```

`subagentModel` is the only required option. Without it the extension logs an
error and stays inert (no directive, no blocking).

## The orchestrator directive

This is the directive appended to the orchestrator's system prompt (rendered
from `src/directive.ts`, `orchestratorDirective`). The block below is the
rendered form with default settings (no `instructions`); the runtime
substitutions are listed after it.

```markdown
# Orchestrator Mode (enforced by @beremaran/pi-agent-tree)

You are the ORCHESTRATOR. You do not do hands-on work. You plan, decompose, delegate, and review.

## Non-negotiable rules
1. Treat every user request as a project: break it into discrete, independently verifiable subtasks before touching anything.
2. Delegate EVERY subtask with the `task` tool to a subagent. Never perform implementation work yourself.
3. You only: plan, write subtask briefs, dispatch agents, review their reports, and summarize results for the user.
4. Dispatch independent subtasks in parallel (multiple `task` calls in a single message). Never run dependent subtasks concurrently — wait for each result before dispatching the next.
5. Give each subagent a complete, self-contained brief: goal, constraints, files involved, verification steps, and exactly what to report back.
6. Review every subagent report. If work is incomplete or wrong, delegate the fix to a subagent — never fix it yourself.
7. Subagents are stateless: every delegation is a fresh subagent with its own context, so carry over all needed context in each brief.
8. Keep the user informed: report what was delegated to whom, the results, blockers, and the final state.

## Tool discipline
- `task` for all work (mandatory); `read`/`grep`/`find`/`ls` only when needed to write a better brief or verify a result.
- Hands-on tools are hard-blocked for you (edit, bash). If a subagent lacks a tool it needs, tell the user instead of doing it yourself.

## Default delegation
- `explore` — codebase research, locating code, understanding existing implementations.
- `general` — implementation, refactoring, testing, and any task without a more specific subagent.
- Prefer the most specialized subagent for each subtask; fall back to `general`.
```

Two substitutions happen at runtime:

| Placeholder | Value |
| ----------- | ----- |
| `blocked` list | The `blockedTools` option joined with `, ` (default: `edit, bash`) |
| `instructions` | The `instructions` option, appended verbatim at the end of the level-1 directive |

## Getting started

1. Install the extension (see [Installation](#installation)).
2. Create `~/.pi/agent/pi-agent-tree.json` (or a trusted project's
   `.pi/pi-agent-tree.json`) with a `subagentModel`.
3. Start a pi session. The startup log line reports what was routed:

   ```
   [@beremaran/pi-agent-tree] Orchestrator "Manager" enabled (depth 1); subagents -> huggingface/deepseek-v4-flash; routed: general, explore
   ```

4. Ask for something that requires a tool, e.g. "create a file named test.txt
   containing 'hello'". The orchestrator will delegate it via `task` — it will
   not edit the file itself.

The extension is **on by default** in every session. To turn it off for a
session: `/agent-tree off` (persisted; `/agent-tree on` re-enables,
`/agent-tree status` reports the current state). `PI_AGENT_TREE_MODE=off` in
the environment starts every new session with the mode off.

### Defining your own subagents

Subagents are markdown files with YAML frontmatter:

```markdown
---
name: worker
description: General-purpose implementation agent for this repo.
tools: read, bash, edit, write, grep, find, ls
model: anthropic/claude-haiku-4-5
---

Your repo-specific worker instructions go here.
```

**Locations:**
- `~/.pi/agent/agents/*.md` — user-level (always loaded)
- `.pi/agents/*.md` — project-level (only with `agentScope: "project"` or
  `"both"`; see [Options](#options))

Project agents override user agents with the same name; user agents override
the built-in `general`/`explore` with the same name.

## Options

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `subagentModel` | `string` | **required** | Model for all delegated work, e.g. `"huggingface/deepseek-v4-flash"`. Must be `provider/model` format. Agents with an explicit `model` in their agent file are never overridden. See [Model precedence](#model-precedence). |
| `orchestratorModel` | `string` | — | Model for the orchestrator. At the top level this best-effort switches the session model at start; for spawned orchestrator levels (depth > 1) it is passed to the level processes. |
| `orchestratorAgent` | `string` | `"Manager"` | Base name of the orchestrator. With `orchestratorDepth > 1` the chain levels are named `<orchestratorAgent>-2`, `<orchestratorAgent>-3`, ... |
| `orchestratorDepth` | `number` | `1` | How many orchestrator levels form the delegation chain. Intermediate levels can only delegate to the next level; only the final level's subagents have hands-on tools. See [Deep orchestration](#deep-orchestration). |
| `orchestratorModels` | `string[]` | — | Per-level orchestrator models. Entry `i` applies to level `i+1` (`[0]` → "Manager", `[1]` → "Manager-2", ...). A shorter array leaves deeper levels on `orchestratorModel`. Entries must be `provider/model`; length must not exceed `orchestratorDepth`. |
| `agents` | `string[]` | all discovered agents | Only these agents get `subagentModel`. Orchestrator level names are never routed. Names that match no agent file (and are not built-ins) trigger a typo warning. |
| `agentModels` | `Record<string,string>` | `{}` | Per-agent overrides, wins over `subagentModel`. Never applies to orchestrator levels. |
| `instructions` | `string` | — | Extra rules appended verbatim to the level-1 orchestrator system prompt. |
| `blockedTools` | `string[]` | `["edit", "bash"]` | Tools hard-blocked for every orchestrator level. `[]` = prompt-only enforcement. Names must match `[a-z0-9_-]+`. In pi, `edit` also covers `write` (see below). |
| `restrictTask` | `boolean` | `false` | When `true`, the final orchestrator level's `task` tool only accepts routed subagents as delegation targets. Closes the "delegate to an unrestricted agent" loophole. Intermediate levels are always structurally pinned to the next level. |
| `agentScope` | `"user" \| "project" \| "both"` | `"user"` | Which agent directories the `task` tool discovers. Use `"project"`/`"both"` only for repositories you trust (project agents are repo-controlled prompts). |

### `blockedTools` in pi

The opencode plugin blocks opencode **permission keys** (the `edit` key covers
`edit`/`write`/`apply_patch`). pi has no permission-key concept, so the port
expands the documented keys to concrete pi tool names:

| Key | pi tools covered |
| --- | ---------------- |
| `edit` | `edit`, `write` |
| `bash` | `bash` |
| anything else | itself |

`blockedTools: ["edit"]` therefore blocks both `edit` and `write`.

### Model precedence

The effective model for a delegated subagent is resolved in this order:

1. An explicit `model` in the agent file frontmatter
2. `agentModels[name]`
3. `subagentModel`

The orchestrator is asymmetric:

- `orchestratorModel` **best-effort overrides** the session model at start
  (and always applies to spawned orchestrator levels).
- With `orchestratorDepth > 1`, each level's model resolves as
  `orchestratorModels[i]` → `orchestratorModel` → the level's default model.
- `agentModels` is **never** applied to orchestrator levels.

## Deep orchestration

With `orchestratorDepth: 1` (the default) a single orchestrator delegates
directly to the subagents:

```
user prompt -> orchestrator -> general / explore (hands-on tools)
```

With `orchestratorDepth: N` the extension creates a strict chain of N
orchestrator-only levels. Level 1 is the session you interact with; each
further level is a spawned orchestrator process. Only the final level delegates
to the subagents; every orchestrator level has hands-on tools removed/denied.

```
orchestratorDepth: 3

user prompt -> Manager -> Manager-2 -> Manager-3 -> general / explore (hands-on tools)
```

Enforcement in the chain:

- **Intermediate levels (1..N-1) are structurally pinned to the next level.**
  The `task` tool only accepts `<orchestratorAgent>-<level+1>` as a target —
  regardless of `restrictTask` — so they physically cannot delegate to
  workers or any other agent. Their directive instructs them to decompose the
  request from the level above, delegate every subtask only to the next level,
  and never do hands-on work.
- **`restrictTask` controls the final level's task pinning.** Level N
  delegates to the routed subagents. `restrictTask: true` pins its `task`
  targets to exactly those routed agents; without it, any discovered agent is
  an acceptable target.
- **Every level defaults to `orchestratorModel`** (or a per-level
  `orchestratorModels[i]` entry) and the blocked hands-on tools. Spawned
  levels receive only the read-only + `task` toolset via the `--tools` flag,
  and the role markers (`PI_AGENT_TREE_ROLE/LEVEL/DEPTH`) keep the extension
  enforcing the block without double-installing the directive.
- **`orchestratorModel` at the top level is best-effort**: the extension tries
  `pi.setModel()` at session start and warns if the model is unavailable or has
  no API key.

**Cost caveat:** every added level multiplies LLM model calls and tokens —
each level re-plans, writes briefs, and reviews the level below it. Depth 3+
should be reserved for genuinely large decompositions.

**No `subagent_depth` limit:** pi imposes no nesting limit on extension tools,
so chains are not capped by a config value the way opencode's `subagent_depth`
caps opencode chains. Keep depth modest anyway for cost reasons.

## Example

```json
{
  "subagentModel": "huggingface/deepseek-v4-flash",
  "orchestratorModel": "anthropic/claude-opus-4-5",
  "orchestratorAgent": "Manager",
  "agents": ["general", "explore", "worker"],
  "agentModels": { "explore": "anthropic/claude-haiku-4-5" },
  "instructions": "Never delegate more than 3 subtasks at once."
}
```

> Model IDs in the examples are **illustrative** — substitute real
> `provider/model` IDs that exist in your pi setup (`pi --list-models`).

Deep orchestration with a three-level chain:

```json
{
  "subagentModel": "huggingface/deepseek-v4-flash",
  "orchestratorModel": "anthropic/claude-sonnet-4-5",
  "orchestratorDepth": 3,
  "restrictTask": true
}
```

This creates `Manager`, `Manager-2`, and `Manager-3`. `Manager` and
`Manager-2` can only delegate to the next level; `Manager-3` delegates to
`general`/`explore` (and, with `restrictTask`, to nothing else).

Per-level models keep deep chains affordable — point the top level at the
strongest model and drop to cheaper models deeper in the chain
(`orchestratorModels[0]` = "Manager", `[1]` = "Manager-2", ...):

```json
{
  "subagentModel": "huggingface/deepseek-v4-flash",
  "orchestratorDepth": 3,
  "orchestratorModels": [
    "anthropic/claude-opus-4-5",
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-haiku-4-5"
  ]
}
```

## Validation & warnings

At session start the extension validates the configuration and reports
self-contradictory setups.

- **Invalid options never crash pi.** A missing `subagentModel`, a malformed
  `provider/model`, an invalid `blockedTools` entry, a non-positive
  `orchestratorDepth`, or an `orchestratorModels` array longer than
  `orchestratorDepth` logs an error and the extension stays inert (no
  directive, no blocking, `task` reports "not configured").

| Condition | Result |
| --------- | ------ |
| `subagentModel` is missing, empty, or not `provider/model` (exactly one `/`) | Error logged; extension inert |
| `orchestratorModel` or an `agentModels` value is not `provider/model` | Error logged; extension inert |
| `orchestratorDepth` is not a positive integer (`0`, `-1`, `1.5`, `"3"`, `null`) | Error logged; extension inert |
| `orchestratorModels` has more entries than `orchestratorDepth`, or an entry is malformed | Error logged (the length error names both options) |
| A `blockedTools` name does not match `[a-z0-9_-]+` | Error logged; extension inert |
| `blockedTools` includes a directive-dependent tool (`task`, `read`, `grep`, `find`, `ls`) | Warning: the orchestrator is told to delegate with a tool it cannot use |
| An explicit `agents` list omits both built-in subagents (`general`, `explore`) | Warning: routing and the directive diverge |
| `agents` contains a name that is neither a built-in nor an agent file | Warning: typo protection |

## Security

The extension enforces behavior through configuration, so its security surface
is the configuration it runs with. Only use it with config you control.

- **`instructions` is injected verbatim** into the orchestrator's system
  prompt. An untrusted config (e.g. an untrusted project's
  `.pi/pi-agent-tree.json` — which is only read for **trusted** projects) can
  inject arbitrary prompt rules that the model may follow.
- **The tool block is an explicit allow/deny list, not categorical.** A
  renamed or future mutating tool would not be auto-blocked.
- **Subagents keep their hands-on tools.** Delegation does not remove tools
  from subagents; the extension constrains the orchestrator, not the
  subagents. A delegated subagent can still `edit` and `bash`.
- **The "delegate to an unrestricted agent" loophole.** Because subagents keep
  their tools, a prompt that is not following the directive could try to
  delegate to an agent the extension did not restrict, bypassing the block.
  Set `restrictTask: true` to close this: the final level's `task` tool then
  only accepts the plugin's routed delegation targets.
- **Intermediate chain levels cannot delegate to arbitrary agents — even
  without `restrictTask`.** With `orchestratorDepth > 1`, every intermediate
  level's `task` targets are structurally pinned to the next level.
- **`orchestratorModel` overrides the configured session model** (best effort).

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## Differences from the opencode plugin

The port keeps the enforcement model; the mechanics differ where pi does:

- **No agent config / no `Manager` agent entry.** opencode creates a `Manager`
  agent in its merged config; pi has no agent config, so the orchestrator is
  the session itself. `orchestratorAgent` only names the chain levels
  (depth > 1) and the directive.
- **`subagentModel` comes from a JSON config file**, not the extension
  factory/plugin options.
- **Delegation is a custom `task` tool**, not a built-in tool. Every
  delegation spawns a fresh `pi` process (isolated context); subagents are
  therefore stateless (no task_id reuse — the directive's rule 7 reflects
  this).
- **The hard block removes tools from the active toolset** (`pi.setActiveTools`)
  in addition to denying calls, and spawned orchestrator levels get their
  toolset from the `--tools` spawn flag.
- **No `subagent_depth` config cap.** pi does not limit extension-tool nesting.
- **No permission-key concept**: `blockedTools` keys are expanded to concrete
  pi tool names (see above).
- **A `/agent-tree` command** (`on`/`off`/`status`) toggles the mode; the state
  persists across sessions. `PI_AGENT_TREE_MODE=off` starts sessions off.

## Limitations

- Enforcement is prompt + tool-removal + permission based. Non-compliant
  models can still cut corners — for example doing their own research instead
  of delegating — where the block does not forbid the action.
- Every delegation spawns a fresh pi process; subagents cannot be resumed by
  task_id, so follow-up work needs the context carried in the brief.
- Once work is delegated to a subagent, the extension cannot stop it from
  doing that work.
- **Each added orchestrator level multiplies LLM cost and latency.**
- **Project-local config and agents require a trusted project.** An untrusted
  project's `.pi/pi-agent-tree.json` and `.pi/agents/*.md` are ignored.

## Troubleshooting

- **Start a new session after config changes.** Options are read at
  session start; `/reload` also re-reads them.
- **Check the startup log line.** A healthy load logs
  `Orchestrator "Manager" enabled; subagents -> <subagentModel>` with the
  routed agents.
- **"pi-agent-tree is not configured" from the `task` tool** means
  `subagentModel` is missing (or the project config was ignored because the
  project is untrusted). Create `~/.pi/agent/pi-agent-tree.json`, or trust the
  project (or launch with `pi -a`).
- **A warning you did not expect** — the warning cases above name the
  offending tool, agent, or config value; the config is probably not doing
  what you intend.
- **`Manager-2`/`Manager-3` appear in delegation reports** — expected with
  `orchestratorDepth > 1`: every level is a real orchestrator process, gets
  `orchestratorModel` (or its `orchestratorModels[i]` entry), and has its
  hands-on tools removed.
- **"My explicitly-configured agent model is not used"** — for the orchestrator
  this is expected: `orchestratorModel` overrides it (best effort at the top
  level, unconditional in spawned levels), and `agentModels` entries keyed to
  it are ignored. For subagents, an explicit `model` in the agent file wins
  over `agentModels` and `subagentModel` by design.
- **Tools are missing after toggling the mode** — the extension restores the
  captured toolset when you `/agent-tree off`; if another extension changed the
  toolset in between, restore them manually via your other extension's toggle.

## Notes

- Subagents keep their default tools; only the orchestrator is restricted.
- The directive is installed on the top-level session only (and, with
  `orchestratorDepth > 1`, on spawned level prompts via
  `--append-system-prompt`). Worker subagents never receive it.
- The directive is appended only once: the `# Orchestrator Mode` marker
  prevents re-appending on re-runs. This is deliberate.
- The built-in `general`/`explore` subagents are definitions in code; define
  agent files with the same names to override them.

## Development

```bash
npm install
npm run check   # typecheck + lint + tests + smoke
```

The extension is a single `src/index.ts` entry (plus helpers in `src/`). To
verify against a live pi, run from a directory with a `.pi/pi-agent-tree.json`
config and watch for the startup log line:

```
Orchestrator "Manager" enabled; subagents -> <subagentModel>
```

See [RELEASING.md](RELEASING.md) for the release process.

## Publishing

Releases are **tag-triggered from CI**, not local `npm publish`:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

Pushing the tag runs `.github/workflows/publish.yml`, which:

1. Verifies the tag matches `package.json` and that `CHANGELOG.md` documents
   the released version.
2. Installs dependencies and runs the full check suite (`npm run check`).
3. Inspects the packed tarball and asserts it contains exactly the expected
   files.
4. Smoke-tests the tarball from a clean consumer install, importing the
   package's extension entry and asserting the default and named exports are
   functions.
5. Publishes to npm using the `NPM_TOKEN` secret with npm provenance
   (`publishConfig.provenance` + `id-token: write`).
6. Creates a GitHub Release whose body is the CHANGELOG section for the
   released version.

**npm provenance requires the CI path and a `NPM_TOKEN` repository secret.**
A local `npm publish` is not the supported flow: it will not produce
provenance and bypasses the release checks. If you do run it,
`prepublishOnly` runs `npm run check` first, but prefer the tag flow.
Without the `NPM_TOKEN` secret the workflow skips `npm publish` and only
creates the GitHub Release.

The `types`/`main` entries point at the raw TypeScript source: pi loads
extensions with jiti, so the package ships `.ts` directly with no build step.

## License

MIT — see [LICENSE](LICENSE).
