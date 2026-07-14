import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'sdks/javascript/src/index.ts',
    browser: 'sdks/javascript/src/runtime/browser/index.ts',
    'auto-click': 'sdks/javascript/src/extensions/instrumentations/dom-click.ts',
    node: 'sdks/javascript/src/runtime/node/index.ts',
    'receiver/http': 'receiver/hosts/http/index.ts',
    'receiver/vite': 'receiver/hosts/vite/index.ts',
  },
  format: ['esm'],
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  external: ['vite'],
});
