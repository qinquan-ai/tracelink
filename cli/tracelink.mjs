#!/usr/bin/env node
/**
 * tracelink CLI —— 一条命令起 receiver、托管看板、打开浏览器。
 *
 *   tracelink dashboard [--port <n>] [--host <h>] [--no-open] [--force]
 *
 * `dashboard` 子命令：调用 startReceiverServer 起一个本地 receiver（同时提供
 * `/__debug_log/ui` 看板），打印看板 URL，并（默认）用系统命令打开浏览器。
 * 不引入任何运行时依赖：打开浏览器用各平台自带命令，尽力而为、失败不报错。
 */
import { spawn } from 'node:child_process';
import { startReceiverServer } from '../dist/receiver/http.js';

const DEFAULT_PORT = 5174;
const DEFAULT_HOST = '127.0.0.1';

function printUsage() {
  console.log(
    [
      'tracelink — local tracing toolkit',
      '',
      'Usage:',
      '  tracelink dashboard [options]    Start a receiver + serve the dashboard',
      '',
      'Options for `dashboard`:',
      `  --port <n>    Port to listen on (default: ${DEFAULT_PORT})`,
      `  --host <h>    Host to bind to (default: ${DEFAULT_HOST})`,
      '  --no-open     Do not open the browser automatically',
      '  --force       If a TraceLink receiver holds the port, restart it',
      '  -h, --help    Show this help',
    ].join('\n'),
  );
}

/** Tiny flag parser — enough for `dashboard`, no dependency needed. */
function parseDashboardArgs(argv) {
  const opts = { port: DEFAULT_PORT, host: DEFAULT_HOST, open: true, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--port': {
        const n = Number(argv[++i]);
        if (!Number.isFinite(n)) {
          console.error(`[tracelink] --port expects a number, got: ${argv[i]}`);
          process.exit(1);
        }
        opts.port = n;
        break;
      }
      case '--host':
        opts.host = argv[++i];
        break;
      case '--no-open':
        opts.open = false;
        break;
      case '--force':
        opts.force = true;
        break;
      case '-h':
      case '--help':
        printUsage();
        process.exit(0);
        break;
      default:
        console.error(`[tracelink] Unknown option: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }
  return opts;
}

/** Cross-platform, best-effort "open this URL in the default browser". */
function openBrowser(url) {
  try {
    let command;
    let args;
    switch (process.platform) {
      case 'win32':
        // `start` is a cmd builtin; the empty "" is the (ignored) window title.
        command = 'cmd';
        args = ['/c', 'start', '', url];
        break;
      case 'darwin':
        command = 'open';
        args = [url];
        break;
      default:
        command = 'xdg-open';
        args = [url];
        break;
    }
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* swallow — opening the browser is a convenience, not a requirement */
    });
    child.unref();
  } catch {
    // never let a failed browser launch take down the server
  }
}

function runDashboard(argv) {
  const opts = parseDashboardArgs(argv);
  const url = `http://${opts.host}:${opts.port}/__debug_log/ui`;

  startReceiverServer({ port: opts.port, host: opts.host, force: opts.force });

  console.log(`[tracelink] Dashboard: ${url}`);
  console.log('[tracelink] Press Ctrl-C to stop.');

  if (opts.open) openBrowser(url);

  // startReceiverServer already wires SIGINT/SIGTERM to close the server; add a
  // handler so the process exits cleanly once the server has shut down.
  process.on('SIGINT', () => {
    console.log('\n[tracelink] Shutting down…');
  });
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'dashboard':
      runDashboard(rest);
      break;
    case undefined:
    case '-h':
    case '--help':
      printUsage();
      break;
    default:
      console.error(`[tracelink] Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main();
