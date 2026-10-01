import { build } from 'esbuild';

await build({
  entryPoints: ['js/native-push-entry.js'],
  outfile: 'js/native-push.bundle.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['es2020'],
  minify: true,
  sourcemap: false
});
