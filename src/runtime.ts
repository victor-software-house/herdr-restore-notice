import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isatty } from "node:tty";
import {
  foregroundShell,
  formatNotice,
  type Pane,
  parsePane,
  record,
  resumeArgv,
  type Session,
  type Shell,
  ttyPath,
} from "./notice.ts";

// Child-process timeouts are intentional: a dead server must not leave a startup
// hook hanging indefinitely. No subprocess here receives terminal stdin.
async function command(argv: string[], timeout = 5000): Promise<string> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout });
  const [stdout, stderr, exit] = await Promise.all([
    Bun.readableStreamToText(child.stdout),
    Bun.readableStreamToText(child.stderr),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`${argv[0]} failed (${exit}): ${stderr.trim()}`);
  return stdout;
}

async function herdr(...args: string[]): Promise<Record<string, unknown>> {
  const binary = process.env.HERDR_BIN_PATH;
  if (!binary) throw new Error("HERDR_BIN_PATH is required");
  const response = record(JSON.parse(await command([binary, ...args])));
  if (response.error) throw new Error("Herdr rejected the request");
  return record(response.result);
}

export function restoredShellPanes(value: unknown): Record<string, unknown>[] {
  const snapshot = record(value);
  if (!Array.isArray(snapshot.panes) || !Array.isArray(snapshot.agents)) {
    throw new Error("session.snapshot did not return panes and agents");
  }
  // AgentInfo includes deferred launches, even before a process has started.
  // Exclude every agent occupant, not just those already detected in a PTY.
  const occupied = new Set(
    snapshot.agents.map((value: unknown) => {
      const agent = record(value);
      if (typeof agent.pane_id !== "string") throw new Error("agent has no pane_id");
      return agent.pane_id;
    }),
  );
  return snapshot.panes
    .map(record)
    .filter(
      (pane) => pane.agent_session != null && pane.agent == null && !occupied.has(String(pane.pane_id)),
    );
}

function hash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function shellIdentity(shell: Shell, started: string, sessionKey: string): string {
  return hash(JSON.stringify([shell.pid, started, shell.tty, sessionKey]));
}

export function routingName(token: string): string {
  return `resume-${token.slice(0, 16)}`;
}

export function displayLabel(session: Session, name?: string): string {
  return name ?? session.agent;
}

export function releasedPaneId(value: unknown): string | undefined {
  const envelope = record(value);
  if (envelope.event !== "pane.agent_detected") return;
  const data = record(envelope.data);
  if (data.type !== "pane_agent_detected" || data.released !== true) return;
  if (typeof data.pane_id !== "string" || data.pane_id.length === 0) return;
  return data.pane_id;
}

export function formatRetainedLine(pane: Pane, name?: string): string {
  const session = pane.session;
  if (!session) throw new Error("retained pane has no session");
  return `${session.agent} · paused${name ? ` · ${name}` : ""}  ${pane.id}  ${pane.cwd}`;
}

export function metadataArgs(paneId: string, session: Session, label: string): string[] {
  return [
    "pane",
    "report-metadata",
    paneId,
    "--source",
    "vsh.restore-notice",
    "--agent",
    session.agent,
    "--display-agent",
    label,
  ];
}

// Write to the slave side of the PTY: these are output bytes, not shell input.
// No O_CREAT, no truncation, no symlinks, no controlling-terminal acquisition.
export async function writeToTty(
  tty: string,
  notice: string,
  stillOwned: () => Promise<boolean>,
): Promise<boolean> {
  const file = await open(
    tty,
    constants.O_WRONLY | constants.O_NOCTTY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isCharacterDevice() || !isatty(file.fd) || info.uid !== process.getuid?.()) {
      throw new Error("refusing output to a non-owned terminal device");
    }
    if (!(await stillOwned())) return false;
    const current = await lstat(tty);
    if (
      !current.isCharacterDevice() ||
      current.dev !== info.dev ||
      current.ino !== info.ino ||
      current.rdev !== info.rdev
    )
      return false;
    const bytes = Buffer.from(notice);
    let offset = 0;
    const deadline = Date.now() + 1000;
    while (offset < bytes.length) {
      try {
        const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
        if (bytesWritten === 0) throw new Error("terminal accepted no output");
        offset += bytesWritten;
      } catch (error) {
        // A nonblocking PTY can temporarily reject output while its reader or
        // line discipline is busy. Keep the hook bounded and recheck ownership.
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          (error.code !== "EAGAIN" && error.code !== "EWOULDBLOCK") ||
          Date.now() >= deadline
        )
          throw error;
        await Bun.sleep(10);
        if (!(await stillOwned())) return false;
      }
    }
    return true;
  } finally {
    await file.close();
  }
}

export async function linksEnabled(): Promise<boolean> {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!dir) throw new Error("HERDR_PLUGIN_CONFIG_DIR is required");
  const file = Bun.file(join(dir, "config.json"));
  if (!(await file.exists())) return true;
  const config = record(await file.json());
  if (Object.keys(config).some((key) => key !== "links") || typeof config.links !== "boolean") {
    throw new Error('config.json must contain {"links": true} or {"links": false}');
  }
  return config.links;
}

export function resumeToken(url: string): string {
  const token = /^herdr-resume:\/\/([a-f0-9]{64})$/.exec(url)?.[1];
  if (!token || url !== `herdr-resume://${token}`) throw new Error("invalid resume link");
  return token;
}

function pluginDirs(): { socket: string; stateDir: string; ticketsDir: string; statePath: string } {
  const socket = process.env.HERDR_SOCKET_PATH;
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!socket || !stateDir) throw new Error("Herdr socket and plugin state directory are required");
  return {
    socket,
    stateDir,
    ticketsDir: join(stateDir, hash(socket)),
    statePath: join(stateDir, `${hash(socket)}.json`),
  };
}

async function loadSeen(statePath: string): Promise<Set<string>> {
  const previous = Bun.file(statePath);
  const saved: unknown = (await previous.exists()) ? await previous.json() : [];
  if (!Array.isArray(saved) || !saved.every((key) => typeof key === "string")) {
    throw new Error("invalid restore-notice delivery state");
  }
  return new Set(saved);
}

async function saveSeen(statePath: string, seen: Iterable<string>): Promise<void> {
  const temp = `${statePath}.${process.pid}.tmp`;
  await Bun.write(temp, `${JSON.stringify([...seen])}\n`, { mode: 0o600 });
  await rename(temp, statePath);
}

export async function resume(): Promise<void> {
  const context = record(JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}"));
  const url = process.env.HERDR_PLUGIN_CLICKED_URL;
  const socket = process.env.HERDR_SOCKET_PATH;
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  const binary = process.env.HERDR_BIN_PATH;
  if (context.invocation_source !== "link_click" || !url || !socket || !stateDir || !binary) {
    throw new Error("resume requires a Herdr link click");
  }
  const token = resumeToken(url);
  const ticketPath = join(stateDir, hash(socket), `${token}.json`);
  const ticket = record(await Bun.file(ticketPath).json());
  const original = parsePane(ticket.pane);
  if (original.id !== process.env.HERDR_PANE_ID) throw new Error("link belongs to another pane");
  const raw = restoredShellPanes((await herdr("api", "snapshot")).snapshot).find(
    (pane) => pane.pane_id === original.id,
  );
  if (!raw) throw new Error("pane is no longer an available restored shell");
  const current = parsePane(raw);
  if (current.cwd !== original.cwd || JSON.stringify(current.session) !== JSON.stringify(original.session)) {
    throw new Error("retained session or directory changed");
  }
  const session = current.session;
  const argv = session && resumeArgv(session);
  if (!session || !argv) throw new Error("unsupported native session");
  if (session.kind === "path" && !(await Bun.file(session.value).exists()))
    throw new Error("transcript is missing");
  const shell = foregroundShell((await herdr("pane", "process-info", "--pane", current.id)).process_info);
  if (!shell) throw new Error("pane is busy");
  const tty = ttyPath((await command(["ps", "-p", String(shell.pid), "-o", "tty="])).trim());
  const started = (await command(["ps", "-p", String(shell.pid), "-o", "lstart="])).trim();
  if (
    !tty ||
    (shell.tty !== undefined && shell.tty !== tty) ||
    shellIdentity({ ...shell, tty }, started, JSON.stringify(session)) !== token
  ) {
    throw new Error("resume link expired after the shell changed");
  }
  // Exclusive claim prevents concurrent/replayed clicks, including a launch that
  // succeeds but times out waiting for agent readiness. Never retry blindly.
  const claim = await open(`${ticketPath}.used`, "wx", 0o600);
  await claim.close();
  await command(
    [
      binary,
      "agent",
      "start",
      routingName(token),
      "--kind",
      session.agent,
      "--pane",
      current.id,
      "--",
      ...argv.slice(1),
    ],
    35000,
  );
  // Routing names must be unique and match [a-z][a-z0-9_-]{0,31}. Keep the
  // ticket hash there; the sidebar agent token prefers display_agent.
  try {
    await herdr(...metadataArgs(current.id, session, displayLabel(session, await sessionName(session))));
  } catch (error) {
    console.error(`restore-notice: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function sessionName(session: Session): Promise<string | undefined> {
  if (session.agent !== "pi" || session.source !== "herdr:pi" || session.kind !== "path") return;
  try {
    if (!(await lstat(session.value)).isFile()) return;
    const file = await open(session.value, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      let name: string | undefined;
      for await (const line of file.readLines()) {
        if (!line.includes('"session_info"')) continue;
        let entry: Record<string, unknown>;
        try {
          entry = record(JSON.parse(line));
        } catch {
          continue;
        }
        if (entry.type !== "session_info") continue;
        // Pi uses the latest entry, including an empty name to clear a title.
        const candidate = typeof entry.name === "string" ? entry.name.trim() : "";
        name = candidate && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(candidate) ? candidate : undefined;
      }
      if (!name) return;
      const chars = Array.from(name);
      return chars.length > 64 ? `${chars.slice(0, 63).join("")}…` : name;
    } finally {
      await file.close();
    }
  } catch {
    // Display metadata must never prevent a valid resume notice.
    return;
  }
}

async function waitForForegroundShell(paneId: string, deadline: number): Promise<Shell | undefined> {
  do {
    const info = await herdr("pane", "process-info", "--pane", paneId);
    const shell = foregroundShell(info.process_info);
    if (shell) return shell;
    await Bun.sleep(150);
  } while (Date.now() < deadline);
  return;
}

async function deliverNotice(
  raw: Record<string, unknown>,
  links: boolean,
  ticketsDir: string,
  deadline: number,
  skip?: Set<string>,
): Promise<{ identity: string; written: boolean } | undefined> {
  const pane = parsePane(raw);
  const session = pane.session;
  if (!session) return;
  const argv = resumeArgv(session);
  if (!argv) return;
  const sessionKey = JSON.stringify(session);
  const shell = await waitForForegroundShell(pane.id, deadline);
  if (!shell || shell.pane !== pane.id) {
    console.error(`restore-notice: ${pane.id}: skipped; no foreground POSIX shell`);
    return;
  }
  const tty = ttyPath((await command(["ps", "-p", String(shell.pid), "-o", "tty="])).trim());
  if (!tty || (shell.tty !== undefined && shell.tty !== tty)) throw new Error("shell has no matching PTY");
  const target = { ...shell, tty };
  const started = (await command(["ps", "-p", String(target.pid), "-o", "lstart="])).trim();
  if (!started) throw new Error("shell process disappeared");
  const identity = shellIdentity(target, started, sessionKey);
  if (skip?.has(identity)) return { identity, written: false };
  const missingPath = session.kind === "path" && !(await Bun.file(session.value).exists());
  const notice = formatNotice(
    pane,
    session,
    argv,
    missingPath,
    links ? `herdr-resume://${identity}` : undefined,
    await sessionName(session),
  );
  if (links) {
    await Bun.write(
      join(ticketsDir, `${identity}.json`),
      JSON.stringify({
        pane: { pane_id: pane.id, cwd: pane.cwd, agent_session: session },
      }),
      { mode: 0o600 },
    );
    // A previous click claimed this identity. After the agent exits, the same
    // shell can be offered again; drop the claim so the new notice is usable.
    await rm(join(ticketsDir, `${identity}.json.used`), { force: true });
  }
  const written = await writeToTty(target.tty, notice, async () => {
    const candidate = restoredShellPanes((await herdr("api", "snapshot")).snapshot).find(
      (value) => value.pane_id === pane.id,
    );
    if (!candidate) return false;
    const current = parsePane(candidate);
    const now = foregroundShell((await herdr("pane", "process-info", "--pane", pane.id)).process_info);
    if (current.agent || current.cwd !== pane.cwd || JSON.stringify(current.session) !== sessionKey)
      return false;
    if (
      !now ||
      now.pane !== target.pane ||
      now.pid !== target.pid ||
      (now.tty !== undefined && now.tty !== target.tty)
    )
      return false;
    const currentTty = ttyPath((await command(["ps", "-p", String(target.pid), "-o", "tty="])).trim());
    const currentStart = (await command(["ps", "-p", String(target.pid), "-o", "lstart="])).trim();
    return started === currentStart && currentTty === target.tty;
  });
  if (!written) console.error(`restore-notice: ${pane.id}: skipped; pane changed before delivery`);
  return { identity, written };
}

export async function listRetained(): Promise<void> {
  const panes = restoredShellPanes((await herdr("api", "snapshot")).snapshot);
  const lines: string[] = [];
  for (const raw of panes) {
    const pane = parsePane(raw);
    if (!pane.session || !resumeArgv(pane.session)) continue;
    lines.push(formatRetainedLine(pane, await sessionName(pane.session)));
  }
  console.log(lines.length === 0 ? "no retained sessions" : lines.join("\n"));
}

export async function released(): Promise<void> {
  if (process.env.HERDR_ENV !== "1" || process.env.HERDR_PLUGIN_EVENT !== "pane.agent_detected") {
    throw new Error("run through Herdr's pane.agent_detected hook");
  }
  const paneId = releasedPaneId(JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? "null"));
  if (!paneId) return;
  const { ticketsDir, statePath, stateDir } = pluginDirs();
  const links = await linksEnabled();
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(ticketsDir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 15000;
  let raw: Record<string, unknown> | undefined;
  do {
    raw = restoredShellPanes((await herdr("api", "snapshot")).snapshot).find(
      (pane) => pane.pane_id === paneId,
    );
    if (raw) break;
    await Bun.sleep(150);
  } while (Date.now() < deadline);
  if (!raw) return;
  const result = await deliverNotice(raw, links, ticketsDir, deadline);
  if (!result?.written) return;
  const seen = await loadSeen(statePath);
  seen.add(result.identity);
  await saveSeen(statePath, seen);
}

export async function startup(): Promise<void> {
  if (process.env.HERDR_ENV !== "1" || process.env.HERDR_PLUGIN_EVENT !== "startup") {
    throw new Error("run through Herdr's plugin startup hook");
  }
  const { ticketsDir, statePath, stateDir } = pluginDirs();
  const links = await linksEnabled();
  await mkdir(ticketsDir, { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const seen = await loadSeen(statePath);
  const retained = new Set<string>();
  const panes = restoredShellPanes((await herdr("api", "snapshot")).snapshot);
  const deadline = Date.now() + 15000;
  let failures = 0;

  // Only panes present at server startup are considered here. Agent-exit notices
  // use the pane.agent_detected hook. Live occupancy is still rechecked before
  // any PTY write.
  await Promise.all(
    panes.map(async (raw) => {
      try {
        const result = await deliverNotice(raw, links, ticketsDir, deadline, seen);
        if (!result) return;
        retained.add(result.identity);
        if (result.written) seen.add(result.identity);
      } catch (error) {
        failures += 1;
        console.error(`restore-notice: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );

  // Keyed by socket, PID and process start time, not terminal_id (which changes
  // on handoff). Retain only this startup's live shells, bounding state size.
  await saveSeen(
    statePath,
    [...retained].filter((key) => seen.has(key)),
  );
  for (const file of await readdir(ticketsDir)) {
    const token = /^([a-f0-9]{64})\.json(?:\.used)?$/.exec(file)?.[1];
    if (token && !retained.has(token)) await rm(join(ticketsDir, file));
  }
  if (failures) throw new Error(`${failures} pane notice(s) failed; see preceding diagnostics`);
}
