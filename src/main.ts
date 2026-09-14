import { listRetained, released, resume, startup } from "./runtime.ts";

try {
  const command = process.argv[2];
  const event = process.env.HERDR_PLUGIN_EVENT;
  if (command === "resume") await resume();
  else if (command === "list") await listRetained();
  else if (event === "pane.agent_detected") await released();
  else await startup();
} catch (error) {
  console.error(`restore-notice: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
