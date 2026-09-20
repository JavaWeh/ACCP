import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parse } from "yaml";

// Compose resolves every overlay's relative bind source against the first file.
// Missing bind files otherwise become directories at deployment time.
const bundle = resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Candidate bundle directory is required");
const primary = resolve(bundle, "deploy/production/compose.yaml");
const directory = dirname(primary);
const required = new Set();
const inspect = (value) => {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "volumes" && Array.isArray(child)) {
      for (const volume of child) {
        const source =
          typeof volume === "string" ? volume.split(":")[0] : volume?.source;
        if (
          typeof source !== "string" ||
          source.includes("${") ||
          !source.startsWith(".")
        )
          continue;
        const path = resolve(directory, source);
        const local = relative(bundle, path);
        if (
          isAbsolute(local) ||
          local === ".." ||
          local.startsWith("../") ||
          local.startsWith("..\\")
        )
          throw new Error(`Bind source escapes candidate bundle: ${source}`);
        if (!statSync(path).isFile())
          throw new Error(`Packaged bind source must be a file: ${source}`);
        required.add(local);
      }
    }
    inspect(child);
  }
};
for (const file of [
  primary,
  resolve(bundle, "deploy/acceptance/compose.yaml"),
]) {
  inspect(parse(readFileSync(file, "utf8"), { merge: true }));
}
if (!required.size) throw new Error("No packaged Compose bind files found");
console.log(`Candidate bundle bind files verified: ${required.size}`);
