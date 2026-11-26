import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');

async function build() {
  await fs.mkdir(distDir, { recursive: true });
  const css = await fs.readFile(path.join(__dirname, 'src', 'styles.css'), 'utf8');

  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'app.ts')],
    bundle: true,
    minify: true,
    charset: 'utf8',
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
  });

  const js = result.outputFiles[0].text;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pi Swarm</title>
  <style>${css}</style>
</head>
<body>
  <div id="app"></div>
  <script>${js}</script>
</body>
</html>
`;

  const outPath = path.join(distDir, 'settings.html');
  await fs.writeFile(outPath, html, 'utf8');
  console.log(`Built ${outPath} (${Buffer.byteLength(html, 'utf8')} bytes)`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
