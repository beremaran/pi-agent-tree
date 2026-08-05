/**
 * @beremaran/pi-agent-tree — force pi to act as an orchestrator.
 *
 * Port of @beremaran/opencode-agent-tree. Every user request is decomposed
 * into subtasks and delegated to subagents via a `task` tool; the orchestrator
 * never does hands-on work (its hands-on tools are hard-blocked by default).
 *
 * Configuration is read from JSON files (merged, project wins when trusted):
 * - ~/.pi/agent/pi-agent-tree.json   (global)
 * - <cwd>/.pi/pi-agent-tree.json     (project-local)
 *
 * Enforcement layers (mirroring the opencode plugin):
 * 1. System prompt directive — installed via `before_agent_start` on the
 *    top-level session only (marker-guarded, appended once).
 * 2. Hard tool block — blocked tools are physically removed from the active
 *    toolset (`pi.setActiveTools`), and `tool_call` denies them as a second
 *    layer for every orchestrator process (top-level and, via role env
 *    markers, spawned orchestrator levels).
 * 3. `task` tool — delegates to subagents with isolated contexts; model
 *    routing and structural delegation pinning mirror the opencode plugin.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent"
import { discoverAgents, formatAgentList } from "./agents.ts"
import { LEVEL1_DIRECTIVE_MARKER, orchestratorDirective } from "./directive.ts"
import {
  BUILTIN_SUBAGENTS,
  DIRECTIVE_TOOLS,
  expandBlockedTools,
  type NormalizedOptions,
  normalizeOptions,
  PLUGIN_ID,
} from "./options.ts"
import { levelContextFromEnv, PI_CONFIG_ENV, PI_ROLE_ENV, routedTargets, taskTool } from "./subagent.ts"

const CONFIG_FILE = "pi-agent-tree.json"
const STATE_ENTRY_TYPE = "agent-tree"
const MODE_ENV = "PI_AGENT_TREE_MODE"

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Deep-merges plain objects; arrays and scalars from `override` win. */
const deepMerge = (
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const baseValue = out[key]
    out[key] = isPlainRecord(baseValue) && isPlainRecord(value) ? deepMerge(baseValue, value) : value
  }
  return out
}

const readJson = (filePath: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown
    return isPlainRecord(parsed) ? parsed : null
  } catch (error) {
    console.error(
      `[${PLUGIN_ID}] Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}

const isTopLevelProcess = (): boolean => !process.env[PI_ROLE_ENV]

const isOrchestratorProcess = (): boolean => process.env[PI_ROLE_ENV] !== "worker"

const loadConfig = (cwd: string, trusted: boolean): Record<string, unknown> => {
  // Spawned subagent processes receive the parent's resolved options through
  // the environment, so a delegation always runs with exactly the options the
  // parent validated (children may not trust the project the same way). The
  // env form is honored only when a role marker says we are a spawned process.
  if (!isTopLevelProcess() && process.env[PI_CONFIG_ENV]) {
    try {
      const parsed = JSON.parse(process.env[PI_CONFIG_ENV]) as unknown
      if (isPlainRecord(parsed)) return parsed
    } catch {
      console.error(`[${PLUGIN_ID}] Invalid ${PI_CONFIG_ENV} in the environment`)
    }
  }

  const globalPath = join(getAgentDir(), CONFIG_FILE)
  const projectPath = join(cwd, CONFIG_DIR_NAME, CONFIG_FILE)

  const global = existsSync(globalPath) ? (readJson(globalPath) ?? {}) : {}
  const project = trusted && existsSync(projectPath) ? (readJson(projectPath) ?? {}) : {}

  return deepMerge(global, project)
}

export const OrchestratorExtension = (pi: ExtensionAPI): void => {
  let opts: NormalizedOptions | null = null
  let modeOn = true
  /** Active toolset captured before the orchestrator block, restored on off. */
  let toolsBeforeOrchestrator: string[] | undefined

  const reload = (ctx: ExtensionContext | ExtensionCommandContext): NormalizedOptions | null => {
    try {
      opts = normalizeOptions(loadConfig(ctx.cwd, ctx.isProjectTrusted()))
      return opts
    } catch (error) {
      opts = null
      console.error(`[${PLUGIN_ID}] ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  const getOpts = (): NormalizedOptions | null => opts

  const warn = (message: string): void => {
    console.warn(`[${PLUGIN_ID}] ${message}`)
  }

  /**
   * Applies (or removes) the orchestrator toolset and footer status. Only the
   * top-level session manages its own active tools; spawned orchestrator
   * levels get their toolset from the `--tools` spawn flag instead.
   */
  const applyMode = (ctx: ExtensionContext | ExtensionCommandContext): void => {
    if (!isTopLevelProcess() || !opts) return

    if (modeOn) {
      if (toolsBeforeOrchestrator === undefined) {
        toolsBeforeOrchestrator = pi.getActiveTools()
      }
      const blocked = new Set(expandBlockedTools(opts.blockedTools))
      const active = pi.getActiveTools()
      const filtered = [...new Set([...active.filter((name) => !blocked.has(name)), "task"])]
      pi.setActiveTools(filtered)
      if (ctx.hasUI) {
        ctx.ui.setStatus("agent-tree", ctx.ui.theme.fg("warning", "🪜 orchestrator"))
      }
    } else {
      if (toolsBeforeOrchestrator !== undefined) {
        pi.setActiveTools(toolsBeforeOrchestrator)
        toolsBeforeOrchestrator = undefined
      }
      if (ctx.hasUI) {
        ctx.ui.setStatus("agent-tree", undefined)
      }
    }
  }

  const persistMode = (): void => {
    if (isTopLevelProcess()) pi.appendEntry(STATE_ENTRY_TYPE, { modeOn })
  }

  /** Restores a previously persisted mode (e.g. /agent-tree off) on resume. */
  const restoreMode = (ctx: ExtensionContext): void => {
    const entries = ctx.sessionManager.getEntries()
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i]
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue
      const data = entry.data as { modeOn?: unknown } | undefined
      if (data && typeof data.modeOn === "boolean") {
        modeOn = data.modeOn
      }
      return
    }
  }

  pi.on("before_agent_start", async (event) => {
    // Only the top-level session installs the directive; spawned subagents
    // and orchestrator levels receive their prompts via --append-system-prompt.
    if (!isTopLevelProcess() || !modeOn || !opts) return
    if (event.systemPrompt.includes(LEVEL1_DIRECTIVE_MARKER)) return
    const depth = opts.orchestratorDepth
    const directive = orchestratorDirective(
      opts,
      1,
      depth,
      depth > 1 ? `${opts.orchestratorAgent}-2` : undefined,
    )
    return { systemPrompt: `${event.systemPrompt}\n\n${directive}` }
  })

  pi.on("tool_call", async (event) => {
    if (!isOrchestratorProcess() || !modeOn || !opts) return
    const blocked = expandBlockedTools(opts.blockedTools)
    if (blocked.includes(event.toolName)) {
      return {
        block: true,
        reason: `[${PLUGIN_ID}] Hands-on tool \`${event.toolName}\` is hard-blocked for the orchestrator. Delegate this work to a subagent with the \`task\` tool instead.`,
      }
    }
  })

  pi.on("session_start", async (_event, ctx) => {
    // Spawned subagent processes also load their options here — from the
    // parent-provided PI_AGENT_TREE_CONFIG env — so the task tool works in
    // orchestrator levels. Everything below is top-level-only.
    const state = reload(ctx)
    if (!state) return
    if (!isTopLevelProcess()) return

    if (process.env[MODE_ENV] === "off") modeOn = false
    restoreMode(ctx)

    const agents = discoverAgents(ctx.cwd, state.agentScope).agents
    const targets = routedTargets(state, agents)

    // Mirrored warnings from the opencode plugin's config hook.
    const blockedDirectiveTools = DIRECTIVE_TOOLS.filter((tool) => state.blockedTools.includes(tool))
    if (blockedDirectiveTools.length > 0) {
      warn(`The orchestrator directive relies on blocked tool(s): ${blockedDirectiveTools.join(", ")}`)
    }
    if (state.agents !== undefined && !BUILTIN_SUBAGENTS.some((name) => targets.includes(name))) {
      warn(
        "The explicit `agents` list excludes the built-in subagents (general, explore); the orchestrator directive still instructs delegation to them.",
      )
    }
    if (state.agents !== undefined) {
      const known = new Set(agents.map((agent) => agent.name))
      const phantom = state.agents.filter((name) => !known.has(name) && !BUILTIN_SUBAGENTS.includes(name))
      if (phantom.length > 0) {
        warn(`agents list names unknown subagents (typo?): ${phantom.join(", ")}`)
      }
    }

    const { text } = formatAgentList(agents, 8)
    console.log(
      `[${PLUGIN_ID}] Orchestrator "${state.orchestratorAgent}" enabled (depth ${state.orchestratorDepth}); subagents -> ${state.subagentModel}; routed: ${targets.join(", ") || "none"}; agents: ${text}`,
    )

    if (state.orchestratorModel) {
      const [provider, modelId] = state.orchestratorModel.split("/")
      const model = ctx.modelRegistry.find(provider, modelId)
      if (model) {
        const ok = await pi.setModel(model)
        if (!ok) {
          warn(
            `orchestratorModel ${state.orchestratorModel} resolved but no API key is available; the orchestrator runs on the current session model.`,
          )
        }
      } else {
        warn(
          `orchestratorModel ${state.orchestratorModel} is not in the model registry; the orchestrator runs on the current session model.`,
        )
      }
    }

    applyMode(ctx)
  })

  pi.registerCommand("agent-tree", {
    description: "Toggle orchestrator mode: /agent-tree on | off | status",
    handler: async (args, ctx) => {
      const command = (args ?? "").trim().toLowerCase()
      if (command === "on") {
        modeOn = true
        applyMode(ctx)
        persistMode()
        ctx.ui.notify(
          "Orchestrator mode ON: hands-on tools are blocked; delegation via `task` is enforced.",
          "info",
        )
      } else if (command === "off") {
        modeOn = false
        applyMode(ctx)
        persistMode()
        ctx.ui.notify("Orchestrator mode OFF: hands-on tools are allowed again.", "info")
      } else if (command === "status") {
        const state = getOpts()
        if (!state) {
          ctx.ui.notify(
            "pi-agent-tree: not configured (missing subagentModel?). Check the log for details.",
            "error",
          )
          return
        }
        const context = levelContextFromEnv(state)
        const agents = discoverAgents(ctx.cwd, state.agentScope).agents
        const targets = routedTargets(state, agents)
        ctx.ui.notify(
          `pi-agent-tree: mode=${modeOn ? "on" : "off"} role=${context.role}${context.role === "orchestrator" ? ` level=${context.level}/${context.depth}` : ""} subagentModel=${state.subagentModel} routed=${targets.join(", ") || "none"}`,
          "info",
        )
      } else {
        ctx.ui.notify(`Usage: /agent-tree on | off | status (currently ${modeOn ? "on" : "off"})`, "info")
      }
    },
  })

  pi.registerTool(taskTool(getOpts, () => modeOn))
}

export default OrchestratorExtension
