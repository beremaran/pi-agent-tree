/**
 * Smoke test: the extension module loads and exports a callable factory.
 *
 * pi loads extensions with jiti (Node). This runs the same import under
 * plain Node with type stripping and asserts the module surface an extension
 * needs: a default factory export and the named export.
 */

import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { spawnSync } = require("node:child_process")
const path = require("node:path")

const entry = path.resolve(import.meta.dirname, "..", "src", "index.ts")

const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    `
    const m = await import(${JSON.stringify(entry)})
    if (typeof m.default !== "function") {
      console.error("default export is not a function: " + typeof m.default)
      process.exit(1)
    }
    if (typeof m.OrchestratorExtension !== "function") {
      console.error("named OrchestratorExtension export is not a function")
      process.exit(1)
    }
    console.log("smoke ok: default + named exports are functions")
  `,
  ],
  { encoding: "utf8", stdio: "inherit" },
)

if (result.status !== 0) {
  console.error("smoke test failed")
  process.exit(result.status ?? 1)
}
