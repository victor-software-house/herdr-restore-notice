import { mkdir } from "node:fs/promises";
import { $ } from "bun";

const platform = `${process.platform}-${process.arch}`;
if (!["darwin-arm64", "linux-x64"].includes(platform)) throw new Error("unsupported release platform");
await mkdir("dist", { recursive: true });
const asset = `restore-notice-${platform}.tar.gz`;
await $`tar -czf ${`dist/${asset}`} -C bin restore-notice`;
const hash = new Bun.CryptoHasher("sha256")
  .update(await Bun.file(`dist/${asset}`).arrayBuffer())
  .digest("hex");
await Bun.write(`dist/${asset}.sha256`, `${hash}  ${asset}\n`);
