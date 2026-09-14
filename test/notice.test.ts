import { describe, expect, test } from "bun:test";
import {
  foregroundShell,
  formatNotice,
  parsePane,
  quote,
  resumeArgv,
  type Session,
  ttyPath,
} from "../src/notice.ts";
import {
  displayLabel,
  formatRetainedLine,
  metadataArgs,
  releasedPaneId,
  restoredShellPanes,
  routingName,
  shellIdentity,
} from "../src/runtime.ts";

const session: Session = { source: "herdr:pi", agent: "pi", kind: "path", value: "/tmp/session.jsonl" };
const pane = { pane_id: "w1:p1", cwd: "/tmp/project", agent_session: session };

describe("native restore argv", () => {
  // Forms published by https://herdr.dev/docs/session-state/ and checked against
  // the installed revision's planner, not names guessed from agent.start.
  test.each([
    ["claude", "claude --resume ref"],
    ["codex", "codex resume ref"],
    ["copilot", "copilot --resume=ref"],
    ["devin", "devin --resume ref"],
    ["droid", "droid --resume ref"],
    ["kimi", "kimi --session ref"],
    ["mastracode", "mastracode --thread ref"],
    ["pi", "pi --session ref"],
    ["omp", "omp --resume=ref"],
    ["hermes", "hermes --resume ref"],
    ["opencode", "opencode --session ref"],
    ["qodercli", "qodercli --resume ref"],
    ["qwen", "qwen --resume ref"],
    ["kilo", "kilo --session ref"],
    ["cursor", "cursor-agent --resume ref"],
    ["grok", "grok --resume ref"],
  ])("%s", (agent, expected) => {
    const ref: Session = { source: `herdr:${agent}`, agent, kind: "id", value: "ref" };
    expect(resumeArgv(ref)?.join(" ")).toBe(expected);
  });
  test("Antigravity's reported agent and source differ", () => {
    expect(resumeArgv({ source: "herdr:antigravity_cli", agent: "agy", kind: "id", value: "ref" })).toEqual([
      "agy",
      "--conversation",
      "ref",
    ]);
  });
  test("paths only apply to pi/omp; custom and unknown sources are not trusted", () => {
    expect(resumeArgv(session)).toEqual(["pi", "--session", "/tmp/session.jsonl"]);
    expect(resumeArgv({ ...session, source: "herdr:omp", agent: "omp" })).toEqual([
      "omp",
      "--resume=/tmp/session.jsonl",
    ]);
    expect(resumeArgv({ ...session, source: "herdr:claude", agent: "claude" })).toBeUndefined();
    expect(resumeArgv({ ...session, source: "custom:pi" })).toBeUndefined();
    expect(resumeArgv({ ...session, agent: "future-agent" })).toBeUndefined();
  });
  test("quote round-trips actual POSIX shell arguments without executing data", async () => {
    const values = ["", "safe/path", "two words", "a'b", "$(exit 99); *", "--resume=a'b c"];
    const command = `set -- ${values.map(quote).join(" ")}; printf '%s\\0' "$@"`;
    const child = Bun.spawn(["/bin/sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
    expect((await new Response(child.stdout).text()).split("\0").slice(0, -1)).toEqual(values);
    expect(await child.exited).toBe(0);
  });
});

describe("boundary validation", () => {
  test.each(["a\nb", "bad\x1b]52;c;", "ref\u202eevil", "ref\u0085"])("rejects control text %j", (value) => {
    expect(() => parsePane({ ...pane, agent_session: { ...session, value } })).toThrow();
  });
  test("rejects malformed shapes, invalid paths and overlong references", () => {
    for (const value of [
      null,
      [],
      {},
      { ...pane, cwd: "relative" },
      { ...pane, agent_session: { ...session, kind: "other" } },
      { ...pane, agent_session: { ...session, value: "relative" } },
      { ...pane, agent_session: { ...session, kind: "id", value: "a".repeat(513) } },
    ]) {
      expect(() => parsePane(value)).toThrow();
    }
  });
});

test("snapshot selects retained shells, never active or pending agent panes", () => {
  expect(restoredShellPanes({ panes: [pane], agents: [] })).toEqual([pane]);
  for (const agent of [
    { pane_id: pane.pane_id, agent: "pi", launch_pending: true },
    { pane_id: pane.pane_id, agent: "pi", launch_pending: false },
    { pane_id: pane.pane_id, agent: null },
    { pane_id: pane.pane_id, agent: "future-agent" },
  ]) {
    expect(restoredShellPanes({ panes: [pane], agents: [agent] })).toEqual([]);
  }
  expect(restoredShellPanes({ panes: [{ ...pane, agent: "pi" }], agents: [] })).toEqual([]);
  expect(restoredShellPanes({ panes: [{ ...pane, agent_session: null }], agents: [] })).toEqual([]);
  expect(restoredShellPanes({ panes: [pane], agents: [{ pane_id: "other" }] })).toEqual([pane]);
  for (const invalid of [null, {}, { panes: [pane] }, { panes: [pane], agents: [{}] }]) {
    expect(() => restoredShellPanes(invalid)).toThrow();
  }
});

const processInfo = {
  pane_id: "w1:p1",
  shell_pid: 123,
  foreground_process_group_id: 123,
  tty: "/dev/ttys007",
  foreground_processes: [{ pid: 123, name: "zsh" }],
};

test("output eligibility requires the same foreground shell and a PTY path", () => {
  expect(foregroundShell(processInfo)).toEqual({ pane: "w1:p1", pid: 123, tty: "/dev/ttys007" });
  expect(foregroundShell({ ...processInfo, tty: undefined })).toEqual({
    pane: "w1:p1",
    pid: 123,
    tty: undefined,
  });
  expect(ttyPath("ttys007")).toBe("/dev/ttys007");
  expect(ttyPath("pts/9")).toBe("/dev/pts/9");
  expect(ttyPath("?")).toBeUndefined();
  expect(ttyPath("../tmp/file")).toBeUndefined();
  expect(ttyPath("ttys007\n")).toBeUndefined();
  expect(foregroundShell({ ...processInfo, tty: "/dev/pts/9" })).toBeDefined();
  for (const update of [
    { foreground_process_group_id: 999 },
    { foreground_processes: [] },
    { foreground_processes: [{ pid: 123, name: "pi" }] },
    { foreground_processes: [{ pid: 123, name: "nu" }] },
    { foreground_processes: [{ pid: 999, name: "zsh" }] },
    { tty: "/tmp/arbitrary-file" },
    { tty: "/dev/pts/../null" },
    { shell_pid: 0 },
  ])
    expect(foregroundShell({ ...processInfo, ...update })).toBeUndefined();
});

test("colored notice shows cwd and literal command, with no guessed environment", () => {
  const parsed = parsePane({ ...pane, cwd: "/tmp/project's files" });
  const notice = formatNotice(parsed, session, ["pi", "--session", session.value], true);
  expect(notice).toContain("\x1b[1;36m");
  expect(notice).toContain("cd -- '/tmp/project'\\''s files' && pi --session /tmp/session.jsonl");
  expect(notice).toContain("Transcript missing");
  expect(notice).not.toContain("Nothing was started");
  expect(notice).not.toContain("shell input unchanged");
  expect(notice).not.toContain("HERDR_SOCKET_PATH=");
});

test("deduplication survives handoff but not a restarted or reused shell PID", () => {
  const shell = { pane: "w1:p1", pid: 123, tty: "/dev/ttys007" };
  const key = shellIdentity(shell, "start-one", JSON.stringify(session));
  expect(shellIdentity({ ...shell, pane: "w2:p2" }, "start-one", JSON.stringify(session))).toBe(key);
  expect(shellIdentity(shell, "start-two", JSON.stringify(session))).not.toBe(key);
  expect(shellIdentity({ ...shell, pid: 124 }, "start-one", JSON.stringify(session))).not.toBe(key);
  expect(key).toMatch(/^[a-f0-9]{64}$/);
});

test("routing names stay unique hashes; display labels hide them", () => {
  const token = "a".repeat(64);
  expect(routingName(token)).toBe(`resume-${"a".repeat(16)}`);
  expect(routingName(token).length).toBeLessThanOrEqual(32);
  expect(displayLabel(session)).toBe("pi");
  expect(displayLabel(session, "Restore notice polish")).toBe("Restore notice polish");
  expect(metadataArgs("w1:p1", session, "pi")).toEqual([
    "pane",
    "report-metadata",
    "w1:p1",
    "--source",
    "vsh.restore-notice",
    "--agent",
    "pi",
    "--display-agent",
    "pi",
  ]);
});

test("release notices fire only when the agent actually left", () => {
  const paneId = "w1:p1";
  expect(
    releasedPaneId({
      event: "pane.agent_detected",
      data: { type: "pane_agent_detected", pane_id: paneId, workspace_id: "w1", released: true },
    }),
  ).toBe(paneId);
  expect(
    releasedPaneId({
      event: "pane.agent_detected",
      data: { type: "pane_agent_detected", pane_id: paneId, workspace_id: "w1", released: false },
    }),
  ).toBeUndefined();
  expect(
    releasedPaneId({
      event: "pane.agent_detected",
      data: { type: "pane_agent_detected", pane_id: paneId, workspace_id: "w1" },
    }),
  ).toBeUndefined();
  expect(
    releasedPaneId({
      event: "pane.agent_status_changed",
      data: { type: "pane_agent_status_changed", pane_id: paneId, workspace_id: "w1", agent_status: "idle" },
    }),
  ).toBeUndefined();
});

test("retained list lines keep the paused heading without routing names", () => {
  const parsed = parsePane(pane);
  expect(formatRetainedLine(parsed)).toBe("pi · paused  w1:p1  /tmp/project");
  expect(formatRetainedLine(parsed, "Restore notice polish")).toBe(
    "pi · paused · Restore notice polish  w1:p1  /tmp/project",
  );
});
