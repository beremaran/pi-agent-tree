/**
 * Subagent discovery and built-in defaults for @beremaran/pi-agent-tree.
 *
 * The extension ships two built-in subagents (`general`, `explore`) modeled on
 * opencode's built-ins. User agent files (`~/.pi/agent/agents/*.md`) override
 * them by name; project-local agent files (`.pi/agents/*.md`) override both
 * when the configured `agentScope` includes them.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent"
import { type AgentScope, DEFAULT_WORKER_TOOLS } from "./options.ts"

export type { AgentScope }

export interface AgentConfig {
  name: string
  description: string
  tools?: string[]
  model?: string
  systemPrompt: string
  source: "user" | "project" | "builtin"
  filePath?: string
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[]
  projectAgentsDir: string | null
}

/**
 * Built-in subagent definitions. `general` gets the default worker toolset
 * (including hands-on tools); `explore` is a read-only research agent. Both
 * are modeled on opencode's built-in `general`/`explore` subagents.
 */
const BUILTIN_DEFAULTS: AgentConfig[] = [
  {
    name: "general",
    description:
      "General-purpose implementation subagent: implements, refactors, tests, and fixes anything that lacks a more specific subagent.",
    tools: [...DEFAULT_WORKER_TOOLS],
    systemPrompt: `You are a general-purpose implementation subagent.

Complete the task you were delegated completely and carefully:
- Read files before editing them to understand the current state.
- Make focused, correct changes; keep scope tight.
- Verify your work (run tests/type checks when the project has them).
- Report back: what you changed, how you verified it, and anything you could not do.`,
    source: "builtin",
  },
  {
    name: "explore",
    description:
      "Fast codebase research: locate code, understand existing implementations, and gather context for a brief.",
    tools: ["read", "grep", "find", "ls"],
    systemPrompt: `You are a codebase research subagent.

Your job is to explore and report, not to change anything:
- Locate the relevant code for the question you were delegated.
- Understand existing implementations and note the important details.
- Report back with concrete file paths, key symbols, and a concise summary the delegating orchestrator can act on.`,
    source: "builtin",
  },
]

const _builtinByName = new Map(BUILTIN_DEFAULTS.map((agent) => [agent.name, agent]))

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
  const agents: AgentConfig[] = []

  if (!fs.existsSync(dir)) {
    return agents
  }

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return agents
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue
    if (!entry.isFile() && !entry.isSymbolicLink()) continue

    const filePath = path.join(dir, entry.name)
    let content: string
    try {
      content = fs.readFileSync(filePath, "utf-8")
    } catch {
      continue
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content)

    if (!frontmatter.name || !frontmatter.description) {
      continue
    }

    const tools = frontmatter.tools
      ?.split(",")
      .map((tool: string) => tool.trim())
      .filter(Boolean)

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      systemPrompt: body,
      source,
      filePath,
    })
  }

  return agents
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd
  while (true) {
    const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents")
    if (isDirectory(candidate)) return candidate

    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) return null
    currentDir = parentDir
  }
}

/**
 * Discovers subagents for the given scope. Built-in defaults are always
 * present; user agent files override them by name; project agent files
 * override both when the scope includes them.
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), "agents")
  const projectAgentsDir = findNearestProjectAgentsDir(cwd)

  const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user")
  const projectAgents =
    scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project")

  const agentMap = new Map<string, AgentConfig>()
  for (const agent of BUILTIN_DEFAULTS) agentMap.set(agent.name, { ...agent })
  for (const agent of userAgents) agentMap.set(agent.name, agent)
  for (const agent of projectAgents) agentMap.set(agent.name, agent)

  return { agents: Array.from(agentMap.values()), projectAgentsDir }
}

export function formatAgentList(
  agents: AgentConfig[],
  maxItems: number,
): { text: string; remaining: number } {
  if (agents.length === 0) return { text: "none", remaining: 0 }
  const listed = agents.slice(0, maxItems)
  const remaining = agents.length - listed.length
  return {
    text: listed.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("; "),
    remaining,
  }
}
