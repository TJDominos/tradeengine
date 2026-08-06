import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_LINES = 1000;
const ROOTS = ['src', 'rust-backend/src'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.rs']);

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
    .filter((entry) => entry.lineCount > maxLines)
    .sort((left, right) => right.lineCount - left.lineCount);

  if (violations.length === 0) {
    console.log(`All checked source files are at or under ${maxLines} lines.`);
    return;
  }

  console.error(`Found ${violations.length} source file(s) over ${maxLines} lines:`);
  for (const violation of violations) {
    console.error(`- ${violation.filePath}: ${violation.lineCount}`);
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});