import { basename, posix } from "node:path";
import { pathToFileURL } from "node:url";

// Native restore argv, not `agent.start` args. Verified against Herdr
// b1ff4582e968/src/agent_resume.rs. See README for the surrounding launch contract.
const resumeForms = [
  ["claude", "herdr:claude", "claude", "--resume"],
  ["codex", "herdr:codex", "codex", "resume"],
  ["copilot", "herdr:copilot", "copilot", "--resume="],
  ["devin", "herdr:devin", "devin", "--resume"],
  ["droid", "herdr:droid", "droid", "--resume"],
  ["kimi", "herdr:kimi", "kimi", "--session"],
  ["mastracode", "herdr:mastracode", "mastracode", "--thread"],
  ["pi", "herdr:pi", "pi", "--session"],
  ["omp", "herdr:omp", "omp", "--resume="],
  ["hermes", "herdr:hermes", "hermes", "--resume"],
  ["opencode", "herdr:opencode", "opencode", "--session"],
  ["qodercli", "herdr:qodercli", "qodercli", "--resume"],
  ["qwen", "herdr:qwen", "qwen", "--resume"],
  ["kilo", "herdr:kilo", "kilo", "--session"],
  ["cursor", "herdr:cursor", "cursor-agent", "--resume"],
  ["agy", "herdr:antigravity_cli", "agy", "--conversation"],
  ["grok", "herdr:grok", "grok", "--resume"],
] as const;

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("expected non-empty text");
  // Refuse terminal control/bidi sequences instead of printing misleading commands.
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) throw new Error("unsafe control character in text");
  return value;
}

function optionalText(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : text(value);
}

export type Session = { source: string; agent: string; kind: "id" | "path"; value: string };
export type Pane = {
  id: string;
  cwd: string;
  agent: string | undefined;
  session: Session | undefined;
};

export function parsePane(value: unknown): Pane {
  const pane = record(value);
  let session: Session | undefined;
  if (pane.agent_session !== undefined && pane.agent_session !== null) {
    const ref = record(pane.agent_session);
    if (ref.kind !== "id" && ref.kind !== "path") throw new Error("unknown session reference kind");
    const sessionValue = text(ref.value);
    if (Buffer.byteLength(sessionValue) > (ref.kind === "path" ? 4096 : 512)) {
      throw new Error("session reference too long");
    }
    if (ref.kind === "path" && !posix.isAbsolute(sessionValue)) throw new Error("relative session path");
    session = { source: text(ref.source), agent: text(ref.agent), kind: ref.kind, value: sessionValue };
  }
  const cwd = text(pane.cwd);
  if (!posix.isAbsolute(cwd)) throw new Error("relative pane cwd");
  return { id: text(pane.pane_id), cwd, agent: optionalText(pane.agent), session };
}

export function resumeArgv(session: Session): string[] | undefined {
  if (session.kind === "path" && session.agent !== "pi" && session.agent !== "omp") return;
  const form = resumeForms.find(([agent, source]) => agent === session.agent && source === session.source);
  if (!form) return;
  const [, , executable, flag] = form;
  return flag.endsWith("=") ? [executable, flag + session.value] : [executable, flag, session.value];
}

// Matches Herdr's POSIX quoting, including single quotes, $, ; and whitespace.
export function quote(value: string): string {
  return /^[a-zA-Z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export type Shell = { pane: string; pid: number; tty: string | undefined };

export function ttyPath(name: string): string | undefined {
  const path = name.startsWith("/dev/") ? name : `/dev/${name}`;
  return /^\/dev\/(?:ttys[a-zA-Z0-9]+|pts\/\d+)$/.test(path) ? path : undefined;
}

export function foregroundShell(value: unknown): Shell | undefined {
  const info = record(value);
  const pid = info.shell_pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return;
  if (info.foreground_process_group_id !== pid || !Array.isArray(info.foreground_processes)) return;
  if (info.foreground_processes.length !== 1) return;
  const process = record(info.foreground_processes[0]);
  if (process.pid !== pid || typeof process.name !== "string") return;
  // The displayed cd/quoting syntax is for POSIX-style shells, not nu/PowerShell.
  if (!["sh", "bash", "zsh", "dash", "ksh"].includes(basename(process.name).replace(/^-/, ""))) return;
  const tty = optionalText(info.tty);
  if (tty !== undefined && ttyPath(tty) !== tty) return;
  return { pane: text(info.pane_id), pid, tty };
}

export function formatNotice(
  pane: Pane,
  session: Session,
  argv: string[],
  missingPath: boolean,
  resumeUrl?: string,
  name?: string,
): string {
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";
  const cyan = "\x1b[1;36m";
  const green = "\x1b[32m";
  const separator = ` ${dim}·${reset} `;
  const link = (label: string, url: string) =>
    `\x1b]8;;${url}\x1b\\${dim}[${reset}${cyan}${label}${reset}${dim}]${reset}\x1b]8;;\x1b\\`;
  const actions = resumeUrl
    ? [
        link("Resume", resumeUrl),
        ...(session.kind === "path" ? [link("Transcript", pathToFileURL(session.value).href)] : []),
        link("Directory", pathToFileURL(pane.cwd).href),
        `${dim}Ctrl-click Resume${reset}`,
      ].join(separator)
    : `${green}cd -- ${quote(pane.cwd)} && ${argv.map(quote).join(" ")}${reset}`;
  return [
    "",
    `${cyan}${session.agent}${reset}${separator}${dim}paused${reset}${name ? `${separator}\x1b[1m${name}${reset}` : ""}`,
    actions,
    ...(missingPath ? ["\x1b[33mTranscript missing; restore it before resuming.\x1b[0m"] : []),
    "",
  ].join("\r\n");
}
