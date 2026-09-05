import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { formatNotice, parsePane, type Session } from "../src/notice.ts";
import { linksEnabled, resumeToken, sessionName } from "../src/runtime.ts";

const token = "a".repeat(64);
test("compact OSC links encode paths without exposing them as visible labels", () => {
  const pane = parsePane({
    pane_id: "w1:p1",
    cwd: "/tmp/a b#c",
    agent_session: {
      agent: "pi",
      source: "herdr:pi",
      kind: "path",
      value: "/tmp/session #1.jsonl",
    },
  });
  if (!pane.session) throw new Error("missing test session");
  const output = formatNotice(
    pane,
    pane.session,
    ["pi", "--session", pane.session.value],
    false,
    `herdr-resume://${token}`,
  );
  expect(output).toContain("file:///tmp/session%20%231.jsonl");
  expect(output).toContain("file:///tmp/a%20b%23c");
  expect(output).toContain(`\x1b]8;;herdr-resume://${token}\x1b\\\x1b[2m[\x1b[0m\x1b[1;36mResume`);
  expect(output.match(/\x1b\[2m·\x1b\[0m/g)).toHaveLength(4);
  const visible = Bun.stripANSI(output);
  expect(visible).toBe("\r\npi · paused\r\n[Resume] · [Transcript] · [Directory] · Ctrl-click Resume\r\n");
  expect(visible).not.toContain("/tmp");
  const named = formatNotice(
    pane,
    pane.session,
    ["pi"],
    false,
    `herdr-resume://${token}`,
    "Restore notice polish",
  );
  expect(Bun.stripANSI(named)).toStartWith("\r\npi · paused · Restore notice polish\r\n");
  expect(named).toContain("\x1b[1mRestore notice polish\x1b[0m");
  expect(named.match(/\x1b\[2m·\x1b\[0m/g)).toHaveLength(5);
  expect(named).toEndWith("\r\n");
});

test("resume URI is an opaque ticket, never command text or a filesystem path", () => {
  expect(resumeToken(`herdr-resume://${token}`)).toBe(token);
  for (const url of [
    "file:///tmp/a",
    "herdr-resume://../../a",
    `herdr-resume://${token}?cmd=sh`,
    `herdr-resume://${token}\n`,
  ]) {
    expect(() => resumeToken(url)).toThrow();
  }
});

test("only plugin-owned explicit link configuration is parsed", async () => {
  const dir = await mkdtemp("/tmp/herdr-link-config-");
  const original = process.env.HERDR_PLUGIN_CONFIG_DIR;
  process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
  try {
    expect(await linksEnabled()).toBe(true);
    await Bun.write(join(dir, "config.json"), '{"links":false}');
    expect(await linksEnabled()).toBe(false);
    for (const value of ['{"links":"auto"}', '{"links":true,"unknown":1}', "[]", "{"]) {
      await Bun.write(join(dir, "config.json"), value);
      await expect(linksEnabled()).rejects.toThrow();
    }
  } finally {
    if (original === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    else process.env.HERDR_PLUGIN_CONFIG_DIR = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi names use explicit latest metadata, never messages or file names", async () => {
  const dir = await mkdtemp("/tmp/herdr-session-name-");
  const path = join(dir, "not-a-title.jsonl");
  const session: Session = { source: "herdr:pi", agent: "pi", kind: "path", value: path };
  try {
    expect(await sessionName(session)).toBeUndefined();
    await Bun.write(path, JSON.stringify({ type: "message", name: "Not a session title" }));
    expect(await sessionName(session)).toBeUndefined();
    await Bun.write(
      path,
      [
        JSON.stringify({ type: "session_info", name: "Old title" }),
        "{invalid",
        JSON.stringify({ type: "session_info", name: "  Restore notice polish  " }),
      ].join("\n"),
    );
    expect(await sessionName(session)).toBe("Restore notice polish");
    expect(await sessionName({ ...session, kind: "id" })).toBeUndefined();
    expect(await sessionName({ ...session, agent: "codex", source: "herdr:codex" })).toBeUndefined();
    for (const name of ["", "   ", undefined, 42, "bad\x1b[31m", "bad\nline", "bad\u202e"]) {
      await Bun.write(
        path,
        [
          JSON.stringify({ type: "session_info", name: "Old title" }),
          JSON.stringify({ type: "session_info", name }),
        ].join("\n"),
      );
      expect(await sessionName(session)).toBeUndefined();
    }
    await Bun.write(path, JSON.stringify({ type: "session_info", name: "a".repeat(100) }));
    expect(await sessionName(session)).toBe(`${"a".repeat(63)}…`);
    expect(await sessionName({ ...session, value: dir })).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
