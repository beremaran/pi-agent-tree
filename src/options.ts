/**
 * Option normalization and validation for @beremaran/pi-agent-tree.
 *
 * Ported from @beremaran/opencode-agent-tree (same validation semantics:
 * factory-level option errors are logged and rethrown, aborting extension
 * load; anything discovered later at runtime never throws).
 */

export const PLUGIN_ID = "@beremaran/pi-agent-tree"

/**
 * Agent scope used by the `task` tool to discover subagents. Mirrors the
 * subagent extension's `AgentScope`; "user" is the safe default because
 * project-local agents are repo-controlled prompts.
 */
export type AgentScope = "user" | "project" | "both"

/**
 * Options accepted by the extension. They are read from the extension config
 * file (`~/.pi/agent/pi-agent-tree.json` + project `.pi/pi-agent-tree.json`),
 * not from the extension factory signature — see the README.
 */
export interface OrchestratorOptions {
  /**
   * Model used for ALL delegated work — every subagent spawned via the
   * `task` tool. Format: "provider/model-id" (e.g. "huggingface/deepseek-v4-flash").
   *
   * Required. Agents that already declare an explicit `model` in their agent
   * file frontmatter are never overridden.
   */
  subagentModel: string

  /**
   * Model for the orchestrator itself. Defaults to the current session model
   * at the top level; applies to spawned orchestrator levels (with
   * `orchestratorDepth > 1`) when set. Unconditionally overrides the session
   * model when configured (best effort at session start).
   */
  orchestratorModel?: string

  /**
   * Name of the orchestrator. Default: "Manager". With `orchestratorDepth: 1`
   * this name exists only inside the directives/prompt; with depth > 1 it
   * names the intermediate delegation targets ("Manager-2", "Manager-3", ...).
   */
  orchestratorAgent?: string

  /**
   * Number of orchestrator levels in the delegation chain. Default: 1. With
   * depth N the levels are `<orchestratorAgent>`, `<orchestratorAgent>-2`,
   * ..., `<orchestratorAgent>-N`. Intermediate levels (1..N-1) can only
   * delegate to the next level; only the final level delegates to the routed
   * subagents (general, explore, ...), which keep their hands-on tools.
   */
  orchestratorDepth?: number

  /**
   * Per-level orchestrator model overrides. `orchestratorModels[0]` sets the
   * model for the top level, `orchestratorModels[1]` for level 2, etc.
   * Optional; a level without an entry falls back to `orchestratorModel`,
   * then to the current session model. Entries must be `provider/model`
   * format. Length must not exceed `orchestratorDepth`.
   */
  orchestratorModels?: string[]

  /**
   * Restrict which agents get routed to `subagentModel`. Defaults to every
   * discovered subagent (the built-in `general`/`explore` plus any user or
   * project agent files). Orchestrator level names are never routed.
   */
  agents?: string[]

  /**
   * Per-agent model overrides, keyed by agent name. Wins over
   * `subagentModel`. Never applies to orchestrator levels.
   */
  agentModels?: Record<string, string>

  /**
   * Extra rules appended verbatim to the top-level orchestrator's system
   * prompt.
   */
  instructions?: string

  /**
   * Tools hard-blocked for every orchestrator level. Default: ["edit", "bash"].
   * Pass `[]` for prompt-only enforcement. `edit` also covers `write` (pi has
   * no permission-key concept, so the port expands the opencode `edit` family).
   */
  blockedTools?: string[]

  /**
   * When true, the FINAL orchestrator level's `task` tool only accepts the
   * routed subagents as delegation targets, so it cannot delegate to
   * unrestricted agents. Intermediate levels always accept only the next
   * level regardless of this option. Default: false.
   */
  restrictTask?: boolean

  /**
   * Which agent directories the `task` tool discovers. Default: "user"
   * (`~/.pi/agent/agents`). "project" and "both" include repo-controlled
   * `.pi/agents` files; only use those for repositories you trust.
   */
  agentScope?: AgentScope
}

export type NormalizedOptions = {
  subagentModel: string
  orchestratorModel?: string
  orchestratorAgent: string
  orchestratorDepth: number
  orchestratorModels?: string[]
  agents?: string[]
  agentModels: Record<string, string>
  instructions?: string
  blockedTools: string[]
  restrictTask: boolean
  agentScope: AgentScope
}

export const DEFAULTS = {
  orchestratorAgent: "Manager",
  blockedTools: ["edit", "bash"],
  agentScope: "user",
} as const

/**
 * Built-in subagents shipped by the extension (available even when no agent
 * file defines them; user/project agent files with the same name override).
 */
export const BUILTIN_SUBAGENTS = ["general", "explore"]

/**
 * Built-in pi agents that are never routable. pi has no primary-agent concept,
 * so this is empty today — kept as a list so a future pi built-in that must
 * never be routed is a one-line change. Entries are excluded from routing and
 * from the phantom-name warning.
 */
export const KNOWN_BUILTINS: string[] = []

/**
 * Tools the orchestrator directive depends on. Blocking one of these is a
 * configuration mistake and is warned about at load time.
 */
export const DIRECTIVE_TOOLS = ["task", "read", "grep", "find", "ls"]

/**
 * Tools handed to spawned worker subagents when the agent file declares no
 * explicit `tools` list. Deliberately excludes `task` so workers cannot
 * delegate further (pi has no built-in nesting limit).
 */
export const DEFAULT_WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"]

/**
 * Tools handed to spawned orchestrator levels (depth > 1). Like the opencode
 * orchestrator, they keep read-only research tools plus `task`, and never get
 * hands-on tools.
 */
export const DEFAULT_ORCHESTRATOR_TOOLS = ["task", "read", "grep", "find", "ls"]

/**
 * pi tool names covered by each blocked permission key. pi has no opencode
 * permission-key concept, so the port expands the keys the opencode plugin
 * documented (the `edit` key covers `edit`/`write`/`apply_patch`) to the
 * actual pi tool names.
 */
export const BLOCKED_TOOL_FAMILIES: Record<string, string[]> = {
  edit: ["edit", "write"],
  bash: ["bash"],
}

const BLOCKED_TOOL_PATTERN = /^[a-z0-9_-]+$/

const MODEL_PATTERN = /^[^\s/]+\/[^\s/]+$/

const invalidOption = (name: string, expected: string): never => {
  throw new Error(`[${PLUGIN_ID}] The \`${name}\` option must be ${expected}.`)
}

const nonEmptyString = (value: unknown, name: string): string => {
  if (typeof value !== "string") invalidOption(name, "a non-empty string")
  const trimmed = (value as string).trim()
  if (trimmed === "") invalidOption(name, "a non-empty string")
  return trimmed
}

const booleanOption = (value: unknown, name: string): boolean => {
  if (typeof value !== "boolean") invalidOption(name, "a boolean")
  return value as boolean
}

const positiveIntegerOption = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    invalidOption(name, "a positive integer")
  }
  return value as number
}

const optionalString = (value: unknown, name: string): string | undefined => {
  if (value === undefined || (typeof value === "string" && value.trim() === "")) return undefined
  return nonEmptyString(value, name)
}

const stringArray = (value: unknown, name: string): string[] => {
  if (!Array.isArray(value)) invalidOption(name, "an array of non-empty strings")
  const entries = value as unknown[]
  return [...new Set(entries.map((entry: unknown) => nonEmptyString(entry, `${name} entries`)))]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringRecord = (value: unknown, name: string): Record<string, string> => {
  if (!isRecord(value)) invalidOption(name, "an object with non-empty string values")
  const record = value as Record<string, unknown>

  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      nonEmptyString(key, `${name} keys`),
      nonEmptyString(entry, `${name} values`),
    ]),
  )
}

const modelString = (value: unknown, name: string): string => {
  const model = nonEmptyString(value, name)
  if (!MODEL_PATTERN.test(model)) invalidOption(name, `a model id like "provider/model" (got \`${model}\`)`)
  return model
}

const agentScopeOption = (value: unknown, name: string): AgentScope => {
  if (value === undefined) return DEFAULTS.agentScope
  if (value !== "user" && value !== "project" && value !== "both") {
    invalidOption(name, `one of "user", "project", "both" (got \`${String(value)}\`)`)
  }
  return value as AgentScope
}

/**
 * Normalizes the optional `orchestratorModels` option: an array of
 * `provider/model` strings, one per orchestrator level. `undefined` and an
 * empty array are both treated as "not provided". The array length must not
 * exceed `orchestratorDepth`.
 */
const normalizeOrchestratorModels = (value: unknown, orchestratorDepth: number): string[] | undefined => {
  if (value === undefined) return undefined
  const models = stringArray(value, "orchestratorModels").map((model) =>
    modelString(model, "orchestratorModels"),
  )
  if (models.length === 0) return undefined
  if (models.length > orchestratorDepth) {
    throw new Error(
      `[${PLUGIN_ID}] The \`orchestratorModels\` option has ${models.length} entries but \`orchestratorDepth\` is ${orchestratorDepth}.`,
    )
  }
  return models
}

const validateBlockedTools = (names: string[]): string[] => {
  for (const name of names) {
    if (!BLOCKED_TOOL_PATTERN.test(name)) {
      invalidOption("blockedTools entries", `tool names matching /^[a-z0-9_-]+$/ (got \`${name}\`)`)
    }
  }
  return names
}

export const REQUIRED_MODEL_MESSAGE = `[${PLUGIN_ID}] The \`subagentModel\` option is required, e.g. { "subagentModel": "huggingface/deepseek-v4-flash" }`

export const normalizeOptions = (rawOptions: unknown): NormalizedOptions => {
  const candidate = rawOptions == null ? {} : rawOptions
  if (!isRecord(candidate)) invalidOption("options", "an object")
  const options = candidate as Record<string, unknown>

  if (
    options.subagentModel === undefined ||
    options.subagentModel === null ||
    (typeof options.subagentModel === "string" && options.subagentModel.trim() === "")
  ) {
    throw new Error(REQUIRED_MODEL_MESSAGE)
  }

  const blockedTools = validateBlockedTools(
    options.blockedTools === undefined
      ? [...DEFAULTS.blockedTools]
      : stringArray(options.blockedTools, "blockedTools"),
  )
  const agents = options.agents === undefined ? undefined : stringArray(options.agents, "agents")
  const restrictTask =
    options.restrictTask === undefined ? false : booleanOption(options.restrictTask, "restrictTask")
  const orchestratorDepth =
    options.orchestratorDepth === undefined
      ? 1
      : positiveIntegerOption(options.orchestratorDepth, "orchestratorDepth")
  const orchestratorModels = normalizeOrchestratorModels(options.orchestratorModels, orchestratorDepth)
  const orchestratorModel =
    options.orchestratorModel === undefined ||
    options.orchestratorModel === null ||
    options.orchestratorModel === ""
      ? undefined
      : modelString(options.orchestratorModel, "orchestratorModel")
  const agentModels =
    options.agentModels === undefined ? {} : stringRecord(options.agentModels, "agentModels")
  for (const model of Object.values(agentModels)) modelString(model, "agentModels values")

  return {
    subagentModel: modelString(options.subagentModel, "subagentModel"),
    orchestratorModel,
    orchestratorAgent:
      options.orchestratorAgent === undefined
        ? DEFAULTS.orchestratorAgent
        : nonEmptyString(options.orchestratorAgent, "orchestratorAgent"),
    orchestratorDepth,
    orchestratorModels,
    agents,
    agentModels,
    instructions: optionalString(options.instructions, "instructions"),
    blockedTools,
    restrictTask,
    agentScope: agentScopeOption(options.agentScope, "agentScope"),
  }
}

/**
 * Ordered list of orchestrator level names for the normalized options:
 * `["Manager"]` for depth 1, `["Manager", "Manager-2", "Manager-3"]` for
 * depth 3.
 */
export const orchestratorLevels = (opts: NormalizedOptions): string[] => {
  const names = [opts.orchestratorAgent]
  for (let level = 2; level <= opts.orchestratorDepth; level += 1) {
    names.push(`${opts.orchestratorAgent}-${level}`)
  }
  return names
}

/**
 * Effective model for a delegated worker agent, mirroring the opencode
 * precedence: an explicit `model` in the agent file wins, then
 * `agentModels[name]`, then `subagentModel`.
 */
export const resolveAgentModel = (
  name: string,
  frontmatterModel: string | undefined,
  opts: NormalizedOptions,
): string => frontmatterModel ?? opts.agentModels[name] ?? opts.subagentModel

/**
 * Effective model for an orchestrator level (1-based). Per-level overrides
 * win, then `orchestratorModel`, then nothing (the spawned process falls back
 * to its default model selection).
 */
export const resolveOrchestratorLevelModel = (level: number, opts: NormalizedOptions): string | undefined =>
  opts.orchestratorModels?.[level - 1] ?? opts.orchestratorModel

/**
 * Expands a blocked-tools list (permission keys) to the concrete pi tool
 * names the `tool_call` handler should block.
 */
export const expandBlockedTools = (blockedTools: string[]): string[] => {
  const expanded = new Set<string>()
  for (const key of blockedTools) {
    for (const tool of BLOCKED_TOOL_FAMILIES[key] ?? [key]) expanded.add(tool)
  }
  return [...expanded]
}
