import assert from "node:assert/strict"
import test from "node:test"
import { LEVEL1_DIRECTIVE_MARKER, levelDirectiveMarker, orchestratorDirective } from "../src/directive.ts"
import { normalizeOptions } from "../src/options.ts"

const directive = (options: Record<string, unknown>, level: number, depth: number, nextName?: string) =>
  orchestratorDirective(normalizeOptions(options), level, depth, nextName)

test("level-1 directive is byte-exact with defaults", () => {
  const rendered = directive({ subagentModel: "anthropic/claude-sonnet-4-6" }, 1, 1)
  assert.equal(
    rendered,
    `# Orchestrator Mode (enforced by @beremaran/pi-agent-tree)

You are the ORCHESTRATOR. You do not do hands-on work. You plan, decompose, delegate, and review.

## Non-negotiable rules
1. Treat every user request as a project: decompose it into discrete, independently verifiable subtasks before touching anything.
2. Keep subtasks SMALL. A subtask is one concern: one file or a small cluster of related files, one bug, one component, one test area. If a brief needs many steps, spans unrelated areas, or would produce a report as long as the original request, split it further — never hand a monolithic task to a single subagent.
3. Delegate EVERY subtask with the \`task\` tool to a subagent. Never bundle several subtasks into one delegation, and never perform implementation work yourself.
4. You only: plan, write subtask briefs, dispatch agents, review their reports, and summarize results for the user.
5. Fan out: dispatch independent subtasks as several small \`task\` calls in a single message — more, smaller subagents in parallel beats one big delegation. Never run dependent subtasks concurrently; wait for each result before dispatching the next.
6. Give each subagent a complete, self-contained brief: goal, constraints, files involved, verification steps, and exactly what to report back.
7. Review every subagent report. If work is incomplete or wrong, delegate the fix to a subagent — never fix it yourself.
8. Subagents are stateless: every delegation is a fresh subagent with its own context, so carry over all needed context in each brief.
9. Keep the user informed: report what was delegated to whom, the results, blockers, and the final state.

## Subtask sizing
- Split a request along its seams: separate files, functions, concerns, or verification steps each become their own subtask.
- A subtask is TOO BIG if: it touches many unrelated files, its brief runs more than a few paragraphs, a subagent could not finish and report back in one focused pass, or you cannot verify its result in isolation.
- When in doubt, split again — an extra small subagent costs less than one bloated delegation.

## Tool discipline
- \`task\` for all work (mandatory); \`read\`/\`grep\`/\`find\`/\`ls\` only when needed to write a better brief or verify a result.
- Hands-on tools are hard-blocked for you (edit, bash). If a subagent lacks a tool it needs, tell the user instead of doing it yourself.

## Default delegation
- \`explore\` — codebase research, locating code, understanding existing implementations.
- \`general\` — implementation, refactoring, testing, and any task without a more specific subagent.
- Prefer the most specialized subagent for each subtask; fall back to \`general\`.`,
  )
})

test("blockedTools and instructions are substituted", () => {
  const rendered = directive(
    {
      subagentModel: "a/b",
      blockedTools: ["bash"],
      instructions: "Never delegate more than 3 subtasks at once.",
    },
    1,
    1,
  )
  assert.ok(
    rendered.includes(
      "- Hands-on tools are hard-blocked for you (bash). If a subagent lacks a tool it needs, tell the user instead of doing it yourself.",
    ),
  )
  assert.ok(rendered.endsWith("fall back to `general`.\n\nNever delegate more than 3 subtasks at once."))
})

test("directive nudges small-chunk decomposition and parallel fan-out", () => {
  const rendered = directive({ subagentModel: "a/b" }, 1, 1)
  assert.ok(rendered.includes("Keep subtasks SMALL."))
  assert.ok(rendered.includes("never hand a monolithic task to a single subagent"))
  assert.ok(rendered.includes("Never bundle several subtasks into one delegation"))
  assert.ok(rendered.includes("more, smaller subagents in parallel beats one big delegation"))
  assert.ok(rendered.includes("When in doubt, split again"))
  assert.ok(rendered.includes("## Subtask sizing"))
})

test("empty blockedTools renders 'none'", () => {
  const rendered = directive({ subagentModel: "a/b", blockedTools: [] }, 1, 1)
  assert.ok(
    rendered.includes(
      "- Hands-on tools are hard-blocked for you (none). If a subagent lacks a tool it needs, tell the user instead of doing it yourself.",
    ),
  )
})

test("level markers", () => {
  assert.equal(levelDirectiveMarker(1, 1), LEVEL1_DIRECTIVE_MARKER)
  assert.equal(levelDirectiveMarker(1, 3), LEVEL1_DIRECTIVE_MARKER)
  assert.equal(
    levelDirectiveMarker(2, 3),
    "# Orchestrator Mode (level 2/3, enforced by @beremaran/pi-agent-tree)",
  )
})

test("intermediate level directive pins delegation to the next level", () => {
  const rendered = directive(
    { subagentModel: "a/b", orchestratorAgent: "Boss", orchestratorDepth: 3 },
    1,
    3,
    "Boss-2",
  )
  assert.ok(rendered.startsWith(LEVEL1_DIRECTIVE_MARKER))
  assert.ok(rendered.includes("Delegate EVERY subtask with the `task` tool, and ONLY to `Boss-2`."))
  assert.ok(rendered.includes("Your only `task` target is `Boss-2`."))
  assert.ok(rendered.includes("never hand a monolithic task to `Boss-2`"))
  assert.ok(rendered.includes("more, smaller delegations to `Boss-2` in parallel beats one big delegation"))
  // Intermediate levels have no Default delegation section.
  assert.ok(!rendered.includes("## Default delegation"))
})

test("final level directive delegates to the routed subagents", () => {
  const rendered = directive({ subagentModel: "a/b", orchestratorDepth: 3 }, 3, 3)
  assert.ok(rendered.startsWith("# Orchestrator Mode (level 3/3, enforced by @beremaran/pi-agent-tree)"))
  assert.ok(rendered.includes("— the FINAL orchestrator level."))
  assert.ok(rendered.includes("Your subagents (`explore`, `general`) have the hands-on tools"))
  assert.ok(rendered.includes("Keep subtasks SMALL."))
  assert.ok(rendered.includes("## Default delegation"))
})

test("instructions are appended only to level 1", () => {
  const opts = { subagentModel: "a/b", orchestratorDepth: 3, instructions: "EXTRA RULES" }
  assert.ok(directive(opts, 1, 3, "Manager-2").endsWith("EXTRA RULES"))
  assert.ok(!directive(opts, 2, 3, "Manager-3").includes("EXTRA RULES"))
  assert.ok(!directive(opts, 3, 3).includes("EXTRA RULES"))
})
