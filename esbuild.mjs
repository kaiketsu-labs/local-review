import { build } from 'esbuild';

await build({
  entryPoints: { extension: 'src/extension.ts', channel: 'src/channel.ts', 'hook-waiter': 'src/hookWaiter.ts', 'live-connect': 'src/liveConnect.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info'
});
