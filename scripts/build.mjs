import { mkdir, copyFile, cp, rm } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const out = new URL('dist/', root);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const file of ['index.html', 'app.js', 'core.js', 'styles.css', '.nojekyll']) {
  await copyFile(new URL(file, root), new URL(file, out));
}
await cp(new URL('vendor/', root), new URL('vendor/', out), { recursive: true });
console.log('Static site built in dist/');
