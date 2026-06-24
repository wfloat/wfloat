import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(packageDir, "test-apps", "consumer");
const tmpDir = mkdtempSync(path.join(tmpdir(), "react-native-wfloat-consumer-"));

function parseArgs(argv) {
  const parsed = {
    buildAndroid: false,
    buildIos: false,
    tarball: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--android") {
      parsed.buildAndroid = true;
      continue;
    }
    if (arg === "--ios") {
      parsed.buildIos = true;
      continue;
    }
    if (arg === "--tarball") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--tarball requires a path.");
      }
      parsed.tarball = path.resolve(process.cwd(), value);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const buildAndroid = args.buildAndroid;
const buildIos = args.buildIos;

if (!buildAndroid && !buildIos) {
  throw new Error("Pass --android, --ios, or both.");
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? packageDir,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "inherit"],
    env: {
      ...process.env,
      ...options.env,
    },
  });
}

function copyFixture(consumerDir) {
  cpSync(fixtureDir, consumerDir, {
    recursive: true,
    filter(source) {
      const relative = path.relative(fixtureDir, source);
      if (!relative) {
        return true;
      }

      const parts = relative.split(path.sep);
      return ![
        "node_modules",
        "Pods",
        ".gradle",
        ".cxx",
        "build",
        "DerivedData",
      ].some((excluded) => parts.includes(excluded));
    },
  });
}

function patchPackageJson(consumerDir, tarball) {
  const packageJsonPath = path.join(consumerDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  packageJson.dependencies = {
    ...packageJson.dependencies,
    "@wfloat/react-native-wfloat": `file:${tarball}`,
  };
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");
}

function installConsumerDependencies(consumerDir) {
  run("npm", ["install", "--legacy-peer-deps", "--no-audit", "--no-fund"], {
    cwd: consumerDir,
    stdio: "inherit",
  });
}

function packPackageTarball() {
  const packOutput = run("npm", [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    tmpDir,
  ]);
  const pack = JSON.parse(packOutput)[0];
  return path.join(tmpDir, pack.filename);
}

function buildAndroidConsumer(consumerDir) {
  const gradlew = path.join(consumerDir, "android", "gradlew");
  chmodSync(gradlew, 0o755);
  run(
    "./gradlew",
    [
      ":app:assembleDebug",
      "--no-daemon",
      "--console=plain",
      "-PreactNativeArchitectures=arm64-v8a",
    ],
    {
      cwd: path.join(consumerDir, "android"),
      stdio: "inherit",
    },
  );
}

function buildIosConsumer(consumerDir) {
  const iosDir = path.join(consumerDir, "ios");
  if (!existsSync(path.join(iosDir, "Podfile"))) {
    throw new Error("The copied consumer is missing ios/Podfile.");
  }

  run("pod", ["install"], { cwd: iosDir, stdio: "inherit" });

  run("npm", ["run", "build:ios"], {
    cwd: consumerDir,
    stdio: "inherit",
    env: {
      RCT_NEW_ARCH_ENABLED: "1",
    },
  });
}

try {
  const tarball = args.tarball ?? packPackageTarball();
  if (!existsSync(tarball)) {
    throw new Error(`Package tarball does not exist: ${tarball}`);
  }

  const consumerDir = path.join(tmpDir, "consumer");

  mkdirSync(consumerDir, { recursive: true });
  copyFixture(consumerDir);
  patchPackageJson(consumerDir, tarball);
  installConsumerDependencies(consumerDir);

  if (buildAndroid) {
    buildAndroidConsumer(consumerDir);
  }

  if (buildIos) {
    buildIosConsumer(consumerDir);
  }
} finally {
  if (!process.env.WFLOAT_KEEP_CONSUMER_SMOKE_TMP) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
