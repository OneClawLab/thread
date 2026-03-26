import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // LIB entry: no shebang, generate type declarations
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node22',
    clean: true,
    sourcemap: true,
    dts: true,
    external: ['canvas', 'jsdom'],
  },
  {
    // CLI entry: with shebang, no type declarations
    entry: ['src/cli.ts'],
    format: ['esm'],
    target: 'node22',
    sourcemap: true,
    dts: false,
    banner: { js: '#!/usr/bin/env node' },
    external: ['canvas', 'jsdom'],
  },
]);
