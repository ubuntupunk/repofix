//helpers.ts
import { Project, SourceFile, SyntaxKind } from 'ts-morph';
import { resolve, dirname, join, relative } from 'path';
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'fs';
import fetch from 'node-fetch';
import os from 'os';
import kleur from 'kleur';

// Interfaces
interface AliasConfig { path: string; description: string; }
interface DirectoryConfig {
  path: string;
  tsconfig: string;
  report: string;
  packageJson?: string;
  dependencies?: { [key: string]: string };
  workspaceName?: string;
}
interface CommunitySolution { from: string; to: string; action: 'rename' | 'replace-method' | 'exclude'; description: string; prefixOnly?: boolean; category: string; priority: number; examples: { before: string; after: string }[]; }

// Utility Functions

/**
 * Fetches community-provided special case solutions from a remote URL.
 * Caches the results locally for a defined TTL (Time To Live).
 * @returns {Promise<CommunitySolution[]>} A promise that resolves to an array of community solutions, or an empty array on error.
 */
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

/**
 * Scans a directory recursively to find potential project directories within a monorepo.
 * Identifies directories containing a tsconfig.json file.
 * Reads package.json if present to extract dependencies and workspace name.
 * @param {string} rootDir - The root directory of the monorepo to scan.
 * @returns {DirectoryConfig[]} An array of configurations for the found directories.
 */
export function scanMonorepo(rootDir: string): DirectoryConfig[] {
  const directories: DirectoryConfig[] = [];
  const scanDir = (dir: string) => {
    try {
      const files = readdirSync(dir, { withFileTypes: true });
      let pkgPath: string | undefined;
      let tsconfigPath: string | undefined;
      let workspaceName: string | undefined;
      for (const file of files) {
        const fullPath = join(dir, file.name);
        if (file.isDirectory() && !fullPath.includes('node_modules')) scanDir(fullPath);
        else if (file.name === 'package.json') pkgPath = fullPath;
        else if (file.name === 'tsconfig.json') tsconfigPath = fullPath;
      }
      if (tsconfigPath) {
        const dirConfig: DirectoryConfig = {
            path: join(dir, 'src'),
            tsconfig: tsconfigPath,
            report: join(dir, 'import-check-report.json'),
            workspaceName
          };
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

/**
 * Extracts TypeScript path aliases from a given tsconfig.json file.
 * @param {string} tsconfigPath - The path to the tsconfig.json file.
 * @returns {{ [key: string]: AliasConfig }} An object mapping alias names to their configuration (resolved path and description). Returns an empty object on error.
 */
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

interface MonocheckConfig {
  aliases: { [key: string]: AliasConfig };
}

/**
 * Resolves an import path (module specifier) to its absolute file system path.
 * Handles relative paths and alias paths based on the provided configuration.
 * Checks for the existence of the resolved file (with .ts/.tsx extensions if needed).
 * @param {string} importPath - The import path string (e.g., './utils', '@/components/Button').
 * @param {SourceFile} file - The ts-morph SourceFile object where the import occurs.
 * @param {MonocheckConfig | undefined} config - The monocheck configuration containing aliases.
 * @returns {string | null} The resolved absolute path, or null if resolution fails or the file doesn't exist.
 */
export function resolveImportPath(importPath: string, file: SourceFile, config: MonocheckConfig | undefined): string | null {
  if (!config) return null;
  const fileDir = dirname(file.getFilePath());
  if (importPath.startsWith('.')) {
    const resolved = resolve(fileDir, importPath);
    return existsSync(resolved) || existsSync(resolved + '.ts') || existsSync(resolved + '.tsx')
      ? resolved
      : null;
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

/**
 * Finds the most specific path alias from the configuration that matches the start of a given resolved absolute path.
 * @param {string | null} resolvedPath - The absolute path to find an alias for.
 * @param {MonocheckConfig | undefined} config - The monocheck configuration containing aliases.
 * @returns {string | null} The best matching alias name (e.g., '@/utils'), or null if no alias matches.
 */
export function findMatchingAlias(resolvedPath: string | null, config: MonocheckConfig | undefined): string | null {
  if (!resolvedPath || !config) return null;
  const possibleAliases = Object.entries(config.aliases)
    .filter(([_, config]) => resolvedPath.startsWith(config.path))
    .map(([alias]) => alias)
    .sort((a, b) => b.length - a.length);
  return possibleAliases[0] || null;
}

/**
 * Converts an absolute file system path back into an alias-based import path.
 * @param {string} resolvedPath - The absolute path to convert.
 * @param {string} alias - The specific alias to use for conversion (e.g., '@').
 * @param {MonocheckConfig | undefined} config - The monocheck configuration containing aliases.
 * @returns {string | null} The resulting alias path (e.g., '@/components/Button'), or null if conversion is not possible (e.g., path is outside the alias directory).
 */
export function convertToAliasPath(resolvedPath: string, alias: string, config: MonocheckConfig | undefined): string | null {
  if (!config) return null;
  const aliasConfig = config.aliases[alias];
  if (!aliasConfig) return null;
  const relativePart = relative(aliasConfig.path, resolvedPath).replace(/\\/g, '/');
  if (relativePart.startsWith('..')) return null;
  return `${alias}/${relativePart}`;
}

/**
 * Finds import statements within comments (single-line, hash, or multi-line) in a source file.
 * @param {SourceFile} file - The ts-morph SourceFile object to scan.
 * @returns {Array<{ text: string; line: number; commentType: string }>} An array of objects, each representing a found commented import, including the import text, line number, and comment type.
 */
export function findCommentedImports(file: SourceFile): Array<{ text: string; line: number; commentType: string }> {
  const commentedImports: Array<{ text: string; line: number; commentType: string }> = [];
  const fullText = file.getFullText();
  const lines = fullText.split('\n');
  lines.forEach((lineText: string, index: number) => {
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
