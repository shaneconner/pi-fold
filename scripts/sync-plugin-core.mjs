#!/usr/bin/env node

/* Each harness adapter must be self-contained after a package manager installs only
   its directory. These files are generated mirrors, never a second implementation.
   Add a target here rather than forking the core.

   Only the bounding primitives cross. Everything else in extensions/lib is bound to
   pi-fold's own state, snapshot and policy types, and a compaction engine that sees
   only the host's messages has no use for them. Gate 164 pins the mirror byte for
   byte, because a verbatim copy that is allowed to drift is worse than no copy. */

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "extensions", "lib");
const targets = [
  join(root, "dsh-fold", "src", "core"),
];
const files = ["brief-text.ts"];

for (const target of targets) {
  mkdirSync(target, { recursive: true });
  for (const file of files) copyFileSync(join(source, file), join(target, file));
  console.log(`Synced ${files.length} bounding primitive file(s) into ${target.slice(root.length + 1)}.`);
}
