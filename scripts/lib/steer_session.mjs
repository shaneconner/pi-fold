// Shared shapes for the steer protocol: what the worker is allowed to hold, and how the
// supervisor and worker address each other.
//
// THE PLAN NEVER ENTERS THE NAMESPACE. Under v4 the run config named the plan, and five
// sealed runs walked that chain and read the key. Here the plan carries every obligation,
// every superseded value and every expected setting, so the supervisor holds it on the
// host and the worker is handed one steer at a time. What crosses is the text a person
// would have typed, and nothing else.
//
// THE SNAPSHOTS NEVER ENTER EITHER, and that is the sharper rule. A per-steer copy of the
// config is a complete answer sheet for the clobber: an agent that found
// snapshots/steer-062/driftwood.toml would restore twelve settings without recalling one.
// So the SUPERVISOR takes them, from the host side of the bind, at the moment the worker
// asks for the next steer. That moment is quiescent by construction: the model's turn has
// ended and the next has not begun, so there is no race to lose.

export const STEER_PROTOCOL = "steer/v1";

// Where the two halves meet, inside the run directory that is bound into the namespace.
// A request is the worker saying it is ready; a response is the supervisor releasing the
// next steer. The worker unlinks each response after reading it, so a run that is walked
// from inside holds at most the steer it is currently answering.
export const steerRequestPath = (runDir, ordinal) =>
  `${runDir}/ipc/steer-requests/${String(ordinal).padStart(3, "0")}.json`;
export const steerResponsePath = (runDir, ordinal) =>
  `${runDir}/ipc/steer-responses/${String(ordinal).padStart(3, "0")}.json`;
export const STEER_IPC_DIRECTORIES = Object.freeze([
  "ipc", "ipc/steer-requests", "ipc/steer-responses",
]);

// The only fields a released steer may carry. Built by whitelist, so a field added to the
// authored plan cannot reach the namespace by default: `obligations`, `authorNote`,
// `pristine` and `deflections` are all answer-bearing and all excluded by omission.
export const RELEASED_STEER_KEYS = Object.freeze(["ordinal", "id", "text", "final"]);

export function releasedSteer(steer, ordinal, total) {
  return {
    ordinal,
    id: steer.id,
    text: steer.text,
    final: ordinal === total,
  };
}

export function assertReleasedSteer(value) {
  const keys = Object.keys(value ?? {}).sort();
  const allowed = [...RELEASED_STEER_KEYS].sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    throw new Error(`Released steer carries unexpected fields: ${keys.join(",")}`);
  }
  if (typeof value.text !== "string" || value.text.trim().length === 0) {
    throw new Error("Released steer carries no text");
  }
  return value;
}

// The deflection the driver may send when the agent ends its turn on a question. It is a
// person shrugging, never an answer: a driver that could answer a question about a
// decision would be handing back the thing the run is measuring. Recorded by steer id so
// the grader can separate an honest ask from a silent miss.
export function deflectionFor(plan, ordinal) {
  const lines = plan.deflections ?? [];
  if (lines.length === 0) return null;
  return lines[ordinal % lines.length];
}

// A turn ends on a question when its last non-empty line does. Structural on purpose:
// the driver never interprets what was asked, and the same rule fires identically in
// both arms.
export function endsOnQuestion(text) {
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.at(-1).endsWith("?");
}

// The arms a steer campaign pairs. `pifold` runs the real extension; `native` runs stock
// Pi with its own compaction. The other two v4 arms have no meaning here: `unmanaged`
// existed to show the window wall, and `nativefence` existed to match a trigger the steer
// protocol does not set.
export const STEER_ARMS = Object.freeze(["pifold", "native"]);

export const STEER_RUN_CONFIG_KEYS = Object.freeze([
  "version", "runId", "runDir", "repoDir", "sessionDir", "arm", "planId", "planSha256",
  "steerCount", "model", "transport", "dependencyHashes", "sourceHashes", "watchdogMs",
  "createdWallMs", "checkoutSha256",
]);
// `deflections` rides in the config rather than in a released steer, so a released steer
// stays exactly the four whitelisted fields. They carry no answers: they are shrugs.
export const STEER_RUN_CONFIG_OPTIONAL_KEYS = Object.freeze([
  "providerInputBudget", "thresholds", "deflections", "readyOnly",
]);

// Validated by WHITELIST, both directions. A key the worker does not expect is refused
// rather than ignored, which is what keeps an answer-bearing field from riding in on a
// future edit to the supervisor.
export function validateSteerRunConfig(config) {
  const keys = Object.keys(config ?? {});
  for (const key of STEER_RUN_CONFIG_KEYS) {
    if (!keys.includes(key)) throw new Error(`Steer run config is missing ${key}`);
  }
  for (const key of keys) {
    if (!STEER_RUN_CONFIG_KEYS.includes(key) && !STEER_RUN_CONFIG_OPTIONAL_KEYS.includes(key)) {
      throw new Error(`Steer run config carries an unexpected key: ${key}`);
    }
  }
  if (!STEER_ARMS.includes(config.arm)) throw new Error(`Unknown steer arm ${config.arm}`);
  if (!Number.isSafeInteger(config.steerCount) || config.steerCount < 1) {
    throw new Error("Steer run config carries no steer count");
  }
  return config;
}
