import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const REQUIRED_FILES = ['prisma/schema.prisma'];
const REQUIRED_DIRS = ['src/core', 'src/infrastructure'];
const SCAN_ROOTS = ['src', 'prisma', 'app', 'extensions'];
const REQUIRED_SCAN_ROOTS = new Set(['src', 'prisma']);
const IGNORED_DIR_NAMES = new Set(['node_modules', '.next', 'dist', '.git']);

const SUPPORTED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.sql',
  '.prisma',
  '.json',
]);

const AST_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

const MARKER_RULES = [
  {
    rule: 'STUB_NOT_WIRED',
    pattern: /\bnot wired\b/i,
  },
  {
    rule: 'STUB_TODO_COMPOSE',
    pattern: /\bTODO\b[^\r\n]*\bcompose\b/i,
  },
  {
    rule: 'STUB_FIXME_COMPOSE',
    pattern: /\bFIXME\b[^\r\n]*\bcompose\b/i,
  },
  {
    rule: 'STUB_NOT_IMPLEMENTED',
    pattern: /throw\s+new\s+Error\s*\(\s*(['"`])Not implemented\1\s*\)/,
  },
];

function getScriptKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function toPosixRelative(rootDir, targetPath) {
  return path.relative(rootDir, targetPath).split(path.sep).join('/');
}

function getLineNumberFromIndex(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function getPropertyAccessName(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return node.argumentExpression.text;
  }
  return null;
}

function unwrapChainExpression(node) {
  let current = node;
  while (current && ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function isAuthGetSessionNode(node) {
  const memberName = getPropertyAccessName(node);
  if (memberName !== 'getSession') {
    return false;
  }
  const target = unwrapChainExpression(node.expression);
  if (ts.isIdentifier(target) && target.text === 'auth') {
    return true;
  }
  return getPropertyAccessName(target) === 'auth';
}

function isExecuteRawTarget(node) {
  const expr = unwrapChainExpression(node);
  if (ts.isIdentifier(expr) && expr.text === '$executeRaw') {
    return true;
  }
  return getPropertyAccessName(expr) === '$executeRaw';
}

function scanTypeScriptAst(relPath, content, violations) {
  const sourceFile = ts.createSourceFile(
    relPath,
    content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(relPath),
  );

  function visit(node) {
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const name = getPropertyAccessName(node);
      if (name === '$queryRawUnsafe') {
        const pos = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        violations.push({
          file: relPath,
          line: pos.line + 1,
          rule: 'BANNED_QUERY_RAW_UNSAFE',
        });
      } else if (name === '$executeRawUnsafe') {
        const pos = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        violations.push({
          file: relPath,
          line: pos.line + 1,
          rule: 'BANNED_EXECUTE_RAW_UNSAFE',
        });
      } else if (isAuthGetSessionNode(node)) {
        const pos = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        violations.push({
          file: relPath,
          line: pos.line + 1,
          rule: 'BANNED_AUTH_GET_SESSION',
        });
      }
    }

    if (
      ts.isTaggedTemplateExpression(node) &&
      isExecuteRawTarget(node.tag)
    ) {
      const templateText = node.template.getText(sourceFile);
      if (/\bset_config\b/i.test(templateText)) {
        const pos = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        violations.push({
          file: relPath,
          line: pos.line + 1,
          rule: 'BANNED_EXECUTE_RAW_SET_CONFIG',
        });
      }
    }

    if (ts.isCallExpression(node) && isExecuteRawTarget(node.expression)) {
      const argsText = node.arguments
        .map((arg) => arg.getText(sourceFile))
        .join(' ');
      if (/\bset_config\b/i.test(argsText)) {
        const pos = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        violations.push({
          file: relPath,
          line: pos.line + 1,
          rule: 'BANNED_EXECUTE_RAW_SET_CONFIG',
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function scanTextMarkers(relPath, content, violations) {
  for (const { rule, pattern } of MARKER_RULES) {
    const flags = pattern.flags.includes('g')
      ? pattern.flags
      : `${pattern.flags}g`;
    const globalRegex = new RegExp(pattern.source, flags);
    for (const match of content.matchAll(globalRegex)) {
      const line = getLineNumberFromIndex(content, match.index ?? 0);
      violations.push({ file: relPath, line, rule });
    }
  }
}

export async function verifyNoStubs(options = {}) {
  const defaultRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const rootDir = path.resolve(options.rootDir ?? defaultRoot);
  const fsOps = options.fsOps ?? fs;

  const violations = [];
  let checkedFiles = 0;

  async function safeLstat(targetPath, relPath) {
    try {
      return await fsOps.lstat(targetPath);
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err ? err.code : 'ERR';
      violations.push({
        file: relPath,
        line: 0,
        rule:
          code === 'ENOENT' ? 'MISSING_REQUIRED_PATH' : 'UNREADABLE_PATH_STAT',
      });
      return null;
    }
  }

  for (const relFile of REQUIRED_FILES) {
    const absPath = path.join(rootDir, relFile);
    const stats = await safeLstat(absPath, relFile);
    if (!stats) {
      continue;
    }
    if (stats.isSymbolicLink()) {
      violations.push({ file: relFile, line: 0, rule: 'UNSAFE_SYMLINK' });
      continue;
    }
    if (!stats.isFile()) {
      violations.push({
        file: relFile,
        line: 0,
        rule: 'EXPECTED_REGULAR_FILE',
      });
      continue;
    }
    try {
      await fsOps.readFile(absPath, 'utf8');
    } catch {
      violations.push({ file: relFile, line: 0, rule: 'UNREADABLE_FILE' });
    }
  }

  for (const relDir of REQUIRED_DIRS) {
    const absPath = path.join(rootDir, relDir);
    const stats = await safeLstat(absPath, relDir);
    if (!stats) {
      continue;
    }
    if (stats.isSymbolicLink()) {
      violations.push({ file: relDir, line: 0, rule: 'UNSAFE_SYMLINK' });
      continue;
    }
    if (!stats.isDirectory()) {
      violations.push({
        file: relDir,
        line: 0,
        rule: 'EXPECTED_DIRECTORY',
      });
      continue;
    }
    try {
      await fsOps.readdir(absPath);
    } catch {
      violations.push({
        file: relDir,
        line: 0,
        rule: 'UNREADABLE_DIRECTORY',
      });
    }
  }

  async function inspectFile(absPath, relPath) {
    const ext = path.extname(absPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return;
    }

    let content;
    try {
      content = await fsOps.readFile(absPath, 'utf8');
    } catch {
      violations.push({ file: relPath, line: 0, rule: 'UNREADABLE_FILE' });
      return;
    }

    checkedFiles += 1;

    if (ext === '.json') {
      try {
        JSON.parse(content);
      } catch {
        violations.push({ file: relPath, line: 1, rule: 'MALFORMED_JSON' });
      }
    }

    scanTextMarkers(relPath, content, violations);

    if (AST_EXTENSIONS.has(ext)) {
      scanTypeScriptAst(relPath, content, violations);
    }
  }

  async function walkDirectory(dirPath) {
    const relDir = toPosixRelative(rootDir, dirPath) || '.';
    let entries;
    try {
      entries = await fsOps.readdir(dirPath);
    } catch {
      violations.push({
        file: relDir,
        line: 0,
        rule: 'UNREADABLE_DIRECTORY',
      });
      return;
    }

    const sortedEntries = [...entries].sort((a, b) => a.localeCompare(b));
    for (const entryName of sortedEntries) {
      if (IGNORED_DIR_NAMES.has(entryName)) {
        continue;
      }
      const childAbs = path.join(dirPath, entryName);
      const childRel = toPosixRelative(rootDir, childAbs);
      let stats;
      try {
        stats = await fsOps.lstat(childAbs);
      } catch {
        violations.push({
          file: childRel,
          line: 0,
          rule: 'UNREADABLE_PATH_STAT',
        });
        continue;
      }

      if (stats.isSymbolicLink()) {
        violations.push({
          file: childRel,
          line: 0,
          rule: 'UNSAFE_SYMLINK',
        });
        continue;
      }

      if (stats.isDirectory()) {
        await walkDirectory(childAbs);
      } else if (stats.isFile()) {
        await inspectFile(childAbs, childRel);
      } else {
        violations.push({
          file: childRel,
          line: 0,
          rule: 'UNSUPPORTED_FILE_TYPE',
        });
      }
    }
  }

  for (const rootName of SCAN_ROOTS) {
    const rootAbs = path.join(rootDir, rootName);
    let stats;
    try {
      stats = await fsOps.lstat(rootAbs);
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err ? err.code : 'ERR';
      if (code === 'ENOENT' && !REQUIRED_SCAN_ROOTS.has(rootName)) {
        continue;
      }
      violations.push({
        file: rootName,
        line: 0,
        rule:
          code === 'ENOENT' ? 'MISSING_REQUIRED_PATH' : 'UNREADABLE_PATH_STAT',
      });
      continue;
    }

    if (stats.isSymbolicLink()) {
      violations.push({ file: rootName, line: 0, rule: 'UNSAFE_SYMLINK' });
      continue;
    }

    if (!stats.isDirectory()) {
      violations.push({
        file: rootName,
        line: 0,
        rule: 'EXPECTED_DIRECTORY',
      });
      continue;
    }

    await walkDirectory(rootAbs);
  }

  violations.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.rule.localeCompare(b.rule),
  );

  return {
    ok: violations.length === 0,
    checkedFiles,
    violations,
  };
}

const isCliEntrypoint =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCliEntrypoint) {
  const result = await verifyNoStubs();
  if (!result.ok) {
    console.error(
      `[verify:no-stubs] FAILED (${result.violations.length} violation(s)):`,
    );
    for (const v of result.violations) {
      console.error(`  - ${v.file}:${v.line} [${v.rule}]`);
    }
    process.exit(1);
  }
  console.log(`[verify:no-stubs] OK (checked ${result.checkedFiles} files)`);
}
