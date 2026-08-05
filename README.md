# pi-fold

pi-fold provides lossless, agent-governed context folding for Pi. It changes only the oldest eligible context while leaving the fresh window untouched.

It provides:

- Content-addressed, reversible folds over canonical session entries, with SHA-verified lossless expansion.
- An autonomous fold ladder with cadence brakes.
- A deterministic brief floor, with an optional injected summarizer.
- Advisory milestone guidance and a fence derived from the provider window.
- Fresh-tail protection with a small-window share cap.

## Status

This package is pre-release. Its API may move until 0.1.0. Licensed under [MIT](./LICENSE).

## Install

After the first release:

```sh
pi install npm:pi-fold
```

## Test

```sh
npm install
npm test
```

## Provenance

Built in production use; extracted from the Quorum project's Pi extension.
