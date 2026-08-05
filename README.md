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

By default, evidence ingestion writes read-only artifact files under the session directory's `pi-fold-evidence/`, sets them to mode `0444`, and enforces a 512 MB session cap. These immutable files provide exact-recovery anchors for oversized tool results. Set `evidenceIngestion: false` to disable the hook and all evidence writes.

## Configuration

The package entry calls `registerPiFold(pi)` with the defaults below. Hosts that call the named `registerPiFold` export directly may pass an options object. Replacement lists and sets replace the defaults; they are not additive.

| Option | Default | Effect |
| --- | --- | --- |
| `toolName` | `"active_context"` | Name of the registered context tool. |
| `toolLabel` | `"Active Context"` | Human-facing label for the registered context tool. |
| `brandNoun` | `"active-context"` | Short noun used in fold placeholders, advisory headings, fence text, and native-compaction notices. |
| `entryTypePrefix` | `"pi-fold-active-context"` | Prefix for durable state, fold-record, status, and advisory identifiers. Its namespace also derives measurement/compaction entry types, status source metadata, MCP evidence ownership, the evidence directory, and the unparseable MCP-server fallback. Changing it starts a separate state namespace. |
| `commandPrefix` | `""` | Prefix for `/context` and `/fold-context`; trailing hyphens are removed. |
| `commandNames` | `undefined` | Optional full-name overrides for the effective defaults `{ status: "context", fold: "fold-context" }`. Both names must be distinct kebab-case strings; supplied values take precedence over `commandPrefix`. |
| `summarizeContextSpan` | `undefined` | Optional async brief generator. Results must include a useful bounded brief, provider/model/effort attribution, and `toolCalls: 0`; failure uses the deterministic brief. |
| `setProjectionProvider` | `undefined` | Optional host callback that receives the projection-candidate provider. Normal Pi context events do not require it. |
| `toolActions` | all six actions | Replacement allowlist drawn from `status`, `fold`, `expand`, `refold`, `protect`, and `unprotect`. |
| `blockingTools` | `["Agent"]` | Replacement list of tool names that trigger one opportunistic stale-tool fold before the call. Use `[]` to disable it. |
| `readOnlyTools` | `new Set(["read", "grep", "find", "ls"])` | Replacement set of tool names whose completed batches may fold automatically. Defaults to Pi's built-in read-only tools. Pass a `ReadonlySet<string>`. |
| `isMcpTool` | `() => false` | Synchronous predicate enabling evidence ingestion for oversized structured MCP results. Names shaped as `mcp__<server>__<tool>` project the actual server; other names use the neutral namespace derived from `entryTypePrefix`. |
| `evidenceIngestion` | `true` | Set to `false` to register no evidence-ingestion hook and write no evidence artifacts. |

## Development

```sh
npm ci
npm run lint
npm test
```
