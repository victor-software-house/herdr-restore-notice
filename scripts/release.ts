import { $ } from "bun";
import pkg from "../package.json";

// Run only in the publish workflow after both native artifact jobs succeed.
const sha = process.env.GITHUB_SHA;
if (!sha || process.env.GITHUB_ACTIONS !== "true") throw new Error("release runs only in GitHub Actions");
if ((await $`git rev-parse HEAD`.text()).trim() !== sha)
  throw new Error("checkout does not match release SHA");
const subject = (await $`git log -1 --format=%s`.text()).trim();
const bootstrap = pkg.version === "0.0.0";
if (!bootstrap && !subject.startsWith("chore(release): version packages"))
  throw new Error("not a version release commit");
const assets: string[] = [];
for (const platform of ["darwin-arm64", "linux-x64"]) {
  const name = `restore-notice-${platform}.tar.gz`;
  const path = `dist/${name}`;
  const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
  if ((await Bun.file(`${path}.sha256`).text()) !== `${hash}  ${name}\n`)
    throw new Error(`checksum mismatch: ${name}`);
  assets.push(path, `${path}.sha256`);
}
const tag = `v${pkg.version}`;
const remote = (await $`git ls-remote origin ${`refs/tags/${tag}`} ${`refs/tags/${tag}^{}`}`.text()).trim();
if (remote) {
  if (!remote.split("\n").some((line) => line === `${sha}\trefs/tags/${tag}^{}`))
    throw new Error("release tag points elsewhere");
} else {
  await $`git -c user.name=github-actions[bot] -c user.email=41898282+github-actions[bot]@users.noreply.github.com tag -a ${tag} ${sha} -m ${tag}`;
  await $`git push origin ${`refs/tags/${tag}`}`;
}
const verified = (await $`git ls-remote origin ${`refs/tags/${tag}^{}`}`.text()).trim();
if (verified !== `${sha}\trefs/tags/${tag}^{}`) throw new Error("remote release tag verification failed");
const existing = await $`gh release view ${tag}`.quiet().nothrow();
if (existing.exitCode === 0) throw new Error("release already exists; inspect assets before retrying");
await $`gh release create ${tag} ${assets} --verify-tag --title ${tag} --notes ${"Compact restore notices with click-to-resume native agent sessions. See README for installation and safety."}`;
