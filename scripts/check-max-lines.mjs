import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_LINES = 1000;
const ROOTS = ['src', 'rust-backend/src'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.rs']);
const KNOWN_OVERSIZED_FILE_BASELINES = new Map([
  ['rust-backend/src/main.rs', 2630],
  ['src/App.tsx', 1534],
  ['src/backend/workerCore.ts', 1358],
  ['src/backend/tokenHolders.ts', 1347],
  ['src/backend/services/strategyStore.ts', 1289],
  ['src/backend/userStore.ts', 1137],
  ['src/backend/workerShared.ts', 1056],
]);

function parseMaxLines(argv) {
  const maxArg = argv.find((arg) => arg.startsWith('--max='));
  if (!maxArg) {
    return DEFAULT_MAX_LINES;
  }

  const parsed = Number.parseInt(maxArg.slice('--max='.length), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --max value: ${maxArg}`);
  }

  return parsed;
}

async function collectSourceFiles(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(fullPath));
      continue;
    }

    if (EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

async function countLines(filePath) {
  const content = await readFile(filePath, 'utf8');
  if (content.length === 0) {
    return 0;
  }
  return content.split(/\r?\n/).length;
}

async function main() {
  const maxLines = parseMaxLines(process.argv.slice(2));
  const files = [];

  for (const root of ROOTS) {
    files.push(...await collectSourceFiles(root));
  }

  const counts = await Promise.all(
    files.map(async (filePath) => ({
      filePath,
      lineCount: await countLines(filePath),
    })),
  );

  const violations = counts
    .filter((entry) => {
      if (entry.lineCount <= maxLines) {
        return false;
      }
      const baseline = KNOWN_OVERSIZED_FILE_BASELINES.get(entry.filePath);
      return baseline == null || entry.lineCount > baseline;
    })
    .sort((left, right) => right.lineCount - left.lineCount);

  if (violations.length === 0) {
    console.log(`All checked source files are at or under ${maxLines} lines, or within the recorded oversized-file baseline.`);
    return;
  }

  console.error(`Found ${violations.length} source file(s) exceeding the ${maxLines}-line limit or their recorded oversized-file baseline:`);
  for (const violation of violations) {
    console.error(`- ${violation.filePath}: ${violation.lineCount}`);
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});