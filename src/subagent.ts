/**
 * The `task` tool — the delegation engine of @beremaran/pi-agent-tree.
 *
 * Delegates a subtask to a subagent by spawning a fresh `pi` process in JSON
 * mode (isolated context), exactly like the reference subagent extension but
 * restricted to a single-target call mirroring opencode's `task` tool:
 *
 * - The orchestrator (top-level session or a spawned orchestrator level)
 *   calls `task` with `{ agent, task }`.
 * - Workers are spawned with the routed model, the agent's tools (never the
 *   `task` tool by default), and the agent's system prompt.
 * - With `orchestratorDepth > 1`, intermediate levels may only delegate to
 *   the next level; the spawned level receives the level directive, the
 *   read-only + `task` toolset, and a role marker in the environment so the
 *   extension in that process keeps enforcing the block without installing
 *   the top-level directive twice.
 */

import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core"
import type { Message, Usage } from "@earendil-works/pi-ai"
import { StringEnum } from "@earendil-works/pi-ai"
import type {
  Theme,
  ThemeColor,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent"
import { getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent"
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui"
import { type Static, Type } from "typebox"
import { type AgentConfig, discoverAgents, formatAgentList } from "./agents.ts"
import { orchestratorDirective } from "./directive.ts"
import {
  DEFAULT_ORCHESTRATOR_TOOLS,
  DEFAULT_WORKER_TOOLS,
  type NormalizedOptions,
  resolveAgentModel,
  resolveOrchestratorLevelModel,
} from "./options.ts"

export const PI_ROLE_ENV = "PI_AGENT_TREE_ROLE"
export const PI_LEVEL_ENV = "PI_AGENT_TREE_LEVEL"
export const PI_DEPTH_ENV = "PI_AGENT_TREE_DEPTH"

/**
 * Mode handed from the parent to spawned subagent processes. The mode is off
 * by default now, so spawned orchestrator levels inherit the parent's toggle
 * through this env var and keep delegating (workers ignore it: they have no
 * `task` tool and are never treated as orchestrators).
 */
export const PI_MODE_ENV = "PI_AGENT_TREE_MODE"

/**
 * Resolved options handed from the parent process to spawned subagent
 * processes. Children prefer this over file-based config so a delegation
 * always runs with exactly the options the parent validated, regardless of
 * the child's project-trust state.
 */
export const PI_CONFIG_ENV = "PI_AGENT_TREE_CONFIG"

export type DelegationRole = "orchestrator" | "worker"

export interface LevelContext {
  /** The current process's role in the delegation tree. */
  role: DelegationRole
  /** 1-based orchestrator level. Only meaningful when role === "orchestrator". */
  level: number
  /** Configured chain depth. Only meaningful when role === "orchestrator". */
  depth: number
}

/**
 * Resolves the current process's role in the delegation tree from the
 * environment. The top-level session runs with no role markers and is treated
 * as orchestrator level 1.
 */
export const levelContextFromEnv = (
  opts: NormalizedOptions,
  env: NodeJS.ProcessEnv = process.env,
): LevelContext => {
  const role = env[PI_ROLE_ENV]
  if (role === "worker") return { role: "worker", level: 1, depth: opts.orchestratorDepth }
  if (role === "orchestrator") {
    const rawLevel = Number(env[PI_LEVEL_ENV])
    const rawDepth = Number(env[PI_DEPTH_ENV])
    return {
      role: "orchestrator",
      level: Number.isInteger(rawLevel) && rawLevel >= 1 ? rawLevel : 1,
      depth: Number.isInteger(rawDepth) && rawDepth >= 1 ? rawDepth : opts.orchestratorDepth,
    }
  }
  return { role: "orchestrator", level: 1, depth: opts.orchestratorDepth }
}

/**
 * Names of the routed subagents for the given options: an explicit `agents`
 * list wins, otherwise every discovered agent (built-ins included).
 */
export const routedTargets = (opts: NormalizedOptions, agents: AgentConfig[]): string[] =>
  opts.agents ?? agents.map((agent) => agent.name)

export type DelegationPlan =
  | { kind: "worker"; agent: AgentConfig }
  | { kind: "nextLevel"; level: number; name: string }

/**
 * Validates a `task` target for the current level context and returns the
 * spawn plan (worker or next orchestrator level), or a user-facing error
 * string. Mirror of the opencode plugin's structural task pinning.
 */
export const planDelegation = (
  opts: NormalizedOptions,
  context: LevelContext,
  agentName: string,
  agents: AgentConfig[],
): DelegationPlan | string => {
  if (context.role === "worker") {
    return "The task tool is not available to worker subagents — workers do hands-on work directly."
  }

  const isFinalLevel = context.level === context.depth

  if (!isFinalLevel) {
    const nextName = `${opts.orchestratorAgent}-${context.level + 1}`
    if (agentName !== nextName) {
      return `Orchestrator level ${context.level} of ${context.depth} may only delegate to "${nextName}". Delegate the subtask there instead.`
    }
    return { kind: "nextLevel", level: context.level + 1, name: nextName }
  }

  const target = agents.find((agent) => agent.name === agentName)
  const routed = routedTargets(opts, agents)
  if (opts.restrictTask && !routed.includes(agentName)) {
    const { text } = formatAgentList(
      routed
        .map((name) => agents.find((agent) => agent.name === name))
        .filter((a): a is AgentConfig => Boolean(a)),
      8,
    )
    return `restrictTask is on: "${agentName}" is not a routed subagent. Routed subagents: ${text}.`
  }
  if (!target) {
    const { text } = formatAgentList(agents, 8)
    return `Unknown subagent "${agentName}". Available subagents: ${text}.`
  }
  return { kind: "worker", agent: target }
}

interface UsageStats {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  contextTokens: number
  turns: number
}

export interface TaskDetails {
  agent: string
  agentSource: AgentConfig["source"] | "unknown" | "orchestrator-level"
  targetKind: "worker" | "orchestrator-level"
  task: string
  exitCode: number
  messages: Message[]
  stderr: string
  usage: UsageStats
  model?: string
  stopReason?: string
  errorMessage?: string
}

export const EMPTY_USAGE: UsageStats = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
}

/** Converts accumulated subagent usage into a pi-ai `Usage` for accounting. */
export const usageToPiUsage = (usage: UsageStats): Usage => ({
  input: usage.input,
  output: usage.output,
  cacheRead: usage.cacheRead,
  cacheWrite: usage.cacheWrite,
  totalTokens: usage.contextTokens,
  cost: {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    total: usage.cost,
  },
})

const getFinalOutput = (messages: Message[]): string => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text
      }
    }
  }
  return ""
}

const isFailedResult = (result: TaskDetails): boolean =>
  result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted"

const getResultOutput = (result: TaskDetails): string => {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"
  }
  return getFinalOutput(result.messages) || "(no output)"
}

type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> }

const getDisplayItems = (messages: Message[]): DisplayItem[] => {
  const items: DisplayItem[] = []
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text })
        else if (part.type === "toolCall") {
          const raw = part.arguments
          let args: Record<string, unknown> = {}
          if (typeof raw === "string") {
            try {
              args = JSON.parse(raw) as Record<string, unknown>
            } catch {
              /* keep {} */
            }
          } else if (raw && typeof raw === "object") {
            args = raw as Record<string, unknown>
          }
          items.push({ type: "toolCall", name: part.name, args })
        }
      }
    }
  }
  return items
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  return `${(count / 1000000).toFixed(1)}M`
}

function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = []
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`)
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`)
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`)
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`)
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`)
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`)
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`)
  }
  if (model) parts.push(model)
  return parts.join(" ")
}

function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: ThemeColor, text: string) => string,
): string {
  const shortenPath = (p: string) => {
    const home = os.homedir()
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p
  }

  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "..."
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview)
    }
    case "read": {
      const rawPath = (args.path || "...") as string
      const filePath = shortenPath(rawPath)
      const offset = args.offset as number | undefined
      const limit = args.limit as number | undefined
      let text = themeFg("accent", filePath)
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1
        const endLine = limit !== undefined ? startLine + limit - 1 : ""
        text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`)
      }
      return themeFg("muted", "read ") + text
    }
    case "write": {
      const rawPath = (args.path || "...") as string
      const filePath = shortenPath(rawPath)
      const content = (args.content || "") as string
      const lines = content.split("\n").length
      let text = themeFg("muted", "write ") + themeFg("accent", filePath)
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`)
      return text
    }
    case "edit": {
      const rawPath = (args.path || "...") as string
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath))
    }
    case "ls": {
      const rawPath = (args.path || ".") as string
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath))
    }
    case "find": {
      const pattern = (args.pattern || "*") as string
      const rawPath = (args.path || ".") as string
      return (
        themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`)
      )
    }
    case "grep": {
      const pattern = (args.pattern || "") as string
      const rawPath = (args.path || ".") as string
      return (
        themeFg("muted", "grep ") +
        themeFg("accent", `/${pattern}/`) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      )
    }
    default: {
      const argsStr = JSON.stringify(args)
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`)
    }
  }
}

async function writePromptToTempFile(
  name: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-agent-tree-"))
  const safeName = name.replace(/[^\w.-]+/g, "_")
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`)
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 })
  })
  return { dir: tmpDir, filePath }
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1]
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/")
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] }
  }

  const execName = path.basename(process.execPath).toLowerCase()
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
  if (!isGenericRuntime) {
    return { command: process.execPath, args }
  }

  return { command: "pi", args }
}

/**
 * The extension entry (src/index.ts) relative to this module. Used to
 * propagate `-e` to spawned subagent processes so orchestrator levels keep
 * the `task` tool and the hard block even when the extension was loaded via
 * the CLI flag rather than an installed package or `~/.pi/agent/extensions`.
 */
const EXTENSION_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts")

/**
 * When the current process was launched with `-e`/`--extension` pointing at
 * this extension, returns the flags to forward to spawned subagent processes.
 * Installed (settings/packages) extensions are loaded by every pi process
 * automatically, so nothing needs to be propagated in that case.
 */
const extensionPropagationArgs = (): string[] => {
  const argv = process.argv
  const flags: string[] = []
  for (let i = 0; i < argv.length - 1; i += 1) {
    const flag = argv[i]
    if (flag === "-a" || flag === "--approve") {
      // Children run non-interactively in the same project; propagate the
      // parent's project-trust decision so project-local agents/config keep
      // working inside delegations.
      flags.push(flag)
      continue
    }
    if (flag !== "-e" && flag !== "--extension") continue
    const candidate = argv[i + 1]
    try {
      if (fs.realpathSync(candidate) === fs.realpathSync(EXTENSION_ENTRY)) {
        flags.push(flag, candidate)
      }
    } catch {
      /* ignore: candidate is not a file (e.g. an npm: spec) */
    }
  }
  return flags
}

const PROPAGATION_ARGS = extensionPropagationArgs()

interface SpawnPlan {
  kind: "worker" | "orchestrator-level"
  displayName: string
  args: string[]
  env: Record<string, string>
}

/**
 * Builds the spawn plan for a delegation. Workers get the routed model, the
 * agent's tools (defaults to the worker toolset, never `task`), and the
 * agent's system prompt. Orchestrator levels get the level directive, the
 * read-only + `task` toolset, and their resolved level model.
 */
export const buildSpawnPlan = async (
  opts: NormalizedOptions,
  context: LevelContext,
  plan: DelegationPlan,
  task: string,
  modeOn: boolean,
): Promise<SpawnPlan> => {
  // Extension propagation: when the parent runs with -e, the child needs the
  // same flag so orchestrator levels get the task tool and the hard block.
  // Installed extensions (settings/packages) load automatically in children.
  const args = [...PROPAGATION_ARGS, "--mode", "json", "-p", "--no-session"]
  // Children must honor the parent's mode toggle (the mode defaults to off).
  const modeEnv = { [PI_MODE_ENV]: modeOn ? "on" : "off" }

  if (plan.kind === "worker") {
    const agent = plan.agent
    const model = resolveAgentModel(agent.name, agent.model, opts)
    if (model) args.push("--model", model)
    const tools = agent.tools && agent.tools.length > 0 ? agent.tools : DEFAULT_WORKER_TOOLS
    args.push("--tools", tools.join(","))

    const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt)
    args.push("--append-system-prompt", tmp.filePath)
    args.push(`Task: ${task}`)

    return {
      kind: "worker",
      displayName: agent.name,
      args,
      env: { [PI_ROLE_ENV]: "worker", [PI_CONFIG_ENV]: JSON.stringify(opts), ...modeEnv },
    }
  }

  // Orchestrator level: spawned with the level directive and the orchestrator
  // toolset. The temp file is deleted by the caller after the process exits.
  const levelModel = resolveOrchestratorLevelModel(plan.level, opts)
  if (levelModel) args.push("--model", levelModel)
  args.push("--tools", DEFAULT_ORCHESTRATOR_TOOLS.join(","))

  const directive = orchestratorDirective(opts, plan.level, context.depth, undefined)
  const tmp = await writePromptToTempFile(plan.name, directive)
  args.push("--append-system-prompt", tmp.filePath)
  args.push(`Task: ${task}`)

  return {
    kind: "orchestrator-level",
    displayName: plan.name,
    args,
    env: {
      [PI_ROLE_ENV]: "orchestrator",
      [PI_LEVEL_ENV]: String(plan.level),
      [PI_DEPTH_ENV]: String(context.depth),
      [PI_CONFIG_ENV]: JSON.stringify(opts),
      ...modeEnv,
    },
  }
}

/** Removes the `--append-system-prompt <path>` temp files from a spawn plan. */
const cleanupPromptFiles = (args: string[]): void => {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === "--append-system-prompt") {
      const filePath = args[i + 1]
      try {
        fs.unlinkSync(filePath)
      } catch {
        /* ignore */
      }
      try {
        fs.rmdirSync(path.dirname(filePath))
      } catch {
        /* ignore */
      }
    }
  }
}

export interface DelegationResult {
  content: string
  details: TaskDetails
  isError: boolean
}

export const runDelegatedTask = async (
  opts: NormalizedOptions,
  context: LevelContext,
  agentName: string,
  task: string,
  spawnCwd: string | undefined,
  discoveryCwd: string,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback | undefined,
  modeOn: boolean,
): Promise<DelegationResult> => {
  const agents = discoverAgents(discoveryCwd, opts.agentScope).agents
  const plan = planDelegation(opts, context, agentName, agents)
  if (typeof plan === "string") {
    return {
      content: plan,
      details: {
        agent: agentName,
        agentSource: "unknown",
        targetKind: "worker",
        task,
        exitCode: 1,
        messages: [],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      },
      isError: true,
    }
  }

  const spawnPlan = await buildSpawnPlan(opts, context, plan, task, modeOn)

  const currentResult: TaskDetails = {
    agent: spawnPlan.displayName,
    agentSource: plan.kind === "worker" ? plan.agent.source : "orchestrator-level",
    targetKind: spawnPlan.kind,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { ...EMPTY_USAGE },
    model: plan.kind === "worker" ? plan.agent.model : undefined,
  }

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
        details: currentResult,
      })
    }
  }

  let wasAborted = false
  try {
    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(spawnPlan.args)
      const proc = spawn(invocation.command, invocation.args, {
        cwd: spawnCwd ?? process.cwd(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...spawnPlan.env },
      })
      let buffer = ""

      const processLine = (line: string) => {
        if (!line.trim()) return
        let event: { type?: string; message?: Message }
        try {
          event = JSON.parse(line) as { type?: string; message?: Message }
        } catch {
          return
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message
          currentResult.messages.push(msg)

          if (msg.role === "assistant") {
            currentResult.usage.turns += 1
            const usage = msg.usage
            if (usage) {
              currentResult.usage.input += usage.input || 0
              currentResult.usage.output += usage.output || 0
              currentResult.usage.cacheRead += usage.cacheRead || 0
              currentResult.usage.cacheWrite += usage.cacheWrite || 0
              currentResult.usage.cost += usage.cost?.total || 0
              currentResult.usage.contextTokens = usage.totalTokens || 0
            }
            if (!currentResult.model && msg.model) currentResult.model = msg.model
            if (msg.stopReason) currentResult.stopReason = msg.stopReason
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage
          }
          emitUpdate()
        }

        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message)
          emitUpdate()
        }
      }

      proc.stdout.on("data", (data) => {
        buffer += data.toString()
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""
        for (const line of lines) processLine(line)
      })

      proc.stderr.on("data", (data) => {
        currentResult.stderr += data.toString()
      })

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer)
        resolve(code ?? 0)
      })

      proc.on("error", () => {
        resolve(1)
      })

      if (signal) {
        const killProc = () => {
          wasAborted = true
          proc.kill("SIGTERM")
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL")
          }, 5000)
        }
        if (signal.aborted) killProc()
        else signal.addEventListener("abort", killProc, { once: true })
      }
    })

    currentResult.exitCode = exitCode
    if (wasAborted) throw new Error("Subagent was aborted")
  } finally {
    cleanupPromptFiles(spawnPlan.args)
  }

  const isError = isFailedResult(currentResult)
  return {
    content: isError
      ? `Subagent "${spawnPlan.displayName}" failed: ${getResultOutput(currentResult)}`
      : getResultOutput(currentResult),
    details: currentResult,
    isError,
  }
}

export const taskToolParams = Type.Object({
  agent: Type.String({
    description:
      "Name of the subagent to delegate to (e.g. general, explore, or a custom agent defined in an agent file).",
  }),
  task: Type.String({
    description:
      "Complete, self-contained brief: goal, constraints, files involved, verification steps, and exactly what to report back.",
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the subagent process (defaults to the current project).",
    }),
  ),
  agentScope: Type.Optional(
    StringEnum(["user", "project", "both"] as const, {
      description: 'Agent scope for this delegation: "user" (default), "project", or "both".',
      default: "user",
    }),
  ),
})

type TaskParams = Static<typeof taskToolParams>

const COLLAPSED_ITEM_COUNT = 10

export const taskTool = (
  getOpts: () => NormalizedOptions | null,
  isModeOn: () => boolean,
): ToolDefinition<typeof taskToolParams, TaskDetails> => ({
  name: "task",
  label: "Task",
  description: [
    "Delegate a subtask to a subagent with an isolated context window.",
    "Every delegation spawns a fresh subagent process; give each one a complete, self-contained brief.",
    'Default agent scope is "user" (from ~/.pi/agent/agents); project agents (.pi/agents) require agentScope "project" or "both".',
  ].join(" "),
  promptSnippet: "Delegate subtasks to subagents via task",
  promptGuidelines: [
    "Use task to delegate every implementation subtask to a subagent instead of doing hands-on work yourself.",
  ],
  parameters: taskToolParams,

  async execute(
    _toolCallId: string,
    params: TaskParams,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback | undefined,
    ctx: { cwd: string },
  ): Promise<AgentToolResult<TaskDetails>> {
    const opts = getOpts()
    if (!opts) {
      return {
        content: [
          {
            type: "text",
            text: "pi-agent-tree is not configured: the `subagentModel` option is required (see the log for details).",
          },
        ],
        details: {
          agent: params.agent,
          agentSource: "unknown",
          targetKind: "worker",
          task: params.task,
          exitCode: 1,
          messages: [],
          stderr: "",
          usage: { ...EMPTY_USAGE },
        },
      }
    }
    if (!isModeOn()) {
      return {
        content: [
          {
            type: "text",
            text: "Orchestrator mode is off (press Ctrl+Shift+Tab or run `/agent-tree on`). The task tool is disabled.",
          },
        ],
        details: {
          agent: params.agent,
          agentSource: "unknown",
          targetKind: "worker",
          task: params.task,
          exitCode: 1,
          messages: [],
          stderr: "",
          usage: { ...EMPTY_USAGE },
        },
      }
    }

    const result = await runDelegatedTask(
      { ...opts, agentScope: params.agentScope ?? opts.agentScope },
      levelContextFromEnv(opts),
      params.agent,
      params.task,
      params.cwd,
      ctx.cwd,
      signal,
      onUpdate,
      isModeOn(),
    )
    return {
      content: [{ type: "text", text: result.content }],
      details: result.details,
      usage: usageToPiUsage(result.details.usage),
    }
  },

  renderCall(args: TaskParams, theme: Theme, _context: unknown) {
    const agentName = args.agent || "..."
    const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "..."
    const text =
      theme.fg("toolTitle", theme.bold("task ")) +
      theme.fg("accent", agentName) +
      `\n  ${theme.fg("dim", preview)}`
    return new Text(text, 0, 0)
  },

  renderResult(
    result: AgentToolResult<TaskDetails>,
    { expanded }: ToolRenderResultOptions,
    theme: Theme,
    _context: unknown,
  ) {
    const details = result.details
    if (!details || details.messages.length === 0) {
      const text = result.content[0]
      return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0)
    }

    const mdTheme = getMarkdownTheme()
    const isError = isFailedResult(details)
    const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓")
    const displayItems = getDisplayItems(details.messages)
    const finalOutput = getFinalOutput(details.messages)

    if (expanded) {
      const container = new Container()
      let header = `${icon} ${theme.fg("toolTitle", theme.bold(details.agent))}${theme.fg("muted", ` (${details.agentSource})`)}`
      if (isError && details.stopReason) header += ` ${theme.fg("error", `[${details.stopReason}]`)}`
      container.addChild(new Text(header, 0, 0))
      if (isError && details.errorMessage)
        container.addChild(new Text(theme.fg("error", `Error: ${details.errorMessage}`), 0, 0))
      container.addChild(new Spacer(1))
      container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0))
      container.addChild(new Text(theme.fg("dim", details.task), 0, 0))
      container.addChild(new Spacer(1))
      container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0))
      if (displayItems.length === 0 && !finalOutput) {
        container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0))
      } else {
        for (const item of displayItems) {
          if (item.type === "toolCall") {
            container.addChild(
              new Text(
                theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                0,
                0,
              ),
            )
          }
        }
        if (finalOutput) {
          container.addChild(new Spacer(1))
          container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme))
        }
      }
      const usageStr = formatUsageStats(details.usage, details.model)
      if (usageStr) {
        container.addChild(new Spacer(1))
        container.addChild(new Text(theme.fg("dim", usageStr), 0, 0))
      }
      return container
    }

    let text = `${icon} ${theme.fg("toolTitle", theme.bold(details.agent))}${theme.fg("muted", ` (${details.agentSource})`)}`
    if (isError && details.stopReason) text += ` ${theme.fg("error", `[${details.stopReason}]`)}`
    if (isError && details.errorMessage) text += `\n${theme.fg("error", `Error: ${details.errorMessage}`)}`
    else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`
    else {
      const toShow = displayItems.slice(-COLLAPSED_ITEM_COUNT)
      const skipped = displayItems.length - toShow.length
      if (skipped > 0) text += `\n${theme.fg("muted", `... ${skipped} earlier items`)}`
      for (const item of toShow) {
        if (item.type === "text") {
          const preview = item.text.split("\n").slice(0, 3).join("\n")
          text += `\n${theme.fg("toolOutput", preview)}`
        } else {
          text += `\n${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}`
        }
      }
      if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`
    }
    const usageStr = formatUsageStats(details.usage, details.model)
    if (usageStr) text += `\n${theme.fg("dim", usageStr)}`
    return new Text(text, 0, 0)
  },
})
