# Flyx Claude fixture

This repository is intentionally dependency-free and disposable. It gives the
Claude-only MVP a deterministic bug, test command, and interruptable process.

The initial `npm test` is intentionally red on the `maxRetries=0` boundary so
Claude has a deterministic edit-and-verify task. Run `pnpm --filter
@flyx/claude-fixtures reset` to restore that baseline. The workspace root test
command excludes this package because its red baseline is an acceptance
fixture, not a product unit-test failure.
