import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { quote, record } from "../src/notice.ts";

// Explicitly opt in. Never connects to or restarts an existing Herdr session.
// Build the plugin first, then HERDR_TEST_BIN=/path/to/herdr bun test this-file.
const binary = process.env.HERDR_TEST_BIN;
test.skipIf(!binary)(
  "real Herdr restore invokes startup and retains colored output without resuming",
  async () => {
    if (!binary) throw new Error("HERDR_TEST_BIN is required");
    // Short private paths fit the Unix socket length limit on macOS.
    const dir = await realpath(await mkdtemp("/tmp/herdr-notice-live-"));
    const configHome = join(dir, "config");
    const config = join(configHome, "herdr", "config.toml");
    const savedDir = join(configHome, "herdr", "sessions", "restore-notice-test");
    const socket = join(savedDir, "herdr.sock");
    const plugin = resolve(import.meta.dir, "..");
    const marker = join(dir, "agent-started");
    const env = {
      ...process.env,
      HOME: dir,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: join(dir, "state"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      HERDR_CONFIG_PATH: config,
      HERDR_SOCKET_PATH: socket,
      HERDR_SESSION: "restore-notice-test",
      HERDR_ENV: "",
      CODEX_THREAD_ID: "outer-thread-must-not-leak",
      WT_SESSION: "outer-terminal-must-not-leak",
      ENV: "/dev/null",
      SHELL: "/bin/sh",
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
    };
    async function cli(...args: string[]) {
      const child = Bun.spawn([binary ?? "", ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
      });
      const [out, err, exit] = await Promise.all([
        Bun.readableStreamToText(child.stdout),
        Bun.readableStreamToText(child.stderr),
        child.exited,
      ]);
      if (exit) throw new Error(`${args.join(" ")}: ${err} ${out}`);
      return out;
    }
    let server: ReturnType<typeof Bun.spawn> | undefined;
    const clients: ReturnType<typeof Bun.spawn>[] = [];
    let started = 0;
    async function waitForPane(): Promise<string> {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try {
          const list = record(record(JSON.parse(await cli("pane", "list"))).result);
          if (Array.isArray(list.panes)) {
            const id = record(list.panes[0]).pane_id;
            if (typeof id === "string") return id;
          }
        } catch {
          /* this test's socket is not listening yet */
        }
        await Bun.sleep(50);
      }
      throw new Error("isolated Herdr did not restore a pane");
    }
    async function waitForHook() {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const result = record(
          record(JSON.parse(await cli("plugin", "log", "list", "--plugin", "vsh.restore-notice"))).result,
        );
        if (!Array.isArray(result.logs)) throw new Error("plugin log list did not return logs");
        const log = result.logs
          .map(record)
          .find(
            (log) =>
              log.event === "startup" &&
              typeof log.started_unix_ms === "number" &&
              log.started_unix_ms >= started,
          );
        if (log?.finished_unix_ms != null) {
          expect(log.exit_code, JSON.stringify(log)).toBe(0);
          expect(log.stderr ?? "").toBe("");
          return;
        }
        await Bun.sleep(50);
      }
      throw new Error("isolated startup hook did not finish");
    }
    function startHeadless() {
      started = Date.now();
      server = Bun.spawn([binary ?? "", "server"], { env, stdout: "ignore", stderr: "pipe" });
    }
    function attachCold() {
      started = Date.now();
      clients.push(
        Bun.spawn([binary ?? "", "session", "attach", "restore-notice-test"], {
          env,
          terminal: { cols: 140, rows: 40, data() {} },
        }),
      );
    }
    async function stopSession() {
      await cli("session", "stop", "restore-notice-test");
      if (server) {
        await server.exited;
        server = undefined;
      }
      for (const client of clients) {
        if (client.exitCode === null) client.kill("SIGKILL");
        await client.exited;
        client.terminal?.close();
      }
      clients.length = 0;
    }
    try {
      await mkdir(join(dir, "bin"), { recursive: true });
      await Bun.write(
        join(dir, "bin", "pi"),
        `#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(marker)}\n"$HERDR_BIN_PATH" pane report-agent "$HERDR_PANE_ID" --source herdr:pi --agent pi --state idle --agent-session-id notice-test-session\nwhile :; do sleep 1; done\n`,
      );
      await chmod(join(dir, "bin", "pi"), 0o700);
      // Herdr parses its config, not the plugin. The optional input is copied;
      // nothing writes to the supplied real config or its running server.
      let configText = await Bun.file(
        process.env.HERDR_TEST_CONFIG ?? join(import.meta.dir, "fixtures/config.toml"),
      ).text();
      configText = configText.replace(/^# \[terminal\]$/m, "[terminal]");
      for (const [key, value] of Object.entries({
        default_shell: '"/bin/sh"',
        shell_mode: '"non_login"',
        onboarding: "false",
        version_check: "false",
        manifest_check: "false",
        resume_agents_on_restore: "false",
        pane_history: "true",
        pane_borders: "false",
        pane_outer_borders: "false",
      })) {
        const active = new RegExp(`^${key} = .*$`, "m");
        const commented = new RegExp(`^# ${key} = .*$`, "m");
        configText = configText.replace(active.test(configText) ? active : commented, `${key} = ${value}`);
      }
      await Bun.write(config, configText);
      const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "notice-test-session" };
      const snapshot = {
        version: 3,
        active: 0,
        selected: 0,
        workspaces: [
          {
            id: "w1",
            identity_cwd: dir,
            tabs: [
              {
                layout: { Pane: 0 },
                panes: { "0": { cwd: dir, agent_session: session } },
                zoomed: false,
                focused: 0,
                root_pane: 0,
              },
            ],
          },
        ],
      };
      await Bun.write(join(savedDir, "session.json"), JSON.stringify(snapshot));
      await Bun.write(
        join(savedDir, "session-history.json"),
        JSON.stringify({
          version: 3,
          workspaces: [{ tabs: [{ panes: { "0": { ansi: "PREVIOUS_SCREEN\r\n", lines: 1 } } }] }],
        }),
      );
      await cli("plugin", "link", plugin);
      startHeadless();
      let paneId = await waitForPane();
      await waitForHook();
      await cli("pane", "wait-output", paneId, "--match", "Ctrl-click Resume", "--timeout", "10000");
      const text = await cli("pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "100");
      expect(text).toContain("PREVIOUS_SCREEN");
      expect(text).toContain("[Resume]");
      expect(text).toContain("[Directory]");
      const ansi = await cli(
        "pane",
        "read",
        paneId,
        "--source",
        "recent",
        "--format",
        "ansi",
        "--lines",
        "100",
      );
      expect(ansi).toContain("\x1b[");
      expect(await Bun.file(marker).exists()).toBe(false);
      await cli("pane", "send-keys", paneId, "Enter");
      expect(await Bun.file(marker).exists()).toBe(false);
      // Read only selected launch fields; no ambient credentials enter evidence.
      const envCheck = `printf 'ENV_CHECK:%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\\n' "$HERDR_ENV" "$HERDR_WORKSPACE_ID" "$HERDR_TAB_ID" "$HERDR_PANE_ID" "$TERM" "$COLORTERM" "\${CODEX_THREAD_ID-unset}" "\${WT_SESSION-unset}" "$HERDR_SOCKET_PATH" "$HERDR_BIN_PATH" "$PWD"`;
      await cli("pane", "run", paneId, envCheck);
      await cli(
        "pane",
        "wait-output",
        paneId,
        "--match",
        `ENV_CHECK:1|w1|w1:t1|${paneId}|xterm-256color|truecolor|unset|unset|${socket}|${await realpath(binary)}|${dir}`,
        "--timeout",
        "5000",
      );
      const info = record(record(JSON.parse(await cli("pane", "get", paneId))).result);
      expect(record(info.pane).agent).toBeUndefined();
      expect(await Bun.file(marker).exists()).toBe(false);

      const stateName = `${new Bun.CryptoHasher("sha256").update(socket).digest("hex")}.json`;
      let statePath: string | undefined;
      for (let attempt = 0; attempt < 20; attempt++) {
        statePath = [...new Bun.Glob(`**/${stateName}`).scanSync({ cwd: dir, absolute: true })][0];
        if (statePath) break;
        await Bun.sleep(50);
      }
      if (!statePath) throw new Error("startup did not save delivery identity");
      const deliveryFile = Bun.file(statePath);
      const pluginStateDir = dirname(statePath);
      const runHook = async () => {
        const hook = Bun.spawn([join(plugin, "bin", "restore-notice")], {
          env: {
            ...env,
            HERDR_ENV: "1",
            HERDR_PLUGIN_EVENT: "startup",
            HERDR_BIN_PATH: binary,
            HERDR_CONFIG_PATH: "/no-config-file-may-be-read",
            HERDR_PLUGIN_CONFIG_DIR: join(dir, "notice-config"),
            HERDR_PLUGIN_STATE_DIR: pluginStateDir,
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        });
        const err = await Bun.readableStreamToText(hook.stderr);
        expect(await hook.exited, err).toBe(0);
      };
      await runHook();
      const repeated = await cli("pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "100");
      expect(repeated.match(/pi · paused/g)?.length).toBe(1);

      let previousDelivery = await deliveryFile.text();
      const firstToken: unknown = JSON.parse(previousDelivery)[0];
      if (typeof firstToken !== "string") throw new Error("missing first ticket");
      async function expectFreshNotice() {
        paneId = await waitForPane();
        await waitForHook();
        const delivery = await deliveryFile.text();
        expect(JSON.parse(delivery)).toHaveLength(1);
        expect(delivery).not.toBe(previousDelivery);
        previousDelivery = delivery;
        const output = await cli("pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "200");
        expect(output).toContain("[Resume]");
        expect(output).toContain("[Directory]");
        expect(await Bun.file(marker).exists()).toBe(false);
      }
      // Exact operator workflow: stop the named session, then cold-attach it.
      await stopSession();
      attachCold();
      await expectFreshNotice();

      // A crash must follow the same restore hook, not a graceful-stop event.
      await stopSession();
      startHeadless();
      await expectFreshNotice();
      if (!server) throw new Error("missing owned test server");
      server.kill("SIGKILL");
      await server.exited;
      server = undefined;
      attachCold();
      await expectFreshNotice();

      const currentToken: unknown = JSON.parse(previousDelivery)[0];
      if (typeof currentToken !== "string") throw new Error("missing current ticket");
      async function rejectedClick(token: string, target: string) {
        const action = Bun.spawn([join(plugin, "bin", "restore-notice"), "resume"], {
          env: {
            ...env,
            HERDR_ENV: "1",
            HERDR_BIN_PATH: binary,
            HERDR_PLUGIN_STATE_DIR: pluginStateDir,
            HERDR_PANE_ID: target,
            HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ invocation_source: "link_click" }),
            HERDR_PLUGIN_CLICKED_URL: `herdr-resume://${token}`,
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        });
        await Bun.readableStreamToText(action.stderr);
        expect(await action.exited).toBe(1);
      }
      await rejectedClick(firstToken, paneId);
      await rejectedClick(currentToken, "different-pane");
      expect(await Bun.file(marker).exists()).toBe(false);

      const layout = record(
        record(record(JSON.parse(await cli("pane", "layout", "--pane", paneId))).result).layout,
      );
      if (!Array.isArray(layout.panes)) throw new Error("missing layout panes");
      const rect = record(
        record(layout.panes.find((value: unknown) => record(value).pane_id === paneId)).rect,
      );
      if (typeof rect.x !== "number" || typeof rect.y !== "number") throw new Error("missing pane rectangle");
      const visible = (await cli("pane", "read", paneId, "--source", "visible")).split("\n");
      const row = visible.findLastIndex((line) => line.includes("[Resume]"));
      const col = visible[row]?.indexOf("[Resume]") ?? -1;
      if (row < 0 || col < 0) throw new Error("resume link is not visible");
      const terminal = clients.at(-1)?.terminal;
      if (!terminal) throw new Error("missing isolated attached client");
      const x = rect.x + col + 2;
      const y = rect.y + row + 1;
      // SGR mouse: left button with Control. This goes through Herdr's actual
      // OSC-link lookup and manifest handler, not direct action invocation.
      const click = `\x1b[<16;${x};${y}M\x1b[<16;${x};${y}m`;
      terminal.write(click + click);
      const clickDeadline = Date.now() + 35000;
      let succeeded = false;
      while (Date.now() < clickDeadline) {
        const logs = record(
          record(JSON.parse(await cli("plugin", "log", "list", "--plugin", "vsh.restore-notice"))).result,
        );
        if (Array.isArray(logs.logs))
          succeeded = logs.logs.map(record).some((log) => log.action_id != null && log.exit_code === 0);
        if (succeeded) break;
        await Bun.sleep(100);
      }
      expect(succeeded, await cli("plugin", "log", "list", "--plugin", "vsh.restore-notice")).toBe(true);
      expect(await Bun.file(marker).text()).toBe("--session\nnotice-test-session\n");
      const started = record(record(JSON.parse(await cli("agent", "list"))).result);
      if (!Array.isArray(started.agents)) throw new Error("agent list has no agents");
      const resumed = started.agents.map(record).find((agent) => agent.pane_id === paneId);
      expect(resumed?.agent).toBe("pi");
      expect(String(resumed?.name ?? "")).toMatch(/^resume-[a-f0-9]{16}$/);
      expect(resumed?.display_agent).toBe("pi");
      await rejectedClick(currentToken, paneId);
      await rm(marker);

      // Native deferred resume has an AgentInfo before any agent process exists.
      // Leave it headless so native launch is pending, then prove we do not print.
      await stopSession();
      await Bun.write(
        config,
        configText.replace("resume_agents_on_restore = false", "resume_agents_on_restore = true"),
      );
      startHeadless();
      paneId = await waitForPane();
      await waitForHook();
      const live = record(record(record(JSON.parse(await cli("api", "snapshot"))).result).snapshot);
      if (!Array.isArray(live.agents)) throw new Error("snapshot has no agents");
      // Native restore plans are agent occupants without a runtime yet. The
      // launch_pending flag describes managed agent starts, not every restore.
      expect(live.agents.map(record).some((agent) => agent.pane_id === paneId && agent.agent === "pi")).toBe(
        true,
      );
      await expect(cli("pane", "process-info", "--pane", paneId)).rejects.toThrow("pane_not_found");
      expect(await deliveryFile.json()).toEqual([]);
      expect(await Bun.file(marker).exists()).toBe(false);
    } catch (error) {
      console.error(error);
      console.error(await cli("plugin", "log", "list", "--plugin", "vsh.restore-notice").catch(String));
      console.error(await cli("pane", "list").catch(String));
      console.error(await cli("pane", "process-info", "--pane", "w1:p1").catch(String));
      console.error(await cli("pane", "read", "w1:p1", "--lines", "100").catch(String));
      throw error;
    } finally {
      try {
        await stopSession();
      } finally {
        if (server?.exitCode === null) {
          server.kill("SIGKILL");
          await server.exited;
        }
        for (const client of clients) {
          if (client.exitCode === null) client.kill("SIGKILL");
          await client.exited;
          client.terminal?.close();
        }
        await rm(dir, { recursive: true, force: true });
      }
    }
  },
  90000,
);
