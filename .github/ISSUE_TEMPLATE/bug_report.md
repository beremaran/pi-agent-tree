name: Bug report
description: Report a bug in pi-agent-tree
labels: ["bug"]
body:
  - type: markdown
    attributes:
      value: |
        Thanks for reporting! Please fill in as much as you can — a minimal
        reproduction makes a bug much faster to fix.
  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      description: What did you expect to happen, and what actually happened?
    validations:
      required: true
  - type: textarea
    id: reproduction
    attributes:
      label: Steps to reproduce
      description: The prompt you used, your config file, and any error/log output.
      placeholder: |
        1. Config: `{"subagentModel": "..."}`
        2. Prompt: "..."
        3. Observed: ...
  - type: input
    id: version
    attributes:
      label: Version
      description: Package version (`node -p 'require("@beremaran/pi-agent-tree/package.json").version'` or the git ref) and `pi --version`.
    validations:
      required: true
  - type: textarea
    id: environment
    attributes:
      label: Environment
      description: OS, node version, how the extension was installed (npm package, git, `-e`, `~/.pi/agent/extensions`).
