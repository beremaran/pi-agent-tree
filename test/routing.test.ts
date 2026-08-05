import assert from "node:assert/strict"
import test from "node:test"
import { normalizeOptions } from "../src/options.ts"
import { type LevelContext, levelContextFromEnv, planDelegation, routedTargets } from "../src/subagent.ts"

const opts = (extra: Record<string, unknown> = {}) => normalizeOptions({ subagentModel: "a/b", ...extra })

const agent = (name: string) => ({
  name,
  description: `desc of ${name}`,
  systemPrompt: `prompt of ${name}`,
  source: "user" as const,
})

const agents = [agent("general"), agent("explore"), agent("worker")]

const ctx = (env: Record<string, string> = {}): LevelContext => levelContextFromEnv(opts(), env)

test("levelContextFromEnv: top-level defaults to orchestrator level 1", () => {
  const c = ctx()
  assert.deepEqual(c, { role: "orchestrator", level: 1, depth: 1 })
})

test("levelContextFromEnv: worker role", () => {
  const c = ctx({ PI_AGENT_TREE_ROLE: "worker" })
  assert.equal(c.role, "worker")
})

test("levelContextFromEnv: spawned orchestrator levels read level/depth", () => {
  const c = ctx({ PI_AGENT_TREE_ROLE: "orchestrator", PI_AGENT_TREE_LEVEL: "2", PI_AGENT_TREE_DEPTH: "3" })
  assert.deepEqual(c, { role: "orchestrator", level: 2, depth: 3 })
})

test("levelContextFromEnv: malformed level/depth fall back to defaults", () => {
  const c = ctx({ PI_AGENT_TREE_ROLE: "orchestrator", PI_AGENT_TREE_LEVEL: "x", PI_AGENT_TREE_DEPTH: "-1" })
  assert.deepEqual(c, { role: "orchestrator", level: 1, depth: 1 })
})

test("routedTargets: explicit agents list wins", () => {
  assert.deepEqual(routedTargets(opts({ agents: ["worker"] }), agents), ["worker"])
})

test("routedTargets: defaults to every discovered agent", () => {
  assert.deepEqual(routedTargets(opts(), agents), ["general", "explore", "worker"])
})

test("planDelegation: workers cannot delegate", () => {
  const plan = planDelegation(opts(), { role: "worker", level: 1, depth: 1 }, "general", agents)
  assert.equal(typeof plan, "string")
  assert.match(plan as string, /not available to worker subagents/)
})

test("planDelegation: depth 1 final level accepts any discovered agent", () => {
  assert.deepEqual(planDelegation(opts(), ctx(), "general", agents), { kind: "worker", agent: agents[0] })
  assert.deepEqual(planDelegation(opts(), ctx(), "worker", agents), { kind: "worker", agent: agents[2] })
})

test("planDelegation: unknown agent is rejected with the available list", () => {
  const plan = planDelegation(opts(), ctx(), "ghost", agents)
  assert.equal(typeof plan, "string")
  assert.match(plan as string, /Unknown subagent "ghost"/)
  assert.match(plan as string, /Available subagents/)
})

test("planDelegation: intermediate levels are structurally pinned to the next level", () => {
  const chain = opts({ orchestratorAgent: "Boss", orchestratorDepth: 3 })
  const intermediate = { role: "orchestrator", level: 1, depth: 3 } as LevelContext
  const plan = planDelegation(chain, intermediate, "Boss-2", agents)
  assert.deepEqual(plan, { kind: "nextLevel", level: 2, name: "Boss-2" })

  const wrong = planDelegation(chain, intermediate, "general", agents)
  assert.equal(typeof wrong, "string")
  assert.match(wrong as string, /may only delegate to "Boss-2"/)
})

test("planDelegation: the final level of a chain delegates to workers", () => {
  const chain = opts({ orchestratorAgent: "Boss", orchestratorDepth: 3 })
  const finalLevel = { role: "orchestrator", level: 3, depth: 3 } as LevelContext
  assert.deepEqual(planDelegation(chain, finalLevel, "general", agents), { kind: "worker", agent: agents[0] })
})

test("planDelegation: restrictTask closes the unrestricted-agent loophole", () => {
  const restricted = opts({ restrictTask: true, agents: ["general"] })
  const plan = planDelegation(restricted, ctx(), "worker", agents)
  assert.equal(typeof plan, "string")
  assert.match(plan as string, /not a routed subagent/)

  assert.deepEqual(planDelegation(restricted, ctx(), "general", agents), { kind: "worker", agent: agents[0] })
})

test("planDelegation: without restrictTask, non-routed discovered agents are still reachable", () => {
  const plan = planDelegation(opts({ agents: ["general"] }), ctx(), "worker", agents)
  assert.deepEqual(plan, { kind: "worker", agent: agents[2] })
})
