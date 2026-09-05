import pkg from "../package.json";

const file = Bun.file("herdr-plugin.toml");
const source = await file.text();
const pattern = /^version = "[^"]*"$/m;
if (!pattern.test(source)) throw new Error("manifest version field is missing");
const updated = source.replace(pattern, `version = "${pkg.version}"`);
if (process.argv.includes("--check")) {
  if (source !== updated) throw new Error("manifest version differs from package.json");
} else {
  await Bun.write(file, updated);
}
