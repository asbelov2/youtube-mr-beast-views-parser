import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist/public', { recursive: true });
await build({
  entryPoints: { app: 'src/web/app.ts', offline: 'src/web/offline.ts' }, outdir: 'dist/public',
  bundle: true, minify: true, sourcemap: true, platform: 'browser', target: 'es2022',
});
for (const name of ['index.html', 'style.css', 'favicon.svg']) {
  await copyFile(`src/web/${name}`, `dist/public/${name}`);
}
