// Bundles an app entry into one ESM file; runtime images need no node_modules.
import { build } from 'esbuild';

const [entry, outfile] = process.argv.slice(2);
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
