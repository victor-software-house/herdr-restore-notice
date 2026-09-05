import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatNotice, parsePane } from "../src/notice.ts";
import { writeToTty } from "../src/runtime.ts";

test("notice is colored PTY output, not pending shell input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "restore-notice-pty-"));
  const marker = join(dir, "must-not-exist");
  let output = "";
  let notify = () => {};
  const child = Bun.spawn(["/bin/sh", "-i"], {
    terminal: {
      cols: 100,
      rows: 30,
      data(_terminal, bytes) {
        output += bytes.toString();
        notify();
      },
    },
    env: { ...process.env, ENV: "/dev/null", PS1: "$ " },
  });
  const terminal = child.terminal;
  if (!terminal) {
    child.kill("SIGKILL");
    throw new Error("PTY allocation failed");
  }
  async function wait(pattern: RegExp) {
    if (pattern.test(output)) return;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => reject(new Error(`missing ${pattern}: ${output}`)), 3000);
    notify = () => {
      if (pattern.test(output)) resolve();
    };
    try {
      await promise;
    } finally {
      clearTimeout(timer);
      notify = () => {};
    }
  }
  try {
    terminal.write("tty\n");
    await wait(/\/dev\/(?:ttys\w+|pts\/\d+)/);
    const tty = output.match(/\/dev\/(?:ttys\w+|pts\/\d+)/)?.[0];
    if (!tty) throw new Error("no PTY slave path");
    const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "retained-session" };
    const pane = parsePane({ pane_id: "w1:p1", cwd: dir, agent_session: session });
    if (!pane.session) throw new Error("missing session");
    const notice = formatNotice(pane, pane.session, ["touch", marker], false);
    expect(await writeToTty(tty, notice, async () => true)).toBe(true);
    await wait(/touch /);
    expect(output).toContain("\x1b[1;36m");
    expect(output).toContain(`touch ${marker}`);
    // If the displayed command had entered the line editor, this blank Enter
    // would run it. A following explicit test command proves the shell is usable.
    terminal.write("\nprintf '\\n__INPUT_EMPTY__\\n'\n");
    await wait(/\r?\n__INPUT_EMPTY__\r?\n/);
    expect(await Bun.file(marker).exists()).toBe(false);

    output = "";
    expect(await writeToTty(tty, "DO_NOT_PRINT", async () => false)).toBe(false);
    expect(output).not.toContain("DO_NOT_PRINT");
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    terminal.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("TTY writer refuses regular files, symlinks and nonexistent targets without truncation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "restore-notice-device-"));
  try {
    const path = join(dir, "file");
    await Bun.write(path, "untouched");
    await expect(writeToTty(path, "wrong", async () => true)).rejects.toThrow();
    expect(await Bun.file(path).text()).toBe("untouched");
    await symlink(path, join(dir, "link"));
    await expect(writeToTty(join(dir, "link"), "wrong", async () => true)).rejects.toThrow();
    await expect(writeToTty(join(dir, "missing"), "wrong", async () => true)).rejects.toThrow();
    expect(await Bun.file(join(dir, "missing")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
