//non-tui version
import { Project, SourceFile, SyntaxKind } from 'ts-morph';
import { resolve, relative, dirname, join } from 'path';
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, unlinkSync } from 'fs';
import * as readlineSync from 'readline-sync';
import chalk from 'chalk';
import fetch from 'node-fetch';
import os from 'os';

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

async function repocheck() {
    // [Previous repocheck implementation remains unchanged]
}

// Use an IIFE to handle the async main function
(async () => {
    await repocheck().catch((err) => {
        console.error(chalk.red('Error running repocheck:', err));
        process.exit(1);
    });
})();
