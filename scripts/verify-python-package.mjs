import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pythonDir = join(repoDir, "sdks", "python");
const rootPackage = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
const pyproject = readFileSync(join(pythonDir, "pyproject.toml"), "utf8");
const pythonInit = readFileSync(join(pythonDir, "src", "tracelink", "__init__.py"), "utf8");
const pythonTypes = readFileSync(join(pythonDir, "src", "tracelink", "engine", "types.py"), "utf8");
const protocolVersionSource = readFileSync(join(repoDir, "protocol", "version.ts"), "utf8");

const pyprojectVersion = pyproject.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const pythonVersion = pythonInit.match(/^__version__\s*=\s*"([^"]+)"/m)?.[1];
const versions = [rootPackage.version, pyprojectVersion, pythonVersion];

if (versions.some((version) => !version) || new Set(versions).size !== 1) {
  throw new Error(`TraceLink version mismatch: npm=${versions[0]}, pyproject=${versions[1]}, python=${versions[2]}`);
}
const javascriptProtocolVersion = protocolVersionSource.match(/TRACE_PROTOCOL_VERSION\s*=\s*['\"]([^'\"]+)['\"]/)?.[1];
const pythonProtocolVersion = pythonTypes.match(/TRACE_PROTOCOL_VERSION\s*=\s*"([^"]+)"/)?.[1];
if (!javascriptProtocolVersion || javascriptProtocolVersion !== pythonProtocolVersion) {
  throw new Error(
    `TraceLink protocol version mismatch: javascript=${javascriptProtocolVersion}, python=${pythonProtocolVersion}`,
  );
}
if (!existsSync(join(pythonDir, "src", "tracelink", "py.typed"))) {
  throw new Error("Python package is missing the PEP 561 marker: tracelink/py.typed");
}

function runPython(args, options = {}) {
  const command = process.env.PYTHON || "python";
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoDir,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), "tracelink-python-package-"));
const sourceDir = join(tempRoot, "source");
const wheelDir = join(tempRoot, "wheel");
const installDir = join(tempRoot, "installed");

try {
  cpSync(pythonDir, sourceDir, {
    recursive: true,
    filter(source) {
      return !["__pycache__", ".pytest_cache", "build", "dist"].includes(basename(source))
        && !source.endsWith(".egg-info");
    },
  });
  mkdirSync(wheelDir);

  console.log("[verify:python] build wheel from isolated source copy");
  runPython([
    "-m", "pip", "wheel", sourceDir,
    "--no-deps", "--wheel-dir", wheelDir,
  ]);

  const wheel = readdirSync(wheelDir).find((file) => file.endsWith(".whl"));
  if (!wheel) throw new Error("Python wheel build produced no .whl file");

  console.log("[verify:python] install and import wheel");
  runPython([
    "-m", "pip", "install", join(wheelDir, wheel),
    "--no-deps", "--no-compile", "--target", installDir,
  ]);

  if (!existsSync(join(installDir, "tracelink", "py.typed"))) {
    throw new Error("Built wheel does not contain tracelink/py.typed");
  }

  runPython(
    [
      "-c",
      `import tracelink; assert tracelink.__version__ == ${JSON.stringify(rootPackage.version)}; assert tracelink.TRACE_PROTOCOL_VERSION == ${JSON.stringify(javascriptProtocolVersion)}; print('TraceLink Python wheel OK', tracelink.__version__, 'protocol', tracelink.TRACE_PROTOCOL_VERSION)`,
    ],
    {
      env: { ...process.env, PYTHONPATH: installDir },
      stdio: "inherit",
    },
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
