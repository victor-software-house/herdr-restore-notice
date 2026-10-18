import { describe, expect, test } from "bun:test";
import {
  agentLaunch,
  formatNotice,
  helpArgv,
  helpOptions,
  launchFlags,
  launchInput,
  parsePane,
  type Session,
} from "../src/notice.ts";
import { startedPaneId } from "../src/runtime.ts";

// Excerpts of the real help output: claude 2.1 (commander) and omp 18.6 (oclif).
const claudeHelp = `Usage: claude [options] [command] [prompt]

Options:
  --add-dir <directories...>            Additional directories to allow tool
                                        access to
  --allowedTools, --allowed-tools <tools...>
      Comma or space-separated list of tool names to allow (e.g. "Bash(git *)
      Edit")
  -c, --continue                        Continue the most recent conversation in
  --dangerously-skip-permissions        Bypass all permission checks.
  -d, --debug [filter]                  Enable debug mode with optional category
  --desktop                             Open in the Claude Desktop app instead
                                        --bogus <id> to pick the session)
  --fork-session                        When resuming, create a new session ID
  --model <model>                       Model for the current session. Provide
  -n, --name <name>                     Set a display name for this session
  --permission-mode <mode>              Permission mode to use for the session
  --remote-control [name]               Start an interactive session with Remote
  -r, --resume [value]                  Resume a conversation by session ID, or
  --session-id <uuid>                   Use a specific session ID for the
`;
const ompHelp = `FLAGS
      --model=<value>                   Model to use
      --add-dir=<value>                 Add a workspace directory (repeatable)
  -c, --continue                        Continue previous session
  -r, --resume=<value>                  Resume a session
      --auto-approve                    Auto-approve all tool calls
`;
const claude: Session = { source: "herdr:claude", agent: "claude", kind: "id", value: "abc" };
const omp: Session = { source: "herdr:omp", agent: "omp", kind: "path", value: "/tmp/s.jsonl" };

describe("help options", () => {
  test("commander names, aliases and value forms", () => {
    const options = helpOptions(claudeHelp);
    expect(options.get("--model")).toBe("one");
    expect(options.get("-n")).toBe("one");
    expect(options.get("--name")).toBe("one");
    expect(options.get("--add-dir")).toBe("many");
    expect(options.get("--allowedTools")).toBe("many");
    expect(options.get("--allowed-tools")).toBe("many");
    expect(options.get("--debug")).toBe("optional");
    expect(options.get("--dangerously-skip-permissions")).toBe("none");
    // Wrapped description text that happens to start with an option is not an option line.
    expect(options.has("--bogus")).toBe(false);
  });
  test("oclif's --name=<value>", () => {
    const options = helpOptions(ompHelp);
    expect(options.get("--model")).toBe("one");
    expect(options.get("-r")).toBe("one");
    expect(options.get("--auto-approve")).toBe("none");
  });
  test("help is read for the command that resumes", () => {
    expect(helpArgv(claude)).toEqual(["claude", "--help"]);
    expect(helpArgv({ source: "herdr:codex", agent: "codex", kind: "id", value: "x" })).toEqual([
      "codex",
      "resume",
      "--help",
    ]);
  });
});

describe("launch flags", () => {
  const options = helpOptions(claudeHelp);
  test("options still listed are applied with their values", () => {
    const flags = launchFlags(
      ["--model", "opus", "--permission-mode", "plan", "-n", "Docs", "--remote-control", "mac"],
      options,
      claude,
    );
    expect(flags).toEqual({
      applied: ["--model", "opus", "--permission-mode", "plan", "-n", "Docs", "--remote-control", "mac"],
      dropped: [],
      unchecked: false,
    });
  });
  test("the paused conversation replaces conversation pickers", () => {
    const flags = launchFlags(
      ["--resume", "old-id", "--fork-session", "-c", "--model", "opus"],
      options,
      claude,
    );
    expect(flags.applied).toEqual(["--model", "opus"]);
    expect(flags.dropped).toEqual([]);
    expect(
      launchFlags(["--resume=/tmp/old.jsonl", "--model=sonnet"], helpOptions(ompHelp), omp).applied,
    ).toEqual(["--model=sonnet"]);
  });
  test("a prompt is never sent again, and a removed option is named", () => {
    const flags = launchFlags(
      ["--sandbox", "--model", "opus", "Read the brief and follow it."],
      options,
      claude,
    );
    expect(flags.applied).toEqual(["--model", "opus"]);
    expect(flags.dropped).toEqual([
      { words: "--sandbox", reason: "no longer an option" },
      { words: "Read the brief and follow it.", reason: "not sent again" },
    ]);
  });
  test("a variadic option takes words up to the next option", () => {
    expect(launchFlags(["--add-dir", "/a", "/b", "--model", "opus"], options, claude).applied).toEqual([
      "--add-dir",
      "/a",
      "/b",
      "--model",
      "opus",
    ]);
  });
  test("unreadable help applies nothing and says so", () => {
    expect(launchFlags(["--model", "opus"], undefined, claude)).toEqual({
      applied: [],
      dropped: [],
      unchecked: true,
    });
    expect(launchFlags([], undefined, claude).unchecked).toBe(false);
  });
});

describe("launch input", () => {
  test("one launch line per pane, program name excluded", () => {
    const input = JSON.stringify({ launch: [{ pane_id: "w1:p2", argv: ["--model", "opus"] }] });
    expect(launchInput(input)).toEqual(new Map([["w1:p2", ["--model", "opus"]]]));
    expect(launchInput(undefined).size).toBe(0);
  });
  test.each([
    ["not JSON", "--model"],
    ["no list", "{}"],
    ["not strings", JSON.stringify({ launch: [{ pane_id: "w1:p2", argv: [1] }] })],
    ["control characters", JSON.stringify({ launch: [{ pane_id: "w1:p2", argv: ["\x1b[2J"] }] })],
    ["too many words", JSON.stringify({ launch: [{ pane_id: "w1:p2", argv: Array(65).fill("-x") }] })],
  ])("%s is rejected", (_, input) => {
    expect(() => launchInput(input)).toThrow();
  });
});

test("the notice shows what Resume applies and what it leaves out", () => {
  const pane = parsePane({ pane_id: "w1:p1", cwd: "/tmp/project", agent_session: claude });
  const flags = {
    applied: ["--model", "opus"],
    dropped: [{ words: "--sandbox", reason: "no longer an option" as const }],
    unchecked: false,
  };
  const linked = formatNotice(
    pane,
    claude,
    ["claude", "--resume", "abc"],
    false,
    "herdr-resume://x",
    undefined,
    flags,
  );
  expect(linked).toContain("flags\x1b[0m --model opus");
  expect(linked).toContain("Not reapplied (no longer an option): --sandbox");
  const plain = formatNotice(pane, claude, ["claude", "--resume", "abc"], false, undefined, undefined, flags);
  expect(plain).toContain("claude --resume abc --model opus");
  const unchecked = formatNotice(
    pane,
    claude,
    ["claude", "--resume", "abc"],
    false,
    "herdr-resume://x",
    undefined,
    {
      applied: [],
      dropped: [],
      unchecked: true,
    },
  );
  expect(unchecked).toContain("Launch flags not reapplied: claude --help could not be read.");
});

describe("capture on agent start", () => {
  // Observed on herdr 0.9.5: the wrapper leads the group; the agent and its helpers follow.
  const info = {
    foreground_process_group_id: 48462,
    foreground_processes: [
      { pid: 48500, argv0: "bun", argv: ["bun", "/tmp/research-mcp"] },
      { pid: 48494, argv0: "claude", argv: ["claude", "--model", "opus", "--resume", "abc"] },
      { pid: 48462, argv0: "fnox", argv: ["fnox", "exec", "--", "claude", "--model", "opus"] },
    ],
  };
  test("the agent's own process, not the wrapper", () => {
    expect(agentLaunch(info, "claude")).toEqual(["--model", "opus", "--resume", "abc"]);
    expect(agentLaunch(info, "pi")).toBeUndefined();
  });
  test("a rewritten title gives no line, and unsafe words give none", () => {
    expect(
      agentLaunch({ foreground_processes: [{ pid: 1, argv0: "pi", argv: null }] }, "pi"),
    ).toBeUndefined();
    expect(
      agentLaunch({ foreground_processes: [{ pid: 1, argv: ["claude", "\x1b[2J"] }] }, "claude"),
    ).toBeUndefined();
  });
  test("only a detection, not a release, starts a capture", () => {
    // The data exactly as Herdr 0.9.5 serializes it: no `released` key unless true.
    const event = (data: Record<string, unknown>) => ({
      event: "pane.agent_detected",
      data: { type: "pane_agent_detected", pane_id: "w1:p2", workspace_id: "w1", ...data },
    });
    expect(startedPaneId(event({ agent: "claude" }))).toBe("w1:p2");
    expect(startedPaneId(event({ agent: "claude", released: true, final_status: "idle" }))).toBeUndefined();
    expect(startedPaneId(event({}))).toBeUndefined();
  });
});
