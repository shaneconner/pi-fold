#!/usr/bin/env node
// Generates the driftwood checkout the steer protocol runs against. Deterministic: no
// clock, no Math.random, a seeded xorshift for every variation, so both arms and every
// rep get a byte-identical tree.
//
// The tree has to be big enough that reading it costs, and plausible enough that an agent
// working in it never wonders what it is for. A real log service does carry forty format
// parsers and thirty alert conditions, so the breadth here is the shape of the domain
// rather than padding.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const target = resolve(process.argv[2] ?? "lab/driftwood");
const fresh = !process.argv.includes("--keep");

let seed = 0x9e3779b9;
const next = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed;
};
const pick = (list) => list[next() % list.length];
const between = (low, high) => low + (next() % (high - low + 1));

const files = new Map();
const write = (path, body) => {
  if (files.has(path)) throw new Error(`duplicate generated file ${path}`);
  files.set(path, body.endsWith("\n") ? body : `${body}\n`);
};
const header = (module, line) => `// driftwood/${module}: ${line}\n`;

// ---------------------------------------------------------------- breadth helpers
// The estate is grown from a cross product rather than hand listed. A log service really
// does carry a hundred and fifty parsers and a hundred alert conditions, and typing them
// out one by one tells a reader nothing the components do not. Order stable and seedless,
// so the tree stays byte identical across arms and reps.
const cross = (left, right) => {
  const out = [];
  for (const a of left) for (const b of right) out.push(a + "_" + b);
  return out;
};
const grow = (base, extra, total) => {
  const seen = new Set(base);
  const out = [...base];
  for (const name of extra) {
    if (out.length >= total) break;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  if (out.length < total) {
    throw new Error(`only ${out.length} distinct names available, needed ${total}`);
  }
  return out;
};

// ---------------------------------------------------------------- manifest and config
write("package.json", `${JSON.stringify({
  name: "driftwood",
  version: "2.4.1",
  private: true,
  type: "module",
  scripts: {
    test: "node --test",
    check: "tsc --noEmit",
    start: "node src/index.ts",
  },
  // Empty on purpose and pinned by the deps-frozen obligation. driftwood runs on the
  // standard library; the toml reader below is ours because the config surface is four
  // shapes wide and a dependency for that was never worth it.
  dependencies: {},
  devDependencies: {
    typescript: "5.5.4",
    "@types/node": "22.5.0",
  },
}, null, 2)}\n`);

write("tsconfig.json", `${JSON.stringify({
  compilerOptions: {
    target: "es2023", module: "nodenext", moduleResolution: "nodenext",
    strict: true, noEmit: true, allowImportingTsExtensions: true,
  },
  include: ["src"],
}, null, 2)}\n`);

// The SHIPPED DEFAULTS. Every value the session decides differs from what is here, or the
// clobber would hand back the answer.
write("config/driftwood.toml", `# driftwood service configuration
# shipped defaults. site overrides live in config/driftwood.local.toml when present.

[api]
listen_port = 8080
max_page_size = 50
request_timeout_seconds = 15

[buffer]
flush_interval_seconds = 10
max_bytes = 4194304
spill_dir = "/var/lib/driftwood/spill"

[alert]
dedupe_window_seconds = 120
escalate_after_seconds = 300
mute_unknown_sources = false

[alert.dispatch]
timeout_seconds = 30
max_in_flight = 8

[retention]
days = 90
sweep_batch = 1000
sweep_interval_seconds = 3600

[ingest.http]
limiter = "none"
rate_limit_per_second = 0
max_body_bytes = 1048576

[ingest.syslog]
limiter = "none"
bind = "0.0.0.0:5514"

[store.index]
shards = 1
segment_bytes = 33554432

[pipeline]
stages = ["parse", "route"]

[log]
level = "warn"
format = "json"
`);

write("README.md", `# driftwood

Log ingestion and alerting. Lines arrive on a source, cross the pipeline, land in the
index, and anything matching a rule becomes an alert.

    src/ingest    sources and their listeners
    src/pipeline  the stage chain a line crosses
    src/alert     rule matching, dedupe, dispatch
    src/store     buffer, index, retention
    src/api       the query surface

Run the tests with \`npm test\`. Configuration is \`config/driftwood.toml\`; the block
comments in there are older than most of the code and some of the keys are no longer read.
`);

// ---------------------------------------------------------------- core
write("src/config.ts", `${header("config", "reads and validates driftwood.toml")}
import { readFileSync } from "node:fs";
import { readToml } from "./toml.ts";

export type Config = Record<string, unknown>;

let cached: Config | null = null;

export function loadConfig(path = "config/driftwood.toml"): Config {
  if (cached) return cached;
  cached = readToml(readFileSync(path, "utf8"));
  return cached;
}

export function resetConfig(): void {
  cached = null;
}

export function setting<T>(config: Config, path: string, fallback: T): T {
  let node: unknown = config;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null) return fallback;
    node = (node as Record<string, unknown>)[part];
  }
  return node === undefined ? fallback : (node as T);
}
`);

write("src/toml.ts", `${header("config", "the subset of toml the config surface uses")}
type Value = string | number | boolean | Array<string | number>;

const QUOTE = String.fromCharCode(34);

function scalar(raw: string): Value {
  const text = raw.trim();
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => scalar(part) as string | number);
  }
  if (text.startsWith(QUOTE) && text.endsWith(QUOTE)) return text.slice(1, -1);
  if (text === "true") return true;
  if (text === "false") return false;
  const numeric = Number(text);
  return Number.isNaN(numeric) ? text : numeric;
}

export function readToml(source: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let table = root;
  for (const rawLine of source.split(String.fromCharCode(10))) {
    const line = rawLine.replace(/\\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      table = root;
      for (const part of line.slice(1, -1).split(".")) {
        const existing = table[part];
        if (typeof existing === "object" && existing !== null) {
          table = existing as Record<string, unknown>;
        } else {
          const created: Record<string, unknown> = {};
          table[part] = created;
          table = created;
        }
      }
      continue;
    }
    const split = line.indexOf("=");
    if (split < 0) continue;
    table[line.slice(0, split).trim()] = scalar(line.slice(split + 1));
  }
  return root;
}
`);

write("src/pipeline/run.ts", `${header("pipeline", "drives a line through the stage chain")}
import { parseLine } from "./parse.ts";
import { normalize } from "./normalize.ts";
import { enrichHost } from "./enrich/host.ts";
import { enrichService } from "./enrich/service.ts";
import { route } from "./route.ts";
import type { Line } from "./line.ts";

// The order below IS the pipeline. There is no declaration of it anywhere else, which is
// why adding a stage means editing this function and hoping nobody was depending on the
// old order.
export function run(raw: string): Line | null {
  const parsed = parseLine(raw);
  if (!parsed) return null;
  const normalized = normalize(parsed);
  const withHost = enrichHost(normalized);
  const withService = enrichService(withHost);
  return route(withService);
}
`);

write("src/pipeline/line.ts", `${header("pipeline", "the record every stage passes along")}
export interface Line {
  raw: string;
  timestamp: number;
  message: string;
  fields: Record<string, string>;
  route: string | null;
}
`);

write("src/pipeline/parse.ts", `${header("pipeline", "picks a format parser and applies it")}
import { formats } from "../parse/registry.ts";
import type { Line } from "./line.ts";

export function parseLine(raw: string): Line | null {
  for (const format of formats) {
    const fields = format.match(raw);
    if (!fields) continue;
    return {
      raw,
      timestamp: Number(fields.ts ?? 0),
      message: fields.message ?? raw,
      fields,
      route: null,
    };
  }
  return null;
}
`);

write("src/pipeline/normalize.ts", `${header("pipeline", "lowercases keys and trims field values")}
import type { Line } from "./line.ts";

export function normalize(line: Line): Line {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(line.fields)) {
    fields[key.toLowerCase()] = String(value).trim();
  }
  return { ...line, fields };
}
`);

write("src/pipeline/route.ts", `${header("pipeline", "assigns a line to a routing key")}
import { conditions } from "../alert/registry.ts";
import type { Line } from "./line.ts";

// Matching and dispatch selection both live here, which makes either one hard to test on
// its own. Splitting them is on the list.
export function route(line: Line): Line {
  for (const condition of conditions) {
    if (!condition.test(line.fields)) continue;
    return { ...line, route: condition.name };
  }
  return { ...line, route: "unmatched" };
}
`);

write("src/store/buffer.ts", `${header("store", "batches lines before they reach the index")}
import { loadConfig, setting } from "../config.ts";
import type { Line } from "../pipeline/line.ts";

export class LineBuffer {
  private held: Line[] = [];
  private bytes = 0;
  private readonly flushIntervalSeconds: number;
  private readonly maxBytes: number;

  constructor(flushIntervalSeconds?: number, maxBytes?: number) {
    const config = loadConfig();
    this.flushIntervalSeconds = flushIntervalSeconds ??
      setting(config, "buffer.flush_interval_seconds", 10);
    this.maxBytes = maxBytes ?? setting(config, "buffer.max_bytes", 4194304);
  }

  add(line: Line): boolean {
    this.held.push(line);
    this.bytes += line.raw.length;
    return this.bytes >= this.maxBytes;
  }

  drain(): Line[] {
    const held = this.held;
    this.held = [];
    this.bytes = 0;
    return held;
  }

  get intervalSeconds(): number {
    return this.flushIntervalSeconds;
  }
}
`);

write("src/store/retention.ts", `${header("store", "expires and sweeps old segments")}
import { loadConfig, setting } from "../config.ts";

export interface Segment { id: string; ageDays: number }

export function expired(segments: Segment[], nowDays: number): Segment[] {
  const days = setting(loadConfig(), "retention.days", 90);
  return segments.filter((segment) => nowDays - segment.ageDays >= days);
}

// One statement for the whole expired set. This is what took the replica out in June.
export function sweep(segments: Segment[]): string[] {
  return segments.map((segment) => segment.id);
}
`);

write("src/alert/dedupe.ts", `${header("alert", "suppresses repeat alerts inside a window")}
import { loadConfig, setting } from "../config.ts";

export class Dedupe {
  private readonly seen = new Map<string, number>();
  private readonly windowSeconds: number;

  constructor(windowSeconds?: number) {
    this.windowSeconds = windowSeconds ??
      setting(loadConfig(), "alert.dedupe_window_seconds", 120);
  }

  admit(key: string, atSeconds: number): boolean {
    const last = this.seen.get(key);
    if (last !== undefined && atSeconds - last < this.windowSeconds) return false;
    this.seen.set(key, atSeconds);
    return true;
  }

  get window(): number {
    return this.windowSeconds;
  }
}
`);

write("src/alert/dispatch.ts", `${header("alert", "delivers an alert to its sink")}
import { loadConfig, setting } from "../config.ts";

export interface Sink { name: string; deliver(body: string): Promise<void> }

export async function dispatch(sink: Sink, body: string): Promise<boolean> {
  const timeout = setting(loadConfig(), "alert.dispatch.timeout_seconds", 30) * 1000;
  const guard = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(\`dispatch to \${sink.name} timed out\`)), timeout);
  });
  try {
    await Promise.race([sink.deliver(body), guard]);
    return true;
  } catch {
    return false;
  }
}
`);

write("src/alert/template.ts", `${header("alert", "renders an alert body from a rule and a line")}
import type { Line } from "../pipeline/line.ts";

export function render(rule: string, line: Line): string {
  return [
    \`rule=\${rule}\`,
    \`at=\${line.timestamp}\`,
    \`message=\${line.message}\`,
  ].join(" ");
}
`);

write("src/api/paging.ts", `${header("api", "clamps and applies page bounds")}
import { loadConfig, setting } from "../config.ts";

export function pageSize(requested: number): number {
  const max = setting(loadConfig(), "api.max_page_size", 50);
  if (!Number.isFinite(requested) || requested <= 0) return max;
  return Math.min(requested, max);
}
`);

write("src/api/search.ts", `${header("api", "the query surface over the index")}
import { shardFor } from "../store/shard.ts";
import { pageSize } from "./paging.ts";
import type { Line } from "../pipeline/line.ts";

export function search(lines: Line[], query: string, requested: number): Line[] {
  const size = pageSize(requested);
  const needle = query.toLowerCase();
  const matched: Line[] = [];
  // Every shard is walked in full on every query, which is where the p99 goes.
  for (const line of lines) {
    shardFor(line.raw);
    if (line.message.toLowerCase().includes(needle)) matched.push(line);
    if (matched.length >= size) break;
  }
  return matched;
}
`);

write("src/store/shard.ts", `${header("store", "maps a key onto an index shard")}
import { loadConfig, setting } from "../config.ts";

export function shardCount(): number {
  return setting(loadConfig(), "store.index.shards", 1);
}

export function shardFor(key: string): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % shardCount();
}
`);

write("src/ingest/listener.ts", `${header("ingest", "binds the http listener")}
import { loadConfig, setting } from "../config.ts";

export function listenPort(): number {
  return setting(loadConfig(), "api.listen_port", 8080);
}

export function describeBinding(): string {
  return \`driftwood listening on \${listenPort()}\`;
}
`);

write("src/ingest/limiter.ts", `${header("ingest", "the rate limiters a source may use")}
export interface Limiter { allow(nowMs: number): boolean }

export function noopLimiter(): Limiter {
  return { allow: () => true };
}
`);

write("src/index.ts", `${header("driftwood", "process entry point")}
import { loadConfig } from "./config.ts";
import { describeBinding } from "./ingest/listener.ts";

export function boot(): string {
  loadConfig();
  return describeBinding();
}
`);

// ---------------------------------------------------------------- breadth
const FORMATS = grow([
  "nginx_combined", "nginx_error", "apache_common", "apache_combined", "syslog_3164",
  "syslog_5424", "json_lines", "logfmt", "cef", "gelf", "haproxy", "postgres_csv",
  "mysql_slow", "redis", "kafka_broker", "envoy_access", "traefik", "caddy", "k8s_cri",
  "docker_json", "systemd_journal", "windows_event", "cloudtrail", "vpc_flow", "alb",
  "cloudfront", "fastly", "varnish", "squid", "bind_query", "dhcpd", "sshd", "sudo",
  "audit", "iptables", "pfsense", "suricata", "zeek_conn", "osquery", "falco",
], cross(
  ["cisco", "fortinet", "paloalto", "juniper", "arista", "f5", "netscaler", "sonicwall",
    "checkpoint", "sophos", "watchguard", "barracuda", "meraki", "ubiquiti", "mikrotik"],
  ["access", "error", "audit", "traffic", "threat", "session", "system", "vpn"]), 150);
for (const format of FORMATS) {
  const label = format.replace(/_/g, " ");
  const extra = ["status", "bytes", "latency_ms", "user", "path", "method", "referrer", "agent"];
  const fields = ["ts", "host", "message", ...extra.slice(0, between(2, 5))];
  const sampleLines = Array.from({ length: between(3, 6) }, (_, index) =>
    "  " + JSON.stringify((1700000000 + between(0, 86400)) + " host-" + between(1, 40) +
      " " + label + " sample " + index) + ",").join("\n");
  const origin = pick(["the edge fleet", "the platform cluster", "the legacy estate",
    "customer collectors", "the security tap"]);
  const quirk = pick(["trailing request id", "quoted user agent", "optional trace header",
    "millisecond timestamp"]);
  const quirkNote = pick(["appears only on newer senders", "is absent behind the old proxy",
    "may be empty"]);
  const body = [
    header("parse", label + " line format"),
    "// " + label + " lines arrive from " + origin + ". The shape has been stable since " +
      between(2018, 2024) + ",",
    "// with the exception of the " + quirk + " field, which " + quirkNote + ".",
    "",
    "const HEAD = /^(?<ts>\\S+)\\s+(?<host>\\S+)\\s+(?<message>.*)$/;",
    "const TAIL = /\\s+(?<trailer>[a-f0-9]{8,32})\\s*$/;",
    "",
    'export const name = "' + format + '";',
    "export const fields = " + JSON.stringify(fields) + ";",
    "export const minimumLength = " + between(8, 24) + ";",
    "",
    "export const samples: string[] = [",
    sampleLines,
    "];",
    "",
    "function trailer(raw: string): string | null {",
    "  const found = TAIL.exec(raw);",
    "  return found?.groups?.trailer ?? null;",
    "}",
    "",
    "export function match(raw: string): Record<string, string> | null {",
    "  if (raw.length < minimumLength) return null;",
    "  const found = HEAD.exec(raw);",
    "  if (!found?.groups) return null;",
    "  const parsed: Record<string, string> = { ...found.groups, format: name };",
    "  const id = trailer(raw);",
    "  if (id) parsed.request_id = id;",
    "  for (const field of fields) {",
    '    if (parsed[field] === undefined) parsed[field] = "";',
    "  }",
    "  return parsed;",
    "}",
    "",
    "export function describe(): string {",
    "  return name + ' (' + fields.length + ' fields, min ' + minimumLength + ' bytes)';",
    "}",
  ].join("\n");
  write("src/parse/formats/" + format + ".ts", body);
}
write("src/parse/registry.ts", `${header("parse", "every known line format, tried in order")}
${FORMATS.map((format) => `import * as ${format} from "./formats/${format}.ts";`).join("\n")}

export interface Format { name: string; fields: string[]; match(raw: string): Record<string, string> | null }

export const formats: Format[] = [
${FORMATS.map((format) => `  ${format},`).join("\n")}
];
`);

const CONDITIONS = grow([
  "status_5xx", "status_4xx_burst", "latency_p99", "oom_killed", "disk_full",
  "cert_expiring", "auth_failure_burst", "replica_lag", "queue_depth", "deploy_rollback",
  "connection_refused", "dns_failure", "tls_handshake", "rate_limited", "panic",
  "segfault", "restart_loop", "node_not_ready", "pvc_pending", "throttled",
  "checksum_mismatch", "clock_skew", "quota_exceeded", "readonly_filesystem",
  "backup_missed", "index_corrupt", "leader_election", "split_brain", "slow_query",
  "unhandled_rejection",
], cross(
  ["ingest", "parse", "store", "alert", "api", "pipeline", "index", "compactor", "router", "cache"],
  ["latency", "errors", "backlog", "timeout", "stall", "drift", "leak", "churn", "starvation", "saturation"]), 110);
for (const condition of CONDITIONS) {
  const label = condition.replace(/_/g, " ");
  const field = pick(["status", "latency_ms", "level", "kind", "component"]);
  const threshold = between(2, 500);
  const when = pick(["on any host", "on more than one host in a minute", "twice in a row",
    "outside a deploy window"]);
  const owner = pick(["platform", "storage", "networking", "security"]);
  const history = pick(["noisy before the router change", "quiet outside incidents",
    "the first thing to fire in a regional event", "prone to firing on restarts"]);
  const body = [
    header("alert", label + " condition"),
    "// Fires when " + label + " is seen " + when + ". Owned by " + owner + ".",
    "// Historically " + history + ".",
    "",
    'export const name = "' + condition + '";',
    'export const severity = "' + pick(["page", "ticket", "notice"]) + '";',
    "export const threshold = " + threshold + ";",
    'export const owner = "' + owner + '";',
    "",
    'const NEEDLE = "' + condition.split("_")[0] + '";',
    "",
    "export function test(fields: Record<string, string>): boolean {",
    '  const value = fields["' + field + '"];',
    "  if (value === undefined || value.length === 0) return false;",
    "  if (!value.includes(NEEDLE)) return false;",
    '  const numeric = Number(fields.latency_ms ?? "0");',
    "  return Number.isNaN(numeric) ? true : numeric >= 0;",
    "}",
    "",
    "export function explain(fields: Record<string, string>): string {",
    '  return name + ": " + (fields["' + field + '"] ?? "no ' + field + '") + " (threshold " + threshold + ")";',
    "}",
    "",
    "export function runbook(): string {",
    '  return "https://runbooks.internal/driftwood/" + name;',
    "}",
  ].join("\n");
  write("src/alert/conditions/" + condition + ".ts", body);
}
write("src/alert/registry.ts", `${header("alert", "every alert condition, tried in order")}
${CONDITIONS.map((condition) => `import * as ${condition} from "./conditions/${condition}.ts";`).join("\n")}

export interface Condition { name: string; severity: string; test(fields: Record<string, string>): boolean }

export const conditions: Condition[] = [
${CONDITIONS.map((condition) => `  ${condition},`).join("\n")}
];
`);

const ENRICHERS = grow([
  "host", "service", "environment", "region", "cluster", "namespace", "pod", "container",
  "team_owner", "runbook", "severity_hint", "customer", "tenant", "release", "commit_sha",
  "instance_type", "az", "provider", "cost_centre", "sla_tier", "deploy_id", "canary",
  "shard_hint", "trace_id", "span_id",
], cross(
  ["upstream", "downstream", "origin", "peer", "edge", "core", "billing", "support"],
  ["team", "tier", "zone", "group", "label", "code", "owner", "contact", "channel", "budget"]), 90);
for (const enricher of ENRICHERS) {
  const camel = enricher.replace(/(^|_)(\w)/g, (_, __, letter) => letter.toUpperCase());
  const source = pick(["the CMDB export", "the service catalogue", "the kubernetes API cache",
    "the billing dimension table", "a static map maintained by the owning team"]);
  const staleness = pick(["refreshed hourly", "refreshed on deploy", "reloaded on SIGHUP",
    "loaded once at boot and never again, which has bitten us"]);
  const rows = Array.from({ length: between(6, 14) }, (_, index) =>
    '  "' + enricher + "-" + index + '": "' + enricher + "-value-" + between(10, 99) + '",').join("\n");
  const body = [
    header("pipeline", "attaches " + enricher.replace(/_/g, " ") + " to a line"),
    "// Backed by " + source + ", " + staleness + ".",
    "// A miss leaves the line untouched rather than stamping an unknown, because an",
    "// unknown value routes and a missing one does not.",
    "",
    'import type { Line } from "../line.ts";',
    "",
    "const TABLE: Record<string, string> = {",
    rows,
    "};",
    "",
    "export const key = " + JSON.stringify(enricher) + ";",
    "export const size = Object.keys(TABLE).length;",
    "",
    "export function lookup(value: string | undefined): string | null {",
    "  if (value === undefined) return null;",
    "  return TABLE[value] ?? null;",
    "}",
    "",
    "export function enrich" + camel + "(line: Line): Line {",
    '  const found = lookup(line.fields[key] ?? key + "-0");',
    "  if (!found) return line;",
    "  return { ...line, fields: { ...line.fields, [key]: found } };",
    "}",
    "",
    "export function coverage(lines: Line[]): number {",
    "  if (lines.length === 0) return 0;",
    "  const hit = lines.filter((line) => lookup(line.fields[key]) !== null).length;",
    "  return hit / lines.length;",
    "}",
  ].join("\n");
  write("src/pipeline/enrich/" + enricher + ".ts", body);
}

const CODECS = grow([
  "varint", "zigzag", "delta", "rle", "dictionary", "bitpack", "frame", "checksum",
  "segment_header", "footer", "posting_list", "term_dict", "bloom", "skiplist",
  "timestamp_column", "string_column", "numeric_column", "tombstone", "manifest", "wal",
], cross(
  ["block", "page", "chunk", "stripe", "column", "row", "index", "meta"],
  ["v1", "v2", "header", "trailer", "packer", "reader", "writer", "column"]), 75);
for (const codec of CODECS) {
  const label = codec.replace(/_/g, " ");
  const note = pick(["Written once per segment and never rewritten.",
    "Read on every query, so the decode path is the hot one.",
    "Only the writer touches this; the reader goes through the manifest.",
    "Shared with the compactor, which is why the format is versioned."]);
  const body = [
    header("store", label + " encoding"),
    "// " + note,
    "// Version " + between(1, 4) + " of the on-disk shape. Older segments are read through",
    "// the compatibility branch below and rewritten on the next compaction.",
    "",
    'export const name = "' + codec + '";',
    "export const version = " + between(1, 4) + ";",
    "export const headerBytes = " + between(4, 32) + ";",
    "",
    "export function encode(values: number[]): number[] {",
    "  const out: number[] = [];",
    "  for (let index = 0; index < values.length; index += 1) {",
    "    out.push((values[index] ^ index) >>> 0);",
    "  }",
    "  return out;",
    "}",
    "",
    "export function decode(values: number[]): number[] {",
    "  const out: number[] = [];",
    "  for (let index = 0; index < values.length; index += 1) {",
    "    out.push((values[index] ^ index) >>> 0);",
    "  }",
    "  return out;",
    "}",
    "",
    "export function sizeOf(values: number[]): number {",
    "  return headerBytes + values.length * 4;",
    "}",
    "",
    "export function roundTrips(values: number[]): boolean {",
    "  const back = decode(encode(values));",
    "  return back.every((value, index) => value === values[index]);",
    "}",
  ].join("\n");
  write("src/store/codecs/" + codec + ".ts", body);
}

const SOURCES = grow(["http", "syslog", "file", "stdin", "kafka", "kinesis", "s3", "gcs", "journald", "windows", "otlp", "fluent"], cross(
  ["azure", "gcp", "aws", "onprem", "edge", "lab"],
  ["blob", "queue", "stream", "agent", "relay", "tap", "proxy"]), 45);
for (const source of SOURCES) {
  const transport = pick(["a long lived socket", "a polled cursor", "a pull loop with a lease",
    "an inbound push with an ack"]);
  const body = [
    header("ingest", source + " source"),
    "// Delivery is " + transport + ". Back pressure is handled by refusing the read rather",
    "// than by buffering, because a source that buffers hides the pressure from the rest",
    "// of the system and then hands it over all at once.",
    "",
    'import { noopLimiter } from "../limiter.ts";',
    'import type { Limiter } from "../limiter.ts";',
    "",
    'export const name = "' + source + '";',
    "export const framed = " + pick(["true", "false"]) + ";",
    "export const maxChunkBytes = " + (1024 * between(16, 512)) + ";",
    "",
    "export function limiterFor(): Limiter {",
    "  return noopLimiter();",
    "}",
    "",
    "export function decode(chunk: string): string[] {",
    "  if (chunk.length > maxChunkBytes) {",
    '    throw new Error("' + source + ' chunk too large: " + chunk.length + " bytes");',
    "  }",
    "  return chunk",
    "    .split(String.fromCharCode(10))",
    "    .map((line) => line.trimEnd())",
    "    .filter((line) => line.length > 0);",
    "}",
    "",
    "export function healthy(lastSeenSeconds: number, nowSeconds: number): boolean {",
    "  return nowSeconds - lastSeenSeconds < " + between(30, 300) + ";",
    "}",
  ].join("\n");
  write("src/ingest/sources/" + source + ".ts", body);
}

const ROUTES = grow([
  "search", "tail", "alerts", "rules", "sources", "health", "metrics", "segments",
  "fields", "formats", "shards", "retention", "config", "version", "ping",
], cross(
  ["index", "segment", "shard", "field", "format", "source", "alert", "rule", "tenant", "user"],
  ["stats", "list", "detail", "history", "summary"]), 55);
for (const route of ROUTES) {
  const params = ["q", "from", "to", "limit", "cursor", "shard", "format"].slice(0, between(2, 5));
  const body = [
    header("api", "GET /" + route),
    "// " + pick(["Read only.", "Read only, cached at the edge for a minute.",
      "Read only; the dashboard calls this on every panel refresh.",
      "Read only, and the slowest thing we serve."]),
    "",
    'export const path = "/' + route + '";',
    'export const method = "GET";',
    "export const params = " + JSON.stringify(params) + ";",
    "",
    "export function validate(query: Record<string, string>): string | null {",
    "  for (const key of Object.keys(query)) {",
    "    if (!params.includes(key)) return 'unknown parameter ' + key + ' on ' + path;",
    "  }",
    "  return null;",
    "}",
    "",
    "export function handle(query: Record<string, string>): { status: number; body: unknown } {",
    "  const problem = validate(query);",
    "  if (problem) return { status: 400, body: { error: problem } };",
    "  return { status: 200, body: { route: path, query, params } };",
    "}",
  ].join("\n");
  write("src/api/routes/" + route + ".ts", body);
}

// ---------------------------------------------------------------- tests
// The legacy directory the session is migrating off. It has to exist and pass, or the
// "don't add to tests/" convention is an instruction about nothing.
write("tests/pipeline.test.ts", `import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/pipeline/run.ts";

test("a well formed line crosses the pipeline", () => {
  const line = run("1699999999 web-01 GET /health 200");
  assert.ok(line);
  assert.equal(typeof line.route, "string");
});

test("an empty line does not", () => {
  assert.equal(run(""), null);
});
`);

write("tests/parse.test.ts", `import { test } from "node:test";
import assert from "node:assert/strict";
import { formats } from "../src/parse/registry.ts";

test("every format declares a name and fields", () => {
  for (const format of formats) {
    assert.equal(typeof format.name, "string");
    assert.ok(Array.isArray(format.fields));
  }
});

test("the registry is not empty", () => {
  assert.ok(formats.length > 20);
});
`);

write("tests/alert.test.ts", `import { test } from "node:test";
import assert from "node:assert/strict";
import { Dedupe } from "../src/alert/dedupe.ts";
import { conditions } from "../src/alert/registry.ts";

test("dedupe suppresses inside the window", () => {
  const dedupe = new Dedupe(60);
  assert.equal(dedupe.admit("k", 0), true);
  assert.equal(dedupe.admit("k", 30), false);
  assert.equal(dedupe.admit("k", 61), true);
});

test("every condition declares a severity", () => {
  for (const condition of conditions) assert.equal(typeof condition.severity, "string");
});
`);

write("tests/store.test.ts", `import { test } from "node:test";
import assert from "node:assert/strict";
import { expired } from "../src/store/retention.ts";
import { shardFor } from "../src/store/shard.ts";

test("expired picks segments past the retention edge", () => {
  const segments = [{ id: "a", ageDays: 0 }, { id: "b", ageDays: 200 }];
  const found = expired(segments, 200);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, "a");
});

test("shardFor stays inside the shard count", () => {
  for (const key of ["a", "b", "c"]) assert.ok(shardFor(key) >= 0);
});
`);

write("tests/api.test.ts", `import { test } from "node:test";
import assert from "node:assert/strict";
import { pageSize } from "../src/api/paging.ts";

test("page size clamps rather than rejects", () => {
  assert.ok(pageSize(1_000_000) <= 1_000_000);
  assert.ok(pageSize(-1) > 0);
});
`);

// Per item coverage, generated alongside the estate it covers. This lands in the LEGACY
// directory on purpose: the repo demonstrates the pattern the session is migrating away
// from, so an agent that lost the convention steer cannot recover it by imitating the
// tree. It has to remember.
const suite = (file, list, dir, label, body) => {
  write("tests/" + file + ".test.ts", [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    ...list.map((name) => "import * as " + name + ' from "../src/' + dir + "/" + name + '.ts";'),
    "",
    "const all: Record<string, any> = {",
    ...list.map((name) => "  " + name + ","),
    "};",
    "",
    "for (const [key, unit] of Object.entries(all)) {",
    '  test(key + " ' + label + '", () => {',
    ...body.map((line) => "    " + line),
    "  });",
    "}",
  ].join("\n"));
};

suite("formats", FORMATS, "parse/formats", "parses its own sample lines", [
  "assert.ok(unit.fields.length >= 3);",
  "for (const sample of unit.samples) {",
  "  const parsed = unit.match(sample);",
  '  assert.ok(parsed, unit.name + " failed to parse its own sample");',
  "  assert.equal(parsed.format, unit.name);",
  "}",
]);

suite("conditions", CONDITIONS, "alert/conditions", "declares a usable threshold", [
  "assert.ok(Number.isInteger(unit.threshold));",
  "assert.ok(unit.threshold > 0);",
  'assert.equal(typeof unit.owner, "string");',
  "assert.equal(unit.test({}), false);",
  'assert.ok(unit.runbook().startsWith("https://"));',
]);

suite("codecs", CODECS, "store/codecs", "round trips what it encodes", [
  "const values = [1, 2, 3, 5, 8, 13, 21];",
  'assert.equal(typeof unit.name, "string");',
  "assert.ok(unit.roundTrips(values));",
  "assert.ok(unit.sizeOf(values) > values.length);",
]);

suite("sources", SOURCES, "ingest/sources", "decodes a framed chunk", [
  'const lines = unit.decode("one" + String.fromCharCode(10) + "two");',
  'assert.deepEqual(lines, ["one", "two"]);',
  "assert.ok(unit.maxChunkBytes > 0);",
  "assert.equal(unit.healthy(0, 100000), false);",
]);

suite("routes", ROUTES, "api/routes", "refuses an unknown parameter", [
  'assert.equal(unit.method, "GET");',
  'const bad = unit.handle({ nonsense: "1" });',
  "assert.equal(bad.status, 400);",
  "const good = unit.handle({});",
  "assert.equal(good.status, 200);",
]);

suite("enrich", ENRICHERS, "pipeline/enrich", "leaves an unknown value untouched", [
  "assert.equal(unit.lookup(undefined), null);",
  'assert.equal(unit.lookup("nothing-matches-this"), null);',
  "assert.ok(unit.size > 0);",
  "assert.equal(unit.coverage([]), 0);",
]);

// ---------------------------------------------------------------- emit
if (fresh) rmSync(target, { recursive: true, force: true });
for (const [path, body] of [...files].sort(([left], [right]) => left < right ? -1 : 1)) {
  const full = join(target, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}
process.stdout.write(`${JSON.stringify({
  target,
  files: files.size,
  bytes: [...files.values()].reduce((total, body) => total + Buffer.byteLength(body), 0),
}, null, 2)}\n`);
