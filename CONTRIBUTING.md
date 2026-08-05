# Contributing

Thanks for contributing to @beremaran/pi-agent-tree!

## Getting started

1. Fork the repository and clone your fork.
2. `npm install`
3. `npm run check`

The extension has no build step — pi loads extensions with jiti directly from
the raw TypeScript source.

## Manual testing

Create a config file (e.g. a trusted project's `.pi/pi-agent-tree.json`, or
`~/.pi/agent/pi-agent-tree.json`) with a real `subagentModel`, then run pi from
the project root:

```bash
pi -a -e ./src/index.ts
```

Ask something that requires a tool, e.g.:

> Create a file named test.txt containing "hello".

Expected behavior:

1. The orchestrator does **not** edit the file itself (hands-on tools are
   removed from its toolset and blocked).
2. It delegates the work to a subagent via the `task` tool.
3. The subagent runs with the model configured in `subagentModel` (check the
   delegation's usage line in the TUI).

Verify the startup log line is present:

```
Orchestrator "Manager" enabled; subagents -> <subagentModel>
```

## Writing tests

- Tests live in `test/*.test.ts`, run via `npm test`
  (`node --experimental-strip-types --test "test/*.test.ts"`; use
  `npm run test:coverage` for coverage).
- Keep assertions **behavior-based, not positional** — tests call the exported
  pure functions (`normalizeOptions`, `orchestratorDirective`,
  `planDelegation`, `levelContextFromEnv`, ...); they never depend on log
  ordering or extension internals.
- The rendered directive is asserted byte-for-byte in `test/directive.test.ts`.
  If you change the directive prompt in `src/directive.ts`, update the copy in
  `README.md` to match — the rendered block in the README is kept in sync.
- Add a test for any behavior you change, and run `npm run check`
  (typecheck + lint + tests + smoke) before pushing; CI enforces it.

## Pull requests

- Keep changes minimal and scoped.
- Run `npm run check` before pushing; CI enforces it.
- If you change observable behavior, update `CHANGELOG.md` under
  `## [Unreleased]` and the README where relevant.
- Use [Conventional Commits](https://www.conventionalcommits.org/) style
  (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, …); releases use
  `chore: release vX.Y.Z` (see [RELEASING.md](RELEASING.md)).
- Update `package.json` `version` only when asked to prepare a release.

## Releases

Releases are tag-triggered from CI — see [RELEASING.md](RELEASING.md) for the
full flow (bump version, add a CHANGELOG entry, tag `vX.Y.Z`, push the tag).
