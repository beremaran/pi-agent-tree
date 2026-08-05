import assert from "node:assert/strict"
import test from "node:test"
import {
  DEFAULTS,
  expandBlockedTools,
  normalizeOptions,
  orchestratorLevels,
  REQUIRED_MODEL_MESSAGE,
  resolveAgentModel,
  resolveOrchestratorLevelModel,
} from "../src/options.ts"

const ok = (options: Record<string, unknown>) => normalizeOptions(options)

test("subagentModel is required", () => {
  assert.throws(() => normalizeOptions({}), { message: REQUIRED_MODEL_MESSAGE })
  assert.throws(() => normalizeOptions(undefined), { message: REQUIRED_MODEL_MESSAGE })
  assert.throws(() => normalizeOptions(null), { message: REQUIRED_MODEL_MESSAGE })
  assert.throws(() => normalizeOptions({ subagentModel: "" }), { message: REQUIRED_MODEL_MESSAGE })
  assert.throws(() => normalizeOptions({ subagentModel: "   " }), { message: REQUIRED_MODEL_MESSAGE })
  assert.throws(() => normalizeOptions({ subagentModel: null }), { message: REQUIRED_MODEL_MESSAGE })
})

test("subagentModel must be provider/model format", () => {
  assert.throws(() => ok({ subagentModel: "no-slash" }), /must be a model id like "provider\/model"/)
  assert.throws(() => ok({ subagentModel: "a/b/c" }), /must be a model id like "provider\/model"/)
  assert.throws(
    () => ok({ subagentModel: "openrouter/openai/gpt-5" }),
    /must be a model id like "provider\/model"/,
  )
  assert.throws(() => ok({ subagentModel: "a/ b" }), /must be a model id like "provider\/model"/)
  assert.throws(() => ok({ subagentModel: " /b" }), /must be a model id like "provider\/model"/)
  assert.doesNotThrow(() => ok({ subagentModel: "huggingface/deepseek-v4-flash" }))
  assert.doesNotThrow(() => ok({ subagentModel: "anthropic/claude-sonnet-4-6" }))
  assert.doesNotThrow(() => ok({ subagentModel: "openrouter/gpt-5" }))
})

test("defaults are applied", () => {
  const opts = ok({ subagentModel: "anthropic/claude-sonnet-4-6" })
  assert.equal(opts.orchestratorAgent, DEFAULTS.orchestratorAgent)
  assert.deepEqual(opts.blockedTools, ["edit", "bash"])
  assert.equal(opts.orchestratorDepth, 1)
  assert.equal(opts.agentScope, "user")
  assert.equal(opts.restrictTask, false)
  assert.deepEqual(opts.agentModels, {})
  assert.equal(opts.orchestratorModel, undefined)
  assert.equal(opts.orchestratorModels, undefined)
  assert.equal(opts.instructions, undefined)
})

test("options are normalized", () => {
  const opts = ok({
    subagentModel: "anthropic/claude-haiku-4-5",
    orchestratorModel: "anthropic/claude-opus-4-5",
    orchestratorAgent: "Boss",
    orchestratorDepth: 3,
    orchestratorModels: ["anthropic/claude-opus-4-5", "anthropic/claude-sonnet-4-6"],
    agents: ["general", "explore", "worker"],
    agentModels: { explore: "anthropic/claude-haiku-4-5" },
    instructions: "Never delegate more than 3 subtasks at once.",
    blockedTools: ["bash"],
    restrictTask: true,
    agentScope: "both",
  })
  assert.equal(opts.subagentModel, "anthropic/claude-haiku-4-5")
  assert.equal(opts.orchestratorModel, "anthropic/claude-opus-4-5")
  assert.equal(opts.orchestratorAgent, "Boss")
  assert.equal(opts.orchestratorDepth, 3)
  assert.deepEqual(opts.orchestratorModels, ["anthropic/claude-opus-4-5", "anthropic/claude-sonnet-4-6"])
  assert.deepEqual(opts.agents, ["general", "explore", "worker"])
  assert.deepEqual(opts.agentModels, { explore: "anthropic/claude-haiku-4-5" })
  assert.equal(opts.instructions, "Never delegate more than 3 subtasks at once.")
  assert.deepEqual(opts.blockedTools, ["bash"])
  assert.equal(opts.restrictTask, true)
  assert.equal(opts.agentScope, "both")
})

test("empty strings collapse to undefined for optional strings", () => {
  const opts = ok({ subagentModel: "a/b", orchestratorModel: "", instructions: "" })
  assert.equal(opts.orchestratorModel, undefined)
  assert.equal(opts.instructions, undefined)
})

test("orchestratorDepth must be a positive integer", () => {
  for (const bad of [0, -1, 1.5, "3", null, NaN, true]) {
    assert.throws(() => ok({ subagentModel: "a/b", orchestratorDepth: bad }), /must be a positive integer/)
  }
  assert.equal(ok({ subagentModel: "a/b", orchestratorDepth: 2 }).orchestratorDepth, 2)
})

test("orchestratorModels must not exceed orchestratorDepth", () => {
  assert.throws(
    () => ok({ subagentModel: "a/b", orchestratorDepth: 1, orchestratorModels: ["a/b", "c/d"] }),
    /has 2 entries but `orchestratorDepth` is 1/,
  )
  assert.throws(
    () => ok({ subagentModel: "a/b", orchestratorDepth: 2, orchestratorModels: ["a/b", "nope"] }),
    /must be a model id like "provider\/model"/,
  )
  // Empty array is treated as "not provided".
  const opts = ok({ subagentModel: "a/b", orchestratorDepth: 2, orchestratorModels: [] })
  assert.equal(opts.orchestratorModels, undefined)
})

test("blockedTools entries must match [a-z0-9_-]+", () => {
  assert.throws(() => ok({ subagentModel: "a/b", blockedTools: ["Edit"] }), /must be tool names/)
  assert.throws(() => ok({ subagentModel: "a/b", blockedTools: ["edit tool"] }), /must be tool names/)
  assert.throws(() => ok({ subagentModel: "a/b", blockedTools: [""] }), /must be a non-empty string/)
  assert.doesNotThrow(() => ok({ subagentModel: "a/b", blockedTools: [] }))
  assert.doesNotThrow(() => ok({ subagentModel: "a/b", blockedTools: ["edit", "bash", "webfetch_2"] }))
})

test("agentModels values must be provider/model", () => {
  assert.throws(() => ok({ subagentModel: "a/b", agentModels: { worker: "nope" } }), /must be a model id/)
  assert.doesNotThrow(() =>
    ok({ subagentModel: "a/b", agentModels: { worker: "anthropic/claude-haiku-4-5" } }),
  )
})

test("orchestratorLevels names the chain", () => {
  const opts = ok({ subagentModel: "a/b", orchestratorDepth: 3 })
  assert.deepEqual(orchestratorLevels(opts), ["Manager", "Manager-2", "Manager-3"])
  const boss = ok({ subagentModel: "a/b", orchestratorAgent: "Boss", orchestratorDepth: 1 })
  assert.deepEqual(orchestratorLevels(boss), ["Boss"])
})

test("expandBlockedTools maps permission keys to pi tool names", () => {
  assert.deepEqual(expandBlockedTools(["edit", "bash"]), ["edit", "write", "bash"])
  assert.deepEqual(expandBlockedTools(["bash"]), ["bash"])
  assert.deepEqual(expandBlockedTools(["edit"]), ["edit", "write"])
  assert.deepEqual(expandBlockedTools([]), [])
  assert.deepEqual(expandBlockedTools(["grep", "edit", "bash"]), ["grep", "edit", "write", "bash"])
})

test("resolveAgentModel precedence: explicit frontmatter > agentModels > subagentModel", () => {
  const opts = ok({ subagentModel: "a/s1", agentModels: { worker: "a/w" } })
  assert.equal(resolveAgentModel("worker", undefined, opts), "a/w")
  assert.equal(resolveAgentModel("general", undefined, opts), "a/s1")
  assert.equal(resolveAgentModel("worker", "a/explicit", opts), "a/explicit")
  // agentModels entries keyed to other agents never leak.
  assert.equal(resolveAgentModel("explore", undefined, opts), "a/s1")
})

test("resolveOrchestratorLevelModel: per-level > orchestratorModel > undefined", () => {
  const opts = ok({
    subagentModel: "a/s",
    orchestratorModel: "a/o",
    orchestratorDepth: 3,
    orchestratorModels: ["a/l1"],
  })
  assert.equal(resolveOrchestratorLevelModel(1, opts), "a/l1")
  assert.equal(resolveOrchestratorLevelModel(2, opts), "a/o")
  assert.equal(resolveOrchestratorLevelModel(3, opts), "a/o")
  const bare = ok({ subagentModel: "a/s" })
  assert.equal(resolveOrchestratorLevelModel(1, bare), undefined)
})
