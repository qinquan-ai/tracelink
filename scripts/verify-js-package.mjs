import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, cwd = repoDir) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 1}`);
  }
}

function verifyBuiltEntries(packageDir, label) {
  const rootUrl = pathToFileURL(join(packageDir, 'dist', 'index.js')).href;
  const nodeUrl = pathToFileURL(join(packageDir, 'dist', 'node.js')).href;
  const code = `
    const root = await import(${JSON.stringify(rootUrl)});
    const node = await import(${JSON.stringify(nodeUrl)});
    if (root.tracer !== node.tracer) {
      throw new Error('root and node entries expose different tracer singletons');
    }
    root.tracer.configure({ consoleExporter: () => {} });
    root.tracer.clearMemory();
    root.scopeController.enableAll();

    let releaseA;
    let releaseB;
    const gateA = new Promise((resolve) => { releaseA = resolve; });
    const gateB = new Promise((resolve) => { releaseB = resolve; });
    const first = root.tracer.span(
      { layer: 'BE-ENTRY', fn: 'verify:a', msg: 'open-a', scope: 'verify-a' },
      async () => {
        await gateA;
        root.tracer.log({ layer: 'BE-INTERNAL', fn: 'verify:a-child', msg: 'child-a' });
      },
    );
    const second = root.tracer.span(
      { layer: 'BE-ENTRY', fn: 'verify:b', msg: 'open-b', scope: 'verify-b' },
      async () => {
        await gateB;
        root.tracer.log({ layer: 'BE-INTERNAL', fn: 'verify:b-child', msg: 'child-b' });
      },
    );
    releaseA();
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseB();
    await Promise.all([first, second]);

    const logs = root.tracer.allLogs();
    const openA = logs.find((log) => log.msg === 'open-a');
    const openB = logs.find((log) => log.msg === 'open-b');
    const childA = logs.find((log) => log.msg === 'child-a');
    const childB = logs.find((log) => log.msg === 'child-b');
    if (!openA || !openB || !childA || !childB) throw new Error('verification logs missing');
    if (childA.parentSpanId !== openA.spanId || childB.parentSpanId !== openB.spanId) {
      throw new Error('built entries do not share the async context provider');
    }
    console.log(${JSON.stringify(`[verify:javascript] ${label} entries share tracer and async context`)});
  `;
  run(process.execPath, ['--input-type=module', '--eval', code]);
}

verifyBuiltEntries(repoDir, 'dist');

const tempRoot = mkdtempSync(join(tmpdir(), 'tracelink-js-package-'));
const unpacked = join(tempRoot, 'package');
try {
  const npmCli = process.env.npm_execpath
    ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli)) throw new Error(`Cannot locate npm CLI at ${npmCli}`);
  run(process.execPath, [
    npmCli,
    'pack',
    '--ignore-scripts',
    '--pack-destination',
    tempRoot,
  ]);
  const tarball = readdirSync(tempRoot).find((file) => file.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');

  mkdirSync(unpacked);
  const tarCommand = process.platform === 'win32' ? 'tar.exe' : 'tar';
  run(tarCommand, [
    '-xzf',
    join(tempRoot, tarball),
    '-C',
    unpacked,
    '--strip-components=1',
  ]);

  for (const required of [
    'cli/tracelink.mjs',
    'dashboard/index.html',
    'protocol/CONFORMANCE.md',
    'protocol/schema/trace-log.schema.json',
  ]) {
    if (!existsSync(join(unpacked, required))) {
      throw new Error(`npm tarball is missing ${required}`);
    }
  }
  verifyBuiltEntries(unpacked, 'tarball');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
