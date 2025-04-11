import { Project, SourceFile, SyntaxKind } from 'ts-morph';
import { resolve, relative, dirname, join } from 'path';
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, unlinkSync } from 'fs';
import * as readlineSync from 'readline-sync';
import chalk from 'chalk';
import fetch from 'node-fetch';
import os from 'os';
import blessed from  'blessed';

const CONFIG_PATH = './repocheck.config.json';
const COMMUNITY_DB_URL = 'https://raw.githubusercontent.com/ubuntupunk/repofix/main/special-cases.json';

interface AliasConfig {
    path: string;
    description: string;
}

interface DirectoryConfig {
    path: string;
    tsconfig: string;
    report: string;
    packageJson?: string;
    dependencies?: { [key: string]: string };
}

interface SpecialCase {
    action: 'rename' | 'replace-method' | 'exclude';
    value?: string;
    prefixOnly?: boolean;
}

interface Config {
    directories: DirectoryConfig[];
    aliases: { [key: string]: AliasConfig };
    specialCases: { [key: string]: SpecialCase };
}

interface CommunitySolution {
    from: string;
    to: string;
    action: 'rename' | 'replace-method' | 'exclude';
    description: string;
    prefixOnly?: boolean;
    category: string;
    priority: number;
    examples: { before: string; after: string }[];
}
interface TUIState {
    screen: blessed.screen;
    issueList: blessed.Widgets.ListElement;
    detailsBox: blessed.Widgets.BoxElement;
    helpBox: blessed.Widgets.BoxElement;
    currentIssues: ImportIssue[];
  }

// Add this function to create the TUI
function createTUI(): TUIState {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'Repofix TUI'
  });

  const issueList = blessed.list({
    parent: screen,
    width: '50%',
    height: '70%',
    left: 0,
    top: 0,
    border: { type: 'line' },
    label: ' Issues ',
    keys: true,
    vi: true,
    mouse: true,
    style: {
      selected: {
        bg: 'blue',
        fg: 'white'
      }
    }
  });

  const detailsBox = blessed.box({
    parent: screen,
    width: '50%',
    height: '70%',
    right: 0,
    top: 0,
    border: { type: 'line' },
    label: ' Details ',
    content: 'Select an issue to see details',
    padding: 1
  });

  const helpBox = blessed.box({
    parent: screen,
    width: '100%',
    height: '30%',
    left: 0,
    bottom: 0,
    border: { type: 'line' },
    label: ' Help ',
    content: [
      '{bold}Keys:{/bold}',
      'Enter: Fix selected issue',
      'Space: Skip selected issue',
      'q: Quit',
      'j/k: Navigate up/down',
      'f: Apply suggested fix',
      's: Skip current issue'
    ].join('\n'),
    tags: true,
    padding: 1
  });

  screen.key(['q', 'C-c'], () => process.exit(0));

  return { screen, issueList, detailsBox, helpBox, currentIssues: [] };
}

// Add this function to handle issues in TUI mode
async function handleIssuesWithTUI(issues: ImportIssue[], project: Project): Promise<void> {
  const tui = createTUI();
  tui.currentIssues = issues;

  const updateIssueList = () => {
    const items = issues.map(issue => {
      const status = issue.fixed ? '[FIXED]' : issue.commented ? '[SKIPPED]' : '[PENDING]';
      return `${status} ${issue.file}:${issue.line} - ${issue.importPath}`;
    });
    tui.issueList.setItems(items);
    tui.screen.render();
  };

  tui.issueList.on('select', async (item: blessed.Widgets.ListElement, index: number) => {
    const issue = issues[index];
    tui.detailsBox.setContent([
      `File: ${issue.file}`,
      `Line: ${issue.line}`,
      `Import: ${issue.importPath}`,
      `Issue: ${issue.issue}`,
      issue.suggestion ? `Suggestion: ${issue.suggestion}` : 'No suggestion available',
      issue.fixed ? 'Status: Fixed' : issue.commented ? 'Status: Skipped' : 'Status: Pending'
    ].join('\n'));
    tui.screen.render();
  });

  tui.screen.key('f', async () => {
    const selected = tui.issueList.selected;
    const issue = issues[selected];
    if (issue && !issue.fixed && !issue.commented) {
      if (issue.suggestion) {
        // Apply fix logic here
        issue.fixed = true;
        updateIssueList();
      }
    }
  });

  tui.screen.key('s', () => {
    const selected = tui.issueList.selected;
    const issue = issues[selected];
    if (issue && !issue.fixed && !issue.commented) {
      issue.commented = true;
      updateIssueList();
    }
  });

  updateIssueList();
  tui.screen.render();
}

function scanMonorepo(rootDir: string): DirectoryConfig[] {
    const directories: DirectoryConfig[] = [];
    const scanDir = (dir: string) => {
        const files = readdirSync(dir, { withFileTypes: true });
        let pkgPath: string | undefined;
        let tsconfigPath: string | undefined;

        for (const file of files) {
            const fullPath = join(dir, file.name);
            if (file.isDirectory()) {
                if (!fullPath.includes('node_modules')) scanDir(fullPath);
            } else if (file.name === 'package.json') {
                pkgPath = fullPath;
            } else if (file.name === 'tsconfig.json') {
                tsconfigPath = fullPath;
            }
        }

        if (tsconfigPath) {
            const dirConfig: DirectoryConfig = {
                path: join(dir, 'src'),
                tsconfig: tsconfigPath,
                report: join(dir, 'import-check-report.json'),
            };
            if (pkgPath) {
                const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
                dirConfig.packageJson = pkgPath;
                dirConfig.dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
            }
            directories.push(dirConfig);
        }
    };

    scanDir(rootDir);
    return directories;
}

function extractAliases(tsconfigPath: string): { [key: string]: AliasConfig } {
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf-8'));
    const baseDir = dirname(tsconfigPath);
    const paths = tsconfig.compilerOptions?.paths || {};
    const aliases: { [key: string]: AliasConfig } = {};

    for (const [alias, pathArray] of Object.entries(paths)) {
        const cleanAlias = alias.replace('/*', '');
        const cleanPath = (pathArray as string[])[0].replace('/*', '');
        aliases[cleanAlias] = {
            path: resolve(baseDir, cleanPath),
            description: `Auto-detected from ${tsconfigPath}`,
        };
    }
    return aliases;
}

async function fetchCommunitySolutions(): Promise<CommunitySolution[]> {
    const timeoutPromise = new Promise<CommunitySolution[]>((_, reject) => {
        setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    const fetchPromise = fetch(COMMUNITY_DB_URL).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<CommunitySolution[]>;
    });

    try {
        return await Promise.race([fetchPromise, timeoutPromise]);
    } catch (err) {
        console.log(chalk.yellow(`Warning: Failed to fetch community solutions (${err.message}). Continuing locally.`));
        return [];
    }
}

async function initializeConfig() {
    console.log(chalk.blue('Welcome to repocheck configuration setup!'));
    const mode = readlineSync.question(
        chalk.white('Choose an option:\n  1. Scan monorepo and configure\n  2. Configure special cases only\n  3. Reset config\nEnter number (1-3): '),
        { limit: ['1', '2', '3'] },
    );

    const config: Config = { directories: [], aliases: {}, specialCases: {} };
    const specialCases: { [key: string]: SpecialCase } = {};

    if (mode === '1' || mode === '2') {
        if (mode === '1') {
            config.directories = scanMonorepo(process.cwd());
            console.log(chalk.cyan('\nDetected directories:'));
            config.directories.forEach((dir, i) => {
                console.log(chalk.white(`${i + 1}. ${dir.path} (tsconfig: ${dir.tsconfig})`));
            });
            const exclude = readlineSync.question(
                chalk.white('Enter numbers to exclude (comma-separated, e.g., 1,3) or "none": '),
            );
            if (exclude !== 'none') {
                const indices = exclude.split(',').map((n) => parseInt(n) - 1);
                config.directories = config.directories.filter((_, i) => !indices.includes(i));
            }

            // Extract aliases
            for (const dir of config.directories) {
                Object.assign(config.aliases, extractAliases(dir.tsconfig));
            }
            console.log(chalk.cyan('\nDetected aliases:'));
            Object.entries(config.aliases).forEach(([alias, conf]) => {
                console.log(chalk.white(`${alias}: ${conf.path} (${conf.description})`));
            });
            if (readlineSync.keyInYN(chalk.green('Add or edit aliases manually?'))) {
                while (true) {
                    const alias = readlineSync.question(chalk.white('Enter alias (e.g., @app) or "done": '));
                    if (alias === 'done') break;
                    const path = readlineSync.question(chalk.white(`Enter path for ${alias} (absolute): `));
                    config.aliases[alias] = { path: resolve(path), description: 'Manually added' };
                }
            }
        }

        // Configure special cases
        const solutions = await fetchCommunitySolutions();
        console.log(chalk.cyan('\nAvailable community solutions:'));
        const categories = [...new Set(solutions.map((s) => s.category))];
        categories.forEach((category) => {
            console.log(chalk.blue(`\n${category.toUpperCase()}:`));
            solutions
                .filter((s) => s.category === category)
                .sort((a, b) => a.priority - b.priority)
                .forEach((sol) => {
                    console.log(chalk.gray(`- ${sol.action}: "${sol.from}" → "${sol.to}" (${sol.description})`));
                    sol.examples.forEach((ex, i) => {
                        console.log(chalk.gray(`  Example ${i + 1}:`));
                        console.log(chalk.gray(`    Before: ${ex.before}`));
                        console.log(chalk.gray(`    After: ${ex.after}`));
                    });
                });
        });

        while (readlineSync.keyInYN(chalk.green('Add a special case?'))) {
            const category = readlineSync.question(chalk.white('Enter category (e.g., authentication) or "all": '));
            const filteredSolutions = category === 'all' ? solutions : solutions.filter((s) => s.category === category);
            if (filteredSolutions.length === 0) {
                console.log(chalk.yellow(`No solutions found for category "${category}".`));
            } else {
                filteredSolutions.forEach((sol, i) => {
                    console.log(chalk.white(`${i + 1}. ${sol.from} → ${sol.to} (${sol.description})`));
                });
                const choice = readlineSync.question(chalk.white('Select a solution (number) or "skip": '));
                if (choice !== 'skip') {
                    const selected = filteredSolutions[parseInt(choice) - 1];
                    specialCases[selected.from] = {
                        action: selected.action,
                        value: selected.to,
                        prefixOnly: selected.prefixOnly,
                    };
                    continue;
                }
            }

            // Custom special case
            const importPath = readlineSync.question(chalk.white('Enter import path (e.g., @old/lib): '));
            const action = readlineSync.question(
                chalk.white('Action (rename/replace-method/exclude): '),
                { limit: ['rename', 'replace-method', 'exclude'] },
            ) as 'rename' | 'replace-method' | 'exclude';
            let value: string | undefined;
            let prefixOnly: boolean | undefined;
            if (action === 'rename') {
                value = readlineSync.question(chalk.white('New import path: '));
                prefixOnly = readlineSync.keyInYN(chalk.white('Apply to prefix only?'));
            } else if (action === 'replace-method') {
                value = readlineSync.question(chalk.white('New method source: '));
            }
            specialCases[importPath] = { action, value, prefixOnly };
        }
        config.specialCases = specialCases;
    } else if (mode === '3') {
        if (existsSync(CONFIG_PATH)) {
            unlinkSync(CONFIG_PATH);
            console.log(chalk.green('Config reset. Run again to create a new config.'));
        } else {
            console.log(chalk.yellow('No config found to reset.'));
        }
        process.exit(0);
    }

    if (!config.directories.length && !Object.keys(config.aliases).length && !Object.keys(config.specialCases).length) {
        console.log(chalk.red('Config is empty. Aborting.'));
        process.exit(1);
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log(chalk.green(`Config saved to ${CONFIG_PATH}`));
    return config;
}

let config: Config;
if (!existsSync(CONFIG_PATH)) {
    config = await initializeConfig();
} else {
    config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

const AUTO_FIX = process.argv.includes('--fix');
const INTERACTIVE = AUTO_FIX && process.argv.includes('--interactive');

interface ImportIssue {
    file: string;
    line: number;
    importPath: string;
    issue: string;
    suggestion: string | null;
    fixed?: boolean;
    commented?: boolean;
    userChoice?: string;
}

// [Previous functions remain unchanged: resolveImportPath, findMatchingAlias, convertToAliasPath, findCommentedImports, confirmFix]
function resolveImportPath(importPath: string, file: SourceFile): string | null {
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

function findMatchingAlias(resolvedPath: string | null): string | null {
    if (!resolvedPath) return null;
    const possibleAliases = Object.entries(config.aliases)
        .filter(([_, config]) => resolvedPath.startsWith(config.path))
        .map(([alias]) => alias)
        .sort((a, b) => b.length - a.length);
    return possibleAliases[0] || null;
}

function convertToAliasPath(resolvedPath: string, alias: string): string | null {
    const aliasConfig = config.aliases[alias];
    if (!aliasConfig) return null;
    const relativePart = relative(aliasConfig.path, resolvedPath).replace(/\\/g, '/');
    if (relativePart.startsWith('..')) return null;
    return `${alias}/${relativePart}`;
}

function findCommentedImports(file: SourceFile): Array<{ text: string; line: number; commentType: string }> {
    const commentedImports: Array<{ text: string; line: number; commentType: string }> = [];
    const fullText = file.getFullText();
    const lines = fullText.split('\n');
    lines.forEach((lineText, index) => {
        const trimmed = lineText.trim();
        if (
            (trimmed.startsWith('//') || trimmed.startsWith('#')) &&
            trimmed.includes('import') &&
            trimmed.includes('from')
        ) {
            commentedImports.push({
                text: trimmed,
                line: index + 1,
                commentType: trimmed.startsWith('//') ? 'single-line' : 'hash',
            });
        }
    });
    file.getDescendantsOfKind(SyntaxKind.MultiLineCommentTrivia).forEach((comment) => {
        const commentText = comment.getText();
        if (commentText.includes('import') && commentText.includes('from')) {
            const lines = commentText.split('\n').map((l) => l.replace(/^\s*\*+\s*/, '').trim());
            const importLine = lines.find((l) => l.startsWith('import'));
            if (importLine) {
                commentedImports.push({
                    text: importLine,
                    line: comment.getStartLineNumber(),
                    commentType: 'multi-line',
                });
            }
        }
    });
    return commentedImports;
}

function confirmFix(issue: ImportIssue): boolean {
    console.log(chalk.red(`\nIssue in ${issue.file}:${issue.line}`));
    console.log(chalk.white(`  Import: ${issue.importPath}`));
    console.log(chalk.yellow(`  Problem: ${issue.issue}`));
    console.log(chalk.cyan(`  Suggested fix: ${issue.suggestion || 'No suggestion available'}`));
    const options = issue.suggestion ? ['Apply fix', 'Skip'] : ['Skip'];
    const question = chalk.white(
        `Choose an option:\n${options.map((opt, i) => `  ${i + 1}. ${opt}`).join('\n')}\nEnter number (1-${options.length}): `,
    );
    const choice = readlineSync.question(question, {
        limit: options.map((_, i) => (i + 1).toString()),
        defaultInput: '2',
    });
    return choice === '1';
}



async function repocheck() {
    const communitySolutions = await fetchCommunitySolutions();
    for (const dir of config.directories) {
        console.log(chalk.blue(`\nStarting repocheck for ${dir.path}`));
        console.log(chalk.gray(`Auto-fix: ${AUTO_FIX}${INTERACTIVE ? ' (interactive)' : ''}`));
        console.log(chalk.gray(`Report will be saved to ${dir.report}`));

        const project = new Project({ tsConfigFilePath: dir.tsconfig });
        let files = project.getSourceFiles(`${dir.path}/**/*.{ts,tsx}`);
        if (files.length === 0) {
            console.log(chalk.yellow(`No .ts/.tsx files found in ${dir.path}. Trying broader pattern...`));
            files = project.getSourceFiles(`${dir.path}/**/*.{ts,tsx,js,jsx}`);
        }
        console.log(chalk.cyan(`Found ${files.length} files to process`));

        const issues: ImportIssue[] = [];

        for (const file of files) {
            const filePath = file.getFilePath();
            const relativeFilePath = relative(process.cwd(), filePath);
            console.log(chalk.white(`\nProcessing: ${relativeFilePath}`));

            const imports = file.getImportDeclarations();
            let fileModified = false;

            for (const importDecl of imports) {
                const importPath = importDecl.getModuleSpecifierValue();
                const line = importDecl.getStartLineNumber();

                if (!importPath.startsWith('.') && !importPath.startsWith('@')) continue;
                if (importPath.startsWith('@') && !Object.keys(config.aliases).some((a) => importPath.startsWith(a))) {
                    const rootPkg = importPath.split('/')[0];
                    if (dir.dependencies?.[rootPkg] || existsSync(resolve('node_modules', rootPkg))) continue;
                }

                console.log(chalk.gray(`  Checking import: ${importPath} (line ${line})`));
                const resolvedPath = resolveImportPath(importPath, file);

                const specialCase = Object.entries(config.specialCases).find(([key]) =>
                    config.specialCases[key].prefixOnly ? importPath.startsWith(key) : importPath === key,
                );
                if (specialCase) {
                    const [key, special] = specialCase;
                    let suggestion: string | null = null;
                    let newImportPath: string | undefined;
                    const communityMatch = communitySolutions.find((sol) => sol.from === importPath);

                    if (special.action === 'rename') {
                        newImportPath = special.prefixOnly ? importPath.replace(key, special.value!) : special.value;
                        suggestion = `Rename to: import ... from '${newImportPath}'`;
                    } else if (special.action === 'replace-method') {
                        newImportPath = special.value;
                        suggestion =
                            communityMatch?.description ||
                            `Replace with: import { useUser } from '${newImportPath}' (adjust usage accordingly)`;
                    } else {
                        suggestion = 'Excluded from checks';
                    }

                    const issue: ImportIssue = {
                        file: relativeFilePath,
                        line,
                        importPath,
                        issue: `Special case: ${special.action}`,
                        suggestion,
                    };

                    if (AUTO_FIX && newImportPath && special.action !== 'exclude') {
                        if (INTERACTIVE && !confirmFix(issue)) {
                            issue.userChoice = 'Skipped';
                            console.log(chalk.yellow(`  Skipped fixing import: ${importPath}`));
                        } else {
                            importDecl.setModuleSpecifier(newImportPath);
                            issue.fixed = true;
                            fileModified = true;
                            console.log(chalk.green(`  Fixed: Changed to '${newImportPath}'`));
                        }
                    }
                    issues.push(issue);
                    continue;
                }

                if (importPath.startsWith('.')) {
                    const suggestedAlias = findMatchingAlias(resolvedPath);
                    if (suggestedAlias) {
                        const relativeImportPath = convertToAliasPath(resolvedPath, suggestedAlias);
                        const issue: ImportIssue = {
                            file: relativeFilePath,
                            line,
                            importPath,
                            issue: `Relative import should use alias '${suggestedAlias}'`,
                            suggestion: `Change to: import ... from '${relativeImportPath}'`,
                        };

                        if (AUTO_FIX && relativeImportPath) {
                            if (INTERACTIVE && !confirmFix(issue)) {
                                issue.userChoice = 'Skipped';
                                console.log(chalk.yellow(`  Skipped fixing import: ${importPath}`));
                            } else {
                                importDecl.setModuleSpecifier(relativeImportPath);
                                issue.fixed = true;
                                fileModified = true;
                                console.log(chalk.green(`  Fixed: Changed to '${relativeImportPath}'`));
                            }
                        }
                        issues.push(issue);
                    } else if (!resolvedPath) {
                        issues.push({
                            file: relativeFilePath,
                            line,
                            importPath,
                            issue: `Relative import '${importPath}' cannot be resolved`,
                            suggestion: `File not found at ${resolve(dirname(filePath), importPath)}`,
                        });
                    }
                } else if (importPath.startsWith('@')) {
                    const aliasRoot = importPath.split('/')[0];
                    const fullAlias = importPath.includes('/')
                        ? importPath.split('/').slice(0, 2).join('/')
                        : aliasRoot;

                    if (!config.aliases[fullAlias] && !config.aliases[aliasRoot]) {
                        const rootPkg = aliasRoot;
                        const isSpecialCaseRoot = Object.keys(config.specialCases).some((key) =>
                            config.specialCases[key].prefixOnly ? key.startsWith(rootPkg) : key === rootPkg,
                        );
                        const suggestion =
                            isSpecialCaseRoot || dir.dependencies?.[rootPkg]
                                ? null
                                : `Module '${rootPkg}' not found. Run: bun add ${rootPkg}`;
                        issues.push({
                            file: relativeFilePath,
                            line,
                            importPath,
                            issue: `Unknown alias '${fullAlias}' or '${aliasRoot}'`,
                            suggestion: suggestion || 'Verify alias in tsconfig.json or use relative path',
                        });
                    } else {
                        const expectedPath = config.aliases[fullAlias]?.path || config.aliases[aliasRoot]?.path;
                        if (resolvedPath && expectedPath && !resolvedPath.startsWith(expectedPath)) {
                            const suggestedAlias = findMatchingAlias(resolvedPath);
                            const relativeImportPath = suggestedAlias
                                ? convertToAliasPath(resolvedPath, suggestedAlias)
                                : null;
                            const issue: ImportIssue = {
                                file: relativeFilePath,
                                line,
                                importPath,
                                issue: `Alias '${importPath}' resolves incorrectly`,
                                suggestion: relativeImportPath
                                    ? `Change to: import ... from '${relativeImportPath}'`
                                    : `Verify path for '${importPath}'`,
                            };

                            if (AUTO_FIX && relativeImportPath) {
                                if (INTERACTIVE && !confirmFix(issue)) {
                                    issue.userChoice = 'Skipped';
                                } else {
                                    importDecl.setModuleSpecifier(relativeImportPath);
                                    issue.fixed = true;
                                    fileModified = true;
                                    console.log(chalk.green(`  Fixed: Changed to '${relativeImportPath}'`));
                                }
                            }
                            issues.push(issue);
                        }
                    }
                }
            }

            const commentedImports = findCommentedImports(file);
            for (const { text, line, commentType } of commentedImports) {
                console.log(chalk.gray(`  Found commented import: ${text} (line ${line}, type: ${commentType})`));
                const importMatch = text.match(/import\s+.*\s+from\s+['"]([^'"]+)['"]/);
                if (!importMatch) {
                    issues.push({
                        file: relativeFilePath,
                        line,
                        importPath: text,
                        issue: `Invalid commented import syntax`,
                        suggestion: 'Manually review and fix',
                        commented: true,
                    });
                    continue;
                }

                const importPath = importMatch[1];
                const resolvedPath = resolveImportPath(importPath, file);
                const specialCase = Object.entries(config.specialCases).find(([key]) =>
                    config.specialCases[key].prefixOnly ? importPath.startsWith(key) : importPath === key,
                );

                if (specialCase) {
                    const [key, special] = specialCase;
                    let suggestion: string | null = null;
                    let newImportPath: string | undefined;
                    const communityMatch = communitySolutions.find((sol) => sol.from === importPath);

                    if (special.action === 'rename') {
                        newImportPath = special.prefixOnly ? importPath.replace(key, special.value!) : special.value;
                        suggestion = `Uncomment and rename to: ${text.replace(/^\s*\/\/+\s*|^#+\s*|\/\*|\*\//g, '').replace(importPath, newImportPath)}`;
                    } else if (special.action === 'replace-method') {
                        newImportPath = special.value;
                        suggestion =
                            communityMatch?.description ||
                            `Uncomment and replace with: import { useUser } from '${newImportPath}' (adjust usage accordingly)`;
                    } else {
                        suggestion = 'Excluded from checks';
                    }

                    const issue: ImportIssue = {
                        file: relativeFilePath,
                        line,
                        importPath,
                        issue: `Commented special case: ${special.action}`,
                        suggestion,
                        commented: true,
                    };

                    if (AUTO_FIX && newImportPath && special.action !== 'exclude') {
                        let shouldFix = !INTERACTIVE;
                        if (INTERACTIVE) shouldFix = confirmFix(issue);
                        if (shouldFix) {
                            const fullText = file.getFullText();
                            const lines = fullText.split('\n');
                            lines[line - 1] = text
                                .replace(/^\s*\/\/+\s*|^#+\s*|\/\*|\*\//g, '')
                                .replace(importPath, newImportPath);
                            file.replaceWithText(lines.join('\n'));
                            issue.fixed = true;
                            fileModified = true;
                            console.log(chalk.green(`  Fixed: Uncommented and changed to '${newImportPath}'`));
                        }
                    }
                    issues.push(issue);
                    continue;
                }

                if (!resolvedPath) {
                    const rootPkg = importPath.split('/')[0].startsWith('@')
                        ? importPath.split('/').slice(0, 2).join('/')
                        : importPath.split('/')[0];
                    const isSpecialCaseRoot = Object.keys(config.specialCases).some((key) =>
                        config.specialCases[key].prefixOnly ? key.startsWith(rootPkg) : key === rootPkg,
                    );
                    const suggestion =
                        isSpecialCaseRoot || dir.dependencies?.[rootPkg]
                            ? 'Uncomment to use'
                            : `Module '${rootPkg}' not found. Run: bun add ${rootPkg}`;
                    issues.push({
                        file: relativeFilePath,
                        line,
                        importPath,
                        issue: `Commented import '${importPath}' cannot be resolved`,
                        suggestion,
                        commented: true,
                    });
                    continue;
                }

                const suggestedAlias = findMatchingAlias(resolvedPath);
                const newImportPath = suggestedAlias ? convertToAliasPath(resolvedPath, suggestedAlias) : importPath;
                const issue: ImportIssue = {
                    file: relativeFilePath,
                    line,
                    importPath,
                    issue: suggestedAlias
                        ? `Commented import should use alias '${suggestedAlias}'`
                        : `Commented import has no matching alias`,
                    suggestion: `Uncomment and change to: ${text.replace(/^\s*\/\/+\s*|^#+\s*|\/\*|\*\//g, '').replace(importPath, newImportPath)}`,
                    commented: true,
                };

                if (AUTO_FIX && newImportPath) {
                    let shouldFix = !INTERACTIVE;
                    if (INTERACTIVE) shouldFix = confirmFix(issue);
                    if (shouldFix) {
                        const fullText = file.getFullText();
                        const lines = fullText.split('\n');
                        lines[line - 1] = text
                            .replace(/^\s*\/\/+\s*|^#+\s*|\/\*|\*\//g, '')
                            .replace(importPath, newImportPath);
                        file.replaceWithText(lines.join('\n'));
                        issue.fixed = true;
                        fileModified = true;
                        console.log(chalk.green(`  Fixed: Uncommented and changed to '${newImportPath}'`));
                    }
                }
                issues.push(issue);
            }

            if (fileModified && AUTO_FIX) {
                await file.save();
                console.log(chalk.green(`  Saved changes to ${relativeFilePath}`));
            }
        }

        const report = {
            totalFiles: files.length,
            totalIssues: issues.length,
            standardIssues: issues.filter((i) => !i.commented).length,
            commentedIssues: issues.filter((i) => i.commented).length,
            fixedIssues: issues.filter((i) => i.fixed).length,
            issues,
        };

        writeFileSync(dir.report, JSON.stringify(report, null, 2));
        console.log(chalk.blue(`\nCompleted repocheck for ${files.length} files in ${dir.path}`));
        console.log(
            chalk.cyan(
                `Total issues: ${issues.length} (Standard: ${report.standardIssues}, Commented: ${report.commentedIssues})`,
            ),
        );
        console.log(chalk.green(`Fixed issues: ${report.fixedIssues}`));
    }
}

// Use an IIFE to handle the async main function
(async () => {
    await repocheck().catch((err) => {
        console.error(chalk.red('Error running repocheck:', err));
        process.exit(1);
    });
})();
