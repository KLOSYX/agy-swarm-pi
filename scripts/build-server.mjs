import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '..');
const outFile = path.join(pluginRoot, 'bin', 'server.bundle.mjs');

async function buildServer() {
  await esbuild.build({
    entryPoints: [path.join(pluginRoot, 'src', 'server.mjs')],
    outfile: outFile,
    bundle: true,
    minify: true,
    platform: 'node',
    target: ['node20'],
    format: 'esm',
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
  const stat = await fs.stat(outFile);
  console.log(`Built ${outFile} (${stat.size} bytes)`);
}

buildServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
