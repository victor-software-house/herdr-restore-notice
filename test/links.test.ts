import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { formatNotice, parsePane } from "../src/notice.ts";
import { linksEnabled, resumeToken } from "../src/runtime.ts";

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
  expect(output).toContain(`\x1b]8;;herdr-resume://${token}\x1b\\[Resume]`);
  const visible = Bun.stripANSI(output);
  expect(visible).toBe(
    "\r\npi session retained · w1:p1\r\n[Resume] · [Transcript] · [Directory] · Ctrl-click Resume\r\n",
  );
  expect(visible).not.toContain("/tmp");
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
