import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(packageDir, "test-apps", "consumer");
const tmpDir = mkdtempSync(path.join(tmpdir(), "wfloat-web-browser-smoke-"));

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? packageDir,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "inherit"],
  });
}

try {
  const packOutput = run("npm", ["pack", "--json", "--pack-destination", tmpDir]);
  const pack = JSON.parse(packOutput)[0];
  const tarball = path.join(tmpDir, pack.filename);
  const consumerDir = path.join(tmpDir, "consumer");

  mkdirSync(consumerDir, { recursive: true });
  cpSync(fixtureDir, consumerDir, {
    recursive: true,
    filter(source) {
      const relative = path.relative(fixtureDir, source);
      if (!relative) {
        return true;
      }

      const parts = relative.split(path.sep);
      return !["node_modules", "dist"].some((excluded) => parts.includes(excluded));
    },
  });

  const packageJsonPath = path.join(consumerDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  packageJson.dependencies = {
    ...packageJson.dependencies,
    "@wfloat/wfloat-web": `file:${tarball}`,
  };
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");

  run("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: consumerDir,
    stdio: "inherit",
  });
  run("npm", ["run", "build"], { cwd: consumerDir, stdio: "inherit" });
} finally {
  if (!process.env.WFLOAT_KEEP_PACKAGE_SMOKE_TMP) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
