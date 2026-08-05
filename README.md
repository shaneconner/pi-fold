# pi-fold

pi-fold provides lossless, agent-governed context folding for Pi. It changes only the oldest eligible context while leaving the fresh window untouched.

## Status

This package is pre-release. Its API may move until 0.1.0. Licensed under [MIT](./LICENSE).

## Install

After the first 0.1.0 release:

```sh
pi install npm:pi-fold
```

## How it works

pi-fold maps canonical session entries into a fold lattice. A fold replaces an eligible stale span with a short placeholder while retaining ordered references to the exact source entries. Expansion checks the stored SHA-256 identities before restoring that source.

An autonomous ladder first folds completed read-only tool batches, then refolds or consolidates existing folds, and finally folds structurally closed chapters. Cadence and fresh-tail rules prevent repeated or premature folding. Chapter briefs are deterministic unless a configured summarizer returns a valid attributed result; summarizer failure falls back to the deterministic brief. Advisory milestones describe eligible actions as measured context pressure rises, and the provider-window fence blocks an unsafe request if no lossless fold can make room.

## Configuration

The package entry calls `registerPiFold(pi)` with the defaults below. Hosts that call the named `registerPiFold` export directly may pass an options object. Replacement lists and sets replace the defaults; they are not additive.

| Option | Default | Effect |
| --- | --- | --- |
| `toolName` | `"active_context"` | Name of the registered context tool. |
| `entryTypePrefix` | `"pi-fold-active-context"` | Prefix for durable state, fold-record, measurement, and advisory entry types. Changing it starts a separate state namespace. |
| `commandPrefix` | `""` | Prefix for `/context` and `/fold-context`; trailing hyphens are removed. |
| `summarizeContextSpan` | `undefined` | Optional async brief generator. Results must include a useful bounded brief, provider/model/effort attribution, and `toolCalls: 0`; failure uses the deterministic brief. |
| `setProjectionProvider` | `undefined` | Optional host callback that receives the projection-candidate provider. Normal Pi context events do not require it. |
| `toolActions` | all six actions | Replacement allowlist drawn from `status`, `fold`, `expand`, `refold`, `protect`, and `unprotect`. |
| `blockingTools` | `["Agent"]` | Replacement list of tool names that trigger one opportunistic stale-tool fold before the call. Use `[]` to disable it. |
| `readOnlyTools` | built-in `ReadonlySet` | Replacement set of tool names whose completed batches may fold automatically. Pass a `ReadonlySet<string>`. |
| `isMcpTool` | `() => false` | Synchronous predicate enabling evidence ingestion for oversized structured MCP results. |

## Development

```sh
npm ci
npm run lint
npm test
```
