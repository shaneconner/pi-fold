import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

export interface EvidenceRef {
  sessionId: string;
  entryId: string;
  role: string;
  sha256: string;
}

// Capture trust-boundary intrinsics before mutable prototypes can influence validation.
const ArrayConstructor = Array;
const arrayIsArray = Array.isArray;
const arrayPrototype = Array.prototype;
const defineProperty = Object.defineProperty;
const freeze = Object.freeze;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const isFrozen = Object.isFrozen;
const jsonStringify = JSON.stringify;
const number = Number;
const numberIsFinite = Number.isFinite;
const numberIsSafeInteger = Number.isSafeInteger;
const objectIs = Object.is;
const objectPrototype = Object.prototype;
const ownKeys = Reflect.ownKeys;
const regexpTest = RegExp.prototype.test;
const reflectApply = Reflect.apply;
const string = String;
const isProxy = utilTypes.isProxy;
const sha256Pattern = /^[a-f0-9]{64}$/;

function appendArrayValue(values: unknown[], value: unknown): void {
  defineProperty(values, string(values.length), {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function safeJson(value: unknown, ancestors: unknown[]): string | undefined {
  if (value === null) return "null";
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return jsonStringify(value);
  if (kind === "number") return numberIsFinite(value) ? jsonStringify(value) : "null";
  if (kind === "undefined" || kind === "function" || kind === "symbol") return undefined;
  if (kind === "bigint") throw new Error("Value is not JSON-serializable");
  if (!value || kind !== "object" || isProxy(value)) throw new Error("Value is not JSON-serializable");
  for (let index = 0; index < ancestors.length; index += 1) {
    if (ancestors[index] === value) throw new Error("Value contains a cycle");
  }
  const depth = ancestors.length;
  appendArrayValue(ancestors, value);
  try {
    if (arrayIsArray(value)) {
      if (getPrototypeOf(value) !== arrayPrototype) throw new Error("Value is not a plain JSON array");
      const lengthDescriptor = getOwnPropertyDescriptor(value, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor) ||
          !numberIsSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
        throw new Error("Value is not a dense JSON array");
      }
      const length = number(lengthDescriptor.value);
      let output = "[";
      for (let index = 0; index < length; index += 1) {
        if (index) output += ",";
        const descriptor = getOwnPropertyDescriptor(value, string(index));
        if (!descriptor) {
          output += "null";
          continue;
        }
        if (!("value" in descriptor) || !descriptor.enumerable) throw new Error("Value contains an array accessor");
        output += safeJson(descriptor.value, ancestors) ?? "null";
      }
      return `${output}]`;
    }
    if (!isPlainRecord(value)) throw new Error("Value is not a plain JSON object");
    const keys = ownKeys(value);
    let output = "{";
    let emitted = 0;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== "string") throw new Error("Value contains a symbol property");
      const descriptor = getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("Value contains an object accessor");
      if (!descriptor.enumerable) continue;
      const serialized = safeJson(descriptor.value, ancestors);
      if (serialized === undefined) continue;
      if (emitted) output += ",";
      output += `${jsonStringify(key)}:${serialized}`;
      emitted += 1;
    }
    return `${output}}`;
  } finally {
    defineProperty(ancestors, "length", { value: depth, writable: true });
  }
}

/** Preserve JSON property order without invoking getters, toJSON, coercion, iterators, or mutable prototypes. */
export function stableStringify(value: unknown): string {
  const serialized = safeJson(value, new ArrayConstructor<unknown>());
  if (typeof serialized !== "string") throw new Error("Value is not JSON-serializable");
  return serialized;
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Value(value: unknown): string {
  return sha256Text(stableStringify(value));
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || arrayIsArray(value) || isProxy(value)) return false;
  const prototype = getPrototypeOf(value);
  return prototype === objectPrototype || prototype === null;
}

export function ownDataProperty(value: unknown, key: PropertyKey): unknown {
  if (!isPlainRecord(value)) return undefined;
  const descriptor = getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** Copy a dense own-data array without invoking inherited accessors, iterators, or methods. */
export function denseOwnArrayValues(value: unknown): unknown[] | null {
  if (!arrayIsArray(value) || isProxy(value) || getPrototypeOf(value) !== arrayPrototype) return null;
  const lengthDescriptor = getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) ||
      !numberIsSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return null;
  const length = number(lengthDescriptor.value);
  const values = new ArrayConstructor<unknown>(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = getOwnPropertyDescriptor(value, string(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
    defineProperty(values, string(index), {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  const keys = ownKeys(value);
  let indexes = 0;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === "length") continue;
    if (key === "toJSON") {
      const descriptor = getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || descriptor.value !== undefined || descriptor.enumerable ||
          descriptor.configurable || descriptor.writable) return null;
      continue;
    }
    if (typeof key !== "string") return null;
    const numeric = number(key);
    if (!numberIsSafeInteger(numeric) || numeric < 0 || numeric >= length || string(numeric) !== key) return null;
    indexes += 1;
  }
  if (indexes !== length) return null;

  const copiedLength = getOwnPropertyDescriptor(values, "length");
  if (!copiedLength || !("value" in copiedLength) || copiedLength.value !== length) return null;
  for (let index = 0; index < length; index += 1) {
    const source = getOwnPropertyDescriptor(value, string(index));
    const copied = getOwnPropertyDescriptor(values, string(index));
    if (!source || !("value" in source) || !copied || !("value" in copied) ||
        !objectIs(copied.value, source.value) || !copied.enumerable || copied.configurable || copied.writable) return null;
  }
  freeze(values);
  if (!isFrozen(values)) throw new Error("Trusted dense array copy did not freeze");
  return values;
}

export function isObjectRef(value: unknown): value is EvidenceRef {
  if (!isPlainRecord(value)) return false;
  const keys = ownKeys(value);
  if (keys.length !== 4) return false;
  let mask = 0;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") return false;
    if (key === "sessionId") mask |= 1;
    else if (key === "entryId") mask |= 2;
    else if (key === "role") mask |= 4;
    else if (key === "sha256") mask |= 8;
    else return false;
    const descriptor = getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
  }
  if (mask !== 15) return false;
  const sessionId = ownDataProperty(value, "sessionId");
  const entryId = ownDataProperty(value, "entryId");
  const role = ownDataProperty(value, "role");
  const sha256 = ownDataProperty(value, "sha256");
  return typeof sessionId === "string" && sessionId.length > 0 &&
    typeof entryId === "string" && entryId.length > 0 &&
    typeof role === "string" && role.length > 0 &&
    typeof sha256 === "string" && reflectApply(regexpTest, sha256Pattern, [sha256]);
}

export function objectRefKey(ref: EvidenceRef): string {
  return stableStringify({ sessionId: ref.sessionId, entryId: ref.entryId, role: ref.role });
}

export function sameObjectIdentity(left: EvidenceRef, right: EvidenceRef): boolean {
  return objectRefKey(left) === objectRefKey(right);
}

export function evidenceValue(message: unknown): unknown {
  if (!isPlainRecord(message) || ownDataProperty(message, "role") !== "custom") return message;
  return {
    role: "custom",
    customType: ownDataProperty(message, "customType"),
    content: ownDataProperty(message, "content"),
    display: ownDataProperty(message, "display"),
    details: ownDataProperty(message, "details"),
  };
}

export function evidenceSha256(message: unknown): string {
  return sha256Value(evidenceValue(message));
}

export function evidenceRef(sessionId: string, entryId: string, message: unknown): EvidenceRef {
  if (!sessionId || !entryId || !isPlainRecord(message)) throw new Error("Pi evidence lacks a stable session, entry, or message");
  const role = ownDataProperty(message, "role");
  if (typeof role !== "string" || !role) throw new Error(`Pi entry ${entryId} has no role discriminator`);
  return { sessionId, entryId, role, sha256: evidenceSha256(message) };
}
