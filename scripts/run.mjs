import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const appEnv = process.env.APP_ENV || 'development';
const cmd = process.argv[2];
const args = process.argv.slice(3);

if (!cmd || !['migrate', 'seed', 'set-password'].includes(cmd)) {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/run.mjs <migrate|seed|set-password> [args...]');
  process.exit(2);
}

function hasSrcTree() {
  try {
    return fs.existsSync(path.join(projectRoot, 'src'));
  } catch {
    return false;
  }
}

async function runDist() {
  const target = path.join(projectRoot, 'dist', 'scripts', `${cmd.replace(/-/g, '_')}.js`);
  await import(pathToFileURL(target).href);
}

function runTs() {
  const scriptMap = {
    migrate: 'migrate.ts',
    seed: 'seed.ts',
    'set-password': 'set_password.ts'
  };
  const target = path.join(projectRoot, 'scripts', scriptMap[cmd]);
  const child = spawn(process.execPath, ['--import', 'tsx', target, ...args], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 1));
}

// In production images we only have `dist/`, so run compiled JS.
// In dev/test, prefer TS sources if present (no build step needed).
if ((appEnv === 'development' || appEnv === 'test') && hasSrcTree()) {
  runTs();
} else {
  await runDist();
}

