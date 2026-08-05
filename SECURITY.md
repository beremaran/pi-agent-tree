# Security Policy

## Supported versions

Only the latest published version of `@beremaran/pi-agent-tree` is supported
with security updates. Older releases are not patched; if you are on an
earlier release, upgrade to the latest version and confirm the issue is
resolved before reporting it.

## Reporting a vulnerability

Please report security vulnerabilities by emailing
[berke@beremaran.com](mailto:berke@beremaran.com) rather than opening a public
issue.

Include in your report:

- The package version (from `package.json`) and the pi version you are running
  (`pi --version`).
- A description of the vulnerability and, if possible, a minimal reproduction.
- Any impact assessment you can provide.

You can expect an acknowledgement within a few business days and a fix or
mitigation plan as soon as one can be produced. Please do not disclose the
issue publicly until it has been addressed.

## Known security considerations

This extension enforces behavior through configuration, so its security
surface is the configuration it runs with. Only use the extension with config
you control.

- **`instructions` is injected verbatim** into the orchestrator's system
  prompt. An untrusted configuration can inject prompt rules that the model
  may follow. Project-local config is only read for trusted projects.
- **The tool block is an explicit allow/deny list, not categorical.** A
  renamed or future mutating tool would not be auto-blocked.
- **Subagents keep their hands-on tools.** Delegation does not remove tools
  from subagents; the extension constrains the orchestrator, not the
  subagents. Set `restrictTask: true` to close the "delegate to an
  unrestricted agent" loophole.
- **`orchestratorModel` overrides the configured session model** (best effort).

## Dev-toolchain dependency note (`undici`)

`npm audit` reports advisories for `undici`, a **transitive dev-only
dependency** pinned to `8.5.0` by `@earendil-works/pi-coding-agent`'s shipped
`npm-shrinkwrap.json` (used only for typechecking; npm `overrides` cannot
reach shrinkwrapped pins). It is not shipped to consumers: pi installs the
extension from git and bundles the pi core packages itself, so end users
never install this copy of `undici`. The findings affect the repository's dev
toolchain only, and disappear when the pi core packages drop the affected pin.

The README's Security section describes these same considerations in prose.
