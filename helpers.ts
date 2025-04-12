//helpers.ts
import { Project, SourceFile, SyntaxKind } from 'ts-morph';
import { resolve, dirname, join } from 'path';
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'fs';
import fetch from 'node-fetch';
import os from 'os';

// Interfaces
interface AliasConfig { path: string; description: string; }
interface DirectoryConfig { path: string; tsconfig: string; report: string; packageJson?: string; dependencies?: { [key: string]: string }; }
interface CommunitySolution { from: string; to: string; action: 'rename' | 'replace-method' | 'exclude'; description: string; prefixOnly?: boolean; category: string; priority: number; examples: { before: string; after: string }[]; }

// Utility Functions
export async function fetchCommunitySolutions(): Promise<CommunitySolution[]> {
  const cacheDir = join(os.homedir(), '.monocheck', 'cache');
  const cachePath = join(cacheDir, 'special-cases.json');
  const ttl = 24 * 60 * 60 * 1000; // 24 hours
  if (existsSync(cachePath) && Date.now() - statSync(cachePath).mtimeMs < ttl) {
    try {
      return JSON.parse(readFileSync(cachePath, 'utf-8'));
    } catch (err) {
      console.log(kleur.red(`Error reading cached solutions: ${err}`));
    }
  }
  try {
    const response = await fetch('https://raw.githubusercontent.com/ubuntupunk/repofix/main/special-cases.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const solutions = await response.json();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(solutions, null, 2));
    return solutions;
  } catch (err) {
    console.log(kleur.red(`Error fetching community solutions: ${err}`));
    return [];
  }
}

export function scanMonorepo(rootDir: string): DirectoryConfig[] {
  const directories: DirectoryConfig[] = [];
  const scanDir = (dir: string) => {
    try {
      const files = readdirSync(dir, { withFileTypes: true });
      let pkgPath: string | undefined;
      let tsconfigPath: string | undefined;
      for (const file of files) {
        const fullPath = join(dir, file.name);
        if (file.isDirectory() && !fullPath.includes('node_modules')) scanDir(fullPath);
        else if (file.name === 'package.json') pkgPath = fullPath;
        else if (file.name === 'tsconfig.json') tsconfigPath = fullPath;
      }
      if (tsconfigPath) {
        const dirConfig: DirectoryConfig = { path: join(dir, 'src'), tsconfig: tsconfigPath, report: join(dir, 'import-check-report.json') };
        if (pkgPath) {
          try {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
            dirConfig.packageJson = pkgPath;
            dirConfig.dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
          } catch (err) {
            console.log(kleur.yellow(`Error reading package.json at ${pkgPath}: ${err}`));
          }
        }
        directories.push(dirConfig);
      }
    } catch (err) {
      console.log(kleur.red(`Error scanning directory ${dir}: ${err}`));
    }
  };
  scanDir(rootDir);
  return directories;
}

export function extractAliases(tsconfigPath: string): { [key: string]: AliasConfig } {
  try {
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf-8'));
    const baseDir = dirname(tsconfigPath);
    const paths = tsconfig.compilerOptions?.paths || {};
    const aliases: { [key: string]: AliasConfig } = {};
    for (const [alias, pathArray] of Object.entries(paths)) {
      const cleanAlias = alias.replace('/*', '');
      const cleanPath = (pathArray as string[])[0].replace('/*', '');
      aliases[cleanAlias] = { path: resolve(baseDir, cleanPath), description: `Auto-detected from ${tsconfigPath}` };
    }
    return aliases;
  } catch (err) {
    console.log(kleur.red(`Error extracting aliases from ${tsconfigPath}: ${err}`));
    return {};
  }
}

export function resolveImportPath(importPath: string, file: SourceFile, config: any): string | null {
  if (!config) return null;
  const fileDir = dirname(file.getFilePath());
  if (importPath.startsWith('.')) {
    const resolved = resolve(fileDir, importPath);
    return existsSync(resolved) || existsSync(resolved + '.ts') || existsSync(resolved + '.tsx') ? resolved : null;
  }
  const aliasRoot = importPath.split('/')[0];
  const aliasPath = importPath.includes('/') ? importPath.split('/').slice(0, 2).join('/') : aliasRoot;
  if (config.aliases[aliasPath]) {
    const relativePart = importPath.replace(`${aliasPath}/`, '');
    const resolved = resolve(config.aliases[aliasPath].path, relativePart);
    return existsSync(resolved) || existsSync(resolved + '.ts') || existsSync(resolved + '.tsx') ? resolved : null;
  } else if (config.aliases[aliasRoot]) {
    const relativePart = importPath.replace(`${aliasRoot}/`, '');
    const resolved = resolve(config.aliases[aliasRoot].path, relativePart);
    return existsSync(resolved) || existsSync(resolved + '.ts') || existsSync(resolved + '.tsx') ? resolved : null;
  } else {
    try {
      return require.resolve(importPath, { paths: [process.cwd()] });
    } catch {
      return null;
    }
  }
}

export function findMatchingAlias(resolvedPath: string | null, config: any): string | null {
  if (!resolvedPath || !config) return null;
  const possibleAliases = Object.entries(config.aliases)
    .filter(([_, config]) => resolvedPath.startsWith(config.path))
    .map(([alias]) => alias)
    .sort((a, b) => b.length - a.length);
  return possibleAliases[0] || null;
}

export function convertToAliasPath(resolvedPath: string, alias: string, config: any): string | null {
  if (!config) return null;
  const aliasConfig = config.aliases[alias];
  if (!aliasConfig) return null;
  const relativePart = relative(aliasConfig.path, resolvedPath).replace(/\\/g, '/');
  if (relativePart.startsWith('..')) return null;
  return `${alias}/${relativePart}`;
}

export function findCommentedImports(file: SourceFile): Array<{ text: string; line: number; commentType: string }> {
  const commentedImports: Array<{ text: string; line: number; commentType: string }> = [];
  const fullText = file.getFullText();
  const lines = fullText.split('\n');
  lines.forEach((lineText, index) => {
    const trimmed = lineText.trim();
    if ((trimmed.startsWith('//') || trimmed.startsWith('#')) && trimmed.includes('import') && trimmed.includes('from')) {
      commentedImports.push({ text: trimmed, line: index + 1, commentType: trimmed.startsWith('//') ? 'single-line' : 'hash' });
    }
  });
  file.getDescendantsOfKind(SyntaxKind.MultiLineCommentTrivia).forEach((comment) => {
    const commentText = comment.getText();
    if (commentText.includes('import') && commentText.includes('from')) {
      const lines = commentText.split('\n').map((l) => l.replace(/^\s*\/*\**\s*|\s*\*\/$/g, '').trim()).filter(l => l);
      const importLine = lines.find((l) => l.startsWith('import'));
      if (importLine) commentedImports.push({ text: importLine, line: comment.getStartLineNumber(), commentType: 'multi-line' });
    }
  });
  return commentedImports;
}