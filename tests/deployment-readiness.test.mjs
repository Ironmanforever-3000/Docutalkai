import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readProjectFile(relativePath) {
  return readFile(path.join(projectRoot, relativePath), 'utf8');
}

test('local secret files are ignored while the template stays tracked', async () => {
  const ignoreRules = await readProjectFile('.gitignore');

  assert.match(ignoreRules, /^\.env/m);
});

test('Vercel configuration serves the single-page app and no API routes', async () => {
  const vercelConfig = JSON.parse(await readProjectFile('vercel.json'));

  assert.equal(vercelConfig.version, 3);
  assert.ok(!vercelConfig.routes.some((route) => route.dest === '/api/$1'));
  assert.ok(vercelConfig.routes.some((route) => route.dest === '/index.html'));
});

test('server-side calls use the deployment environment', async () => {
  const llmModule = await readProjectFile('supabase/functions/_shared/llm.ts');

  assert.match(llmModule, /OPENAI_API_KEY/);
  assert.match(llmModule, /GROQ_API_KEY/);
});

