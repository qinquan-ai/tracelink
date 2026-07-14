#!/usr/bin/env node
/**
 * embed-dashboard —— 把 debug_board 的单文件构建产物塞进本包。
 *
 * 为什么这样做：debug_board 是独立仓库，不适合做跨仓库构建依赖。所以这里只做
 * 一件事——把已经构建好的 `debug_board/dist/index.html`（`npm run build:single`
 * 的产物，内联了全部 JS/CSS）复制到本仓库根目录的 `dashboard/index.html`，
 * 让该资源随包一起发布（见 package.json 的 `files`）。
 *
 * 重新生成流程（dashboard 改动后）：
 *   1) cd ../debug_board && npm run build:single   # 产出单文件 dist/index.html
 *   2) 回到 Trace_Link 根目录 && node scripts/embed-dashboard.mjs
 *
 * 也可 `npm run embed:dashboard`（见 package.json scripts）。
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, '..');

// debug_board 与 Trace_Link 同为 debug_project 下的兄弟目录。
// packageRoot 现在就是 Trace_Link 仓库根目录，故上跳一级即到 debug_project。
const source = path.resolve(packageRoot, '../debug_board/dist/index.html');
const destDir = path.join(packageRoot, 'dashboard');
const dest = path.join(destDir, 'index.html');

if (!existsSync(source)) {
  console.error(
    `[embed-dashboard] 找不到源文件: ${source}\n` +
      `请先在 debug_board 里运行 \`npm run build:single\` 生成单文件产物。`,
  );
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(source, dest);

const kb = (statSync(dest).size / 1024).toFixed(2);
console.log(`[embed-dashboard] 已复制 dashboard 单文件 -> ${dest} (${kb} kB)`);
