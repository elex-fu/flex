# Flyx Claude fixture

This repository is intentionally dependency-free and disposable. It gives the
Claude-only MVP a deterministic bug, test command, and interruptable process.

The initial `npm test` is intentionally red on the `maxRetries=0` boundary so
Claude has a deterministic edit-and-verify task. Run `pnpm --filter
@flyx/claude-fixtures reset` to restore that baseline. The workspace root test
command excludes this package because its red baseline is an acceptance
fixture, not a product unit-test failure.

The source files are tracked in the Flyx repository. A clean checkout does not
include nested Git metadata. `pnpm fixture:prepare` creates a standalone Git
root here if one is missing, preserving an existing repository and its edits.
`pnpm fixture:prepare /new/path` instead creates a separate copy and refuses
to overwrite an existing destination. `pnpm test:fixtures` verifies the one
expected boundary failure; it fails if the fixture is repaired or fails in a
different way. `pnpm test:product` excludes these intentionally failing tests.
