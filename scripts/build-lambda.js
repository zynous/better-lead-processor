#!/usr/bin/env node
/**
 * Bundle Lambda with esbuild so all dependencies (e.g. zod) are included.
 * Output: dist/index.js (single file, handler remains index.handler)
 */
const esbuild = require('esbuild');
const path = require('path');

const root = path.resolve(__dirname, '..');

esbuild
  .build({
    entryPoints: [path.join(root, 'src/index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    outfile: path.join(root, 'dist/index.js'),
    sourcemap: true,
    minify: false,
    external: [
      // Optional: keep AWS SDK out of bundle to use Lambda runtime (smaller bundle)
      // Uncomment if your Lambda runtime provides them:
      // '@aws-sdk/client-lambda',
      // '@aws-sdk/client-secrets-manager',
      // '@aws-sdk/client-ses',
    ],
  })
  .then(() => console.log('Lambda bundle: dist/index.js'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
