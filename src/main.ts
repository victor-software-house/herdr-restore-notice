import { resume, startup } from "./runtime.ts";

try {
  if (process.argv[2] === "resume") await resume();
  else await startup();
} catch (error) {
  console.error(`restore-notice: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
