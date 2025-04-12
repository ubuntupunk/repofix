import { Project, SourceFile, SyntaxKind } from 'ts-morph';
import { resolve, relative, dirname, join } from 'path';
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import kleur from 'kleur';
import fetch from 'node-fetch';
import os from 'os';
import blessed from 'blessed';

// Configuration and Constants
const CONFIG_PATH = './monocheck.config.json';
const COMMUNITY_DB_URL = 'https://raw.githubusercontent.com/ubuntupunk/repofix/main/special-cases.json';

// Interfaces
interface AliasConfig { path: string; description: string; }
interface DirectoryConfig { path: string; tsconfig: string; report: string; packageJson?: string; dependencies?: { [key: string]: string }; }
interface SpecialCase { action: 'rename' | 'replace-method' | 'exclude'; value?: string; prefixOnly?: boolean; }
interface Config { directories: DirectoryConfig[]; aliases: { [key: string]: AliasConfig }; specialCases: { [key: string]: SpecialCase }; }
interface CommunitySolution { from: string; to: string; action: 'rename' | 'replace-method' | 'exclude'; description: string; prefixOnly?: boolean; category: string; priority: number; examples: { before: string; after: string }[]; }
interface ImportIssue { file: string; line: number; importPath: string; issue: string; suggestion: string | null; fixed?: boolean; commented?: boolean; userChoice?: string; }

// Module-Level Config
let config: Config | undefined;
let mainScreen: blessed.Widgets.Screen;

// Utility Functions
async function fetchCommunitySolutions(): Promise<CommunitySolution[]> {
  const cacheDir = join(os.homedir(), '.monocheck', 'cache');
  const cachePath = join(cacheDir, 'special-cases.json');
  const ttl = 24 * 60 * 60 * 1000; // 24 hours
  if (existsSync(cachePath) && Date.now() - statSync(cachePath).mtimeMs < ttl) {
    return JSON.parse(readFileSync(cachePath, 'utf-8'));
  }
  try {
    const response = await fetch(COMMUNITY_DB_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const solutions = await response.json();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(solutions, null, 2));
    return solutions;
  } catch (err) {
    return [];
  }
}

function scanMonorepo(rootDir: string): DirectoryConfig[] {
  const directories: DirectoryConfig[] = [];
  const scanDir = (dir: string) => {
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
    return {};
  }
}

function resolveImportPath(importPath: string, file: SourceFile): string | null {
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

function findMatchingAlias(resolvedPath: string | null): string | null {
  if (!resolvedPath || !config) return null;
  const possibleAliases = Object.entries(config.aliases)
    .filter(([_, config]) => resolvedPath.startsWith(config.path))
    .map(([alias]) => alias)
    .sort((a, b) => b.length - a.length);
  return possibleAliases[0] || null;
}

function convertToAliasPath(resolvedPath: string, alias: string): string | null {
  if (!config) return null;
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
    if ((trimmed.startsWith('//') || trimmed.startsWith('#')) && trimmed.includes('import') && trimmed.includes('from')) {
      commentedImports.push({ text: trimmed, line: index + 1, commentType: trimmed.startsWith('//') ? 'single-line' : 'hash' });
    }
  });
  file.getDescendantsOfKind(SyntaxKind.MultiLineCommentTrivia).forEach((comment) => {
    const commentText = comment.getText();
    if (commentText.includes('import') && commentText.includes('from')) {
      const lines = commentText.split('\n').map((l) => l.replace(/^\s*\*+\s*/, '').trim());
      const importLine = lines.find((l) => l.startsWith('import'));
      if (importLine) commentedImports.push({ text: importLine, line: comment.getStartLineNumber(), commentType: 'multi-line' });
    }
  });
  return commentedImports;
}

// Return to Main Screen Function
function returnToMainScreen(currentScreen: blessed.Widgets.Screen) {
  currentScreen.destroy();
  mainScreen = blessed.screen({ smartCSR: true, title: 'monocheck Config Setup' });
  initializeMainMenu(mainScreen);
}

// Main Menu Setup
function initializeMainMenu(screen: blessed.Widgets.Screen) {
  const AUTO_FIX = process.argv.includes('--fix');
  let initialConfig: Config = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) : { directories: [], aliases: {}, specialCases: {} };

  const list = blessed.list({
    parent: screen,
    top: 1,
    left: 1,
    width: '90%',
    height: '50%',
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, selected: { bg: 'blue' }, item: { fg: 'white' } },
    keys: true,
    items: ['1. Scan monorepo', '2. Add special case', '3. Community solutions', '4. Edit config', ...(AUTO_FIX ? ['5. Fix issues'] : []), '6. Save and exit'],
  });

  const status = blessed.text({
    parent: screen,
    bottom: 0,
    left: 1,
    width: '100%',
    height: '20%',
    content: 'Select an option with arrow keys, press Enter to confirm, h for home, q to quit',
    style: { fg: 'yellow' },
  });

  let resolvePromise: (value: Config) => void;
  const promise = new Promise<Config>((resolve) => (resolvePromise = resolve));

  list.on('select', async (item, index) => {
    if (index === 0) { // Scan monorepo
      const directories = scanMonorepo(process.cwd());
      screen.destroy();

      const dirScreen = blessed.screen({ smartCSR: true, title: 'Select Directories' });
      const excluded = new Set<number>();
      const dirList = blessed.list({
        parent: dirScreen,
        top: 1,
        left: 1,
        width: '90%',
        height: '50%',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' }, selected: { bg: 'blue' }, item: { fg: 'white' } },
        keys: true,
        items: directories.map((d, i) => `${i + 1}. ${d.path} (tsconfig: ${d.tsconfig})`),
        interactive: true,
      });

      const logBox = blessed.log({
        parent: dirScreen,
        top: '50%+2',
        left: 1,
        width: '90%',
        height: '30%',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' }, fg: 'white' },
        scrollable: true,
        scrollbar: { bg: 'blue' },
      });

      const dirStatus = blessed.text({
        parent: dirScreen,
        bottom: 0,
        left: 1,
        width: '100%',
        height: '20%',
        content: 'Space to toggle exclusion, Enter to scan, h for home, q to return',
        style: { fg: 'yellow' },
      });

      dirScreen.key(['space'], () => {
        const index = dirList.selected;
        if (excluded.has(index)) {
          excluded.delete(index);
          dirList.items[index].style.fg = 'green';
        } else {
          excluded.add(index);
          dirList.items[index].style.fg = 'gray';
        }
        dirScreen.render();
      });

      dirScreen.key(['enter'], async () => {
        initialConfig.directories = directories.filter((_, i) => !excluded.has(i));
        for (const dir of initialConfig.directories) {
          if (!existsSync(dir.path)) {
            dir.path = dirname(dir.tsconfig);
            logBox.log(kleur.yellow(`No 'src' dir found for ${dir.tsconfig}. Using ${dir.path} instead.`));
          }
          Object.assign(initialConfig.aliases, extractAliases(dir.tsconfig));
        }
        config = initialConfig;
        const issuesByDir = await scanAndReport(logBox);
        displayReportTui(issuesByDir);
      });

      dirScreen.key(['h'], () => returnToMainScreen(dirScreen));
      dirScreen.key(['q'], () => returnToMainScreen(dirScreen));

      dirList.items.forEach((item: any) => (item.style.fg = 'green'));
      dirList.focus();
      dirScreen.render();
    } else if (index === 1) { // Add special case
      screen.destroy();
      const specialScreen = blessed.screen({ smartCSR: true, title: 'Add Special Case' });
      const form = blessed.form({
        parent: specialScreen,
        top: 1,
        left: 1,
        width: '90%',
        height: '50%',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' } },
        keys: true,
      });

      blessed.text({ parent: form, top: 0, left: 1, content: 'Import path:', style: { fg: 'white' } });
      const importInput = blessed.textbox({ parent: form, top: 1, left: 1, width: '80%', height: 3, inputOnFocus: true, border: { type: 'line' }, style: { fg: 'white', border: { fg: 'gray' } } });
      blessed.text({ parent: form, top: 4, left: 1, content: 'Action:', style: { fg: 'white' } });
      const actionList = blessed.list({
        parent: form,
        top: 5,
        left: 1,
        width: '80%',
        height: 5,
        border: { type: 'line' },
        style: { border: { fg: 'gray' }, selected: { bg: 'blue' }, item: { fg: 'white' } },
        items: ['rename', 'replace-method', 'exclude'],
        keys: true,
        interactive: true,
      });
      blessed.text({ parent: form, top: 10, left: 1, content: 'New value (if applicable):', style: { fg: 'white' } });
      const valueInput = blessed.textbox({ parent: form, top: 11, left: 1, width: '80%', height: 3, inputOnFocus: true, border: { type: 'line' }, style: { fg: 'white', border: { fg: 'gray' } } });
      const prefixCheckbox = blessed.checkbox({ parent: form, top: 14, left: 1, content: 'Prefix only?', mouse: true, style: { fg: 'white' } });

      const specialStatus = blessed.text({
        parent: specialScreen,
        bottom: 0,
        left: 1,
        width: '100%',
        height: '20%',
        content: 'Tab to navigate, Space to select action, Enter to submit, h for home, q to return',
        style: { fg: 'yellow' },
      });

      let selectedAction: number | null = null;
      specialScreen.key(['space'], () => {
        if (specialScreen.focused === actionList) {
          const index = actionList.selected;
          if (selectedAction === index) {
            selectedAction = null;
            actionList.items[index].style.fg = 'white';
          } else {
            if (selectedAction !== null) actionList.items[selectedAction].style.fg = 'white';
            selectedAction = index;
            actionList.items[index].style.fg = 'green';
          }
          specialScreen.render();
        }
      });

      specialScreen.key(['enter'], () => {
        const importPath = importInput.getValue().trim();
        const action = selectedAction !== null ? actionList.items[selectedAction].content as 'rename' | 'replace-method' | 'exclude' : null;
        const value = valueInput.getValue().trim() || undefined;
        const prefixOnly = prefixCheckbox.checked;
        if (importPath && action) {
          initialConfig.specialCases[importPath] = { action, value, prefixOnly };
          specialStatus.setContent('Special case added!');
          specialScreen.render();
          setTimeout(() => returnToMainScreen(specialScreen), 500);
        } else {
          specialStatus.setContent('Please fill in import path and select an action with Space.');
          specialScreen.render();
        }
      });

      specialScreen.key(['tab'], () => {
        const current = specialScreen.focused;
        if (current === importInput) actionList.focus();
        else if (current === actionList) valueInput.focus();
        else if (current === valueInput) prefixCheckbox.focus();
        else importInput.focus();
        specialScreen.render();
      });

      specialScreen.key(['h'], () => returnToMainScreen(specialScreen));
      specialScreen.key(['q'], () => returnToMainScreen(specialScreen));

      importInput.focus();
      specialScreen.render();
    } else if (index === 2) { // Community solutions
      const solutions = await fetchCommunitySolutions();
      if (!solutions.length) {
        status.setContent('No community solutions available. Check network and try again.');
        screen.render();
        return;
      }
      screen.destroy();

      const commScreen = blessed.screen({ smartCSR: true, title: 'Community Solutions' });
      const selected = new Set<number>();
      const commList = blessed.list({
        parent: commScreen,
        top: 1,
        left: 1,
        width: '90%',
        height: '50%',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' }, selected: { bg: 'blue' }, item: { fg: 'white' } },
        keys: true,
        items: solutions.map((s) => `${s.from} → ${s.to} (${s.description}) [${s.category}]`),
        interactive: true,
      });

      const exampleBox = blessed.box({
        parent: commScreen,
        top: '50%+2',
        left: 1,
        width: '90%',
        height: '30%',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' }, fg: 'white' },
        content: '',
      });

      const commStatus = blessed.text({
        parent: commScreen,
        bottom: 0,
        left: 1,
        width: '100%',
        height: '20%',
        content: 'Space to select, Enter to customize/add, h for home, q to return',
        style: { fg: 'yellow' },
      });

      commList.on('select', (item, i) => {
        const sol = solutions[i];
        exampleBox.setContent(`Before: ${sol.examples[0]?.before || 'N/A'}\nAfter: ${sol.examples[0]?.after || 'N/A'}`);
        commScreen.render();
      });

      commScreen.key(['space'], () => {
        const index = commList.selected;
        if (selected.has(index)) {
          selected.delete(index);
          commList.items[index].style.fg = 'white';
        } else {
          selected.add(index);
          commList.items[index].style.fg = 'green';
        }
        commScreen.render();
      });

      commScreen.key(['enter'], () => {
        const index = commList.selected;
        const sol = solutions[index];
        commScreen.destroy();

        const editScreen = blessed.screen({ smartCSR: true, title: 'Customize Special Case' });
        const form = blessed.form({
          parent: editScreen,
          top: 1,
          left: 1,
          width: '90%',
          height: '50%',
          border: { type: 'line' },
          style: { border: { fg: 'cyan' } },
          keys: true,
        });

        blessed.text({ parent: form, top: 0, left: 1, content: `Import path: ${sol.from}`, style: { fg: 'white' } });
        blessed.text({ parent: form, top: 2, left: 1, content: 'New value:', style: { fg: 'white' } });
        const valueInput = blessed.textbox({ parent: form, top: 3, left: 1, width: '80%', height: 3, inputOnFocus: true, border: { type: 'line' }, style: { fg: 'white', border: { fg: 'gray' } }, value: sol.to });
        blessed.text({ parent: form, top: 6, left: 1, content: 'Action:', style: { fg: 'white' } });
        const actionList = blessed.list({
          parent: form,
          top: 7,
          left: 1,
          width: '80%',
          height: 5,
          border: { type: 'line' },
          style: { border: { fg: 'gray' }, selected: { bg: 'blue' }, item: { fg: 'white' } },
          items: ['rename', 'replace-method', 'exclude'],
          keys: true,
          interactive: true,
          selected: ['rename', 'replace-method', 'exclude'].indexOf(sol.action),
        });
        const prefixCheckbox = blessed.checkbox({ parent: form, top: 12, left: 1, content: 'Prefix only?', mouse: true, style: { fg: 'white' }, checked: sol.prefixOnly });

        const editStatus = blessed.text({
          parent: editScreen,
          bottom: 0,
          left: 1,
          width: '100%',
          height: '20%',
          content: 'Tab to navigate, Space to select action, Enter to add, h for home, q to return',
          style: { fg: 'yellow' },
        });

        let selectedAction: number | null = null;
        editScreen.key(['space'], () => {
          if (editScreen.focused === actionList) {
            const index = actionList.selected;
            if (selectedAction === index) {
              selectedAction = null;
              actionList.items[index].style.fg = 'white';
            } else {
              if (selectedAction !== null) actionList.items[selectedAction].style.fg = 'white';
              selectedAction = index;
              actionList.items[index].style.fg = 'green';
            }
            editScreen.render();
          }
        });

        editScreen.key(['enter'], () => {
          const value = valueInput.getValue().trim() || undefined;
          const action = selectedAction !== null ? actionList.items[selectedAction].content as 'rename' | 'replace-method' | 'exclude' : null;
          const prefixOnly = prefixCheckbox.checked;
          if (action) {
            initialConfig.specialCases[sol.from] = { action, value, prefixOnly };
            editStatus.setContent('Special case added!');
            editScreen.render();
            setTimeout(() => returnToMainScreen(editScreen), 500);
          } else {
            editStatus.setContent('Please select an action with Space.');
            editScreen.render();
          }
        });

        editScreen.key(['tab'], () => {
          const current = editScreen.focused;
          if (current === valueInput) actionList.focus();
          else if (current === actionList) prefixCheckbox.focus();
          else valueInput.focus();
          editScreen.render();
        });

        editScreen.key(['h'], () => returnToMainScreen(editScreen));
        editScreen.key(['q'], () => returnToMainScreen(editScreen));

        valueInput.focus();
        editScreen.render();
      });

      commScreen.key(['h'], () => returnToMainScreen(commScreen));
      commScreen.key(['q'], () => returnToMainScreen(commScreen));

      commList.focus();
      commScreen.render();
    } else if (index === 3) { // Edit config
      screen.destroy();
      const editScreen = blessed.screen({ smartCSR: true, title: 'Edit Config' });
      if (!initialConfig.directories.length && !Object.keys(initialConfig.aliases).length && !Object.keys(initialConfig.specialCases).length) {
        const editorPrompt = blessed.prompt({
          parent: editScreen,
          top: 'center',
          left: 'center',
          width: '50%',
          height: 'shrink',
          border: { type: 'line' },
          style: { border: { fg: 'cyan' }, fg: 'white' },
          label: 'No config found',
          content: 'Launch editor to create monocheck.config.json?',
        });

        editorPrompt.readInput('Editor (nano/vim, default: nano): ', 'nano', (err, editor) => {
          const editorCmd = editor?.trim() === 'vim' ? 'vim' : 'nano';
          if (!existsSync(CONFIG_PATH)) {
            writeFileSync(CONFIG_PATH, JSON.stringify({ directories: [], aliases: {}, specialCases: {} }, null, 2));
          }
          editScreen.destroy();
          spawnSync(editorCmd, [CONFIG_PATH], { stdio: 'inherit' });
          try {
            initialConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
          } catch (e) {
            console.log(kleur.yellow('Config not created or invalid. Returning to menu.'));
          }
          returnToMainScreen(editScreen);
        });
      } else {
        const editList = blessed.list({
          parent: editScreen,
          top: 1,
          left: 1,
          width: '90%',
          height: '50%',
          border: { type: 'line' },
          style: { border: { fg: 'cyan' }, selected: { bg: 'blue' }, item: { fg: 'white' } },
          keys: true,
          items: [
            `Directories (${initialConfig.directories.length})`,
            `Aliases (${Object.keys(initialConfig.aliases).length})`,
            `Special Cases (${Object.keys(initialConfig.specialCases).length})`,
            'Edit in editor',
          ],
          interactive: true,
        });

        const editStatus = blessed.text({
          parent: editScreen,
          bottom: 0,
          left: 1,
          width: '100%',
          height: '20%',
          content: 'Select to edit, h for home, q to return',
          style: { fg: 'yellow' },
        });

        editList.on('select', (item, i) => {
          editScreen.destroy();
          if (i === 0) { // Edit directories
            const dirScreen = blessed.screen({ smartCSR: true, title: 'Edit Directories' });
            const excluded = new Set<number>();
            const dirList = blessed.list({
              parent: dirScreen,
              top: 1,
              left: 1,
              width: '90%',
              height: '50%',
              border: { type: 'line' },
              style: { border: { fg: 'cyan' }, selected: { bg: 'blue' }, item: { fg: 'white' } },
              keys: true,
              items: initialConfig.directories.map((d, i) => `${i + 1}. ${d.path} (tsconfig: ${d.tsconfig})`),
              interactive: true,
            });

            dirScreen.key(['space'], () => {
              const index = dirList.selected;
              if (excluded.has(index)) {
                excluded.delete(index);
                dirList.items[index].style.fg = 'green';
              } else {
                excluded.add(index);
                dirList.items[index].style.fg = 'gray';
              }
              dirScreen.render();
            });

            dirScreen.key(['enter'], () => {
              initialConfig.directories = initialConfig.directories.filter((_, i) => !excluded.has(i));
              returnToMainScreen(dirScreen);
            });

            dirScreen.key(['h'], () => returnToMainScreen(dirScreen));
            dirScreen.key(['q'], () => returnToMainScreen(dirScreen));

            dirList.items.forEach((item: any) => (item.style.fg = 'green'));
            dirList.focus();
            dirScreen.render();
          } else if (i === 1) {
            console.log(kleur.yellow('Alias editing not yet implemented in TUI. Modify monocheck.config.json manually.'));
            returnToMainScreen(editScreen);
          } else if (i === 2) {
            const specialScreen = blessed.screen({ smartCSR: true, title: 'Edit Special Cases' });
            const specialList = blessed.list({
              parent: specialScreen,
              top: 1,
              left: 1,
              width: '90%',
              height: '50%',
              border: { type: 'line' },
              style: { border: { fg: 'cyan' }, selected: { bg: 'blue' }, item: { fg: 'white' } },
              keys: true,
              items: Object.entries(initialConfig.specialCases).map(([k, v]) => `${k}: ${v.action}${v.value ? ` → ${v.value}` : ''}${v.prefixOnly ? ' (prefix)' : ''}`),
              interactive: true,
            });

            specialScreen.key(['d'], () => {
              const index = specialList.selected;
              const key = Object.keys(initialConfig.specialCases)[index];
              delete initialConfig.specialCases[key];
              specialList.removeItem(index);
              specialScreen.render();
            });

            specialScreen.key(['enter'], () => returnToMainScreen(specialScreen));
            specialScreen.key(['h'], () => returnToMainScreen(specialScreen));
            specialScreen.key(['q'], () => returnToMainScreen(specialScreen));

            specialList.focus();
            specialScreen.render();
          } else if (i === 3) { // Edit in editor
            const editorPrompt = blessed.prompt({
              parent: editScreen,
              top: 'center',
              left: 'center',
              width: '50%',
              height: 'shrink',
              border: { type: 'line' },
              style: { border: { fg: 'cyan' }, fg: 'white' },
              label: 'Edit Config',
              content: 'Launch editor to modify monocheck.config.json?',
            });

            editorPrompt.readInput('Editor (nano/vim, default: nano): ', 'nano', (err, editor) => {
              const editorCmd = editor?.trim() === 'vim' ? 'vim' : 'nano';
              editScreen.destroy();
              spawnSync(editorCmd, [CONFIG_PATH], { stdio: 'inherit' });
              try {
                initialConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
              } catch (e) {
                console.log(kleur.yellow('Config invalid after editing. Returning to menu.'));
              }
              returnToMainScreen(editScreen);
            });
          }
        });

        editScreen.key(['h'], () => returnToMainScreen(editScreen));
        editScreen.key(['q'], () => returnToMainScreen(editScreen));

        editList.focus();
        editScreen.render();
      }
    } else if (index === 4 && AUTO_FIX) { // Fix issues
      screen.destroy();
      config = initialConfig;
      const fixScreen = blessed.screen({ smartCSR: true, title: 'Fix Issues' });
      const logBox = blessed.log({
        parent: fixScreen,
        top: 1,
        left: 1,
        width: '90%',
        height: '50%',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' }, fg: 'white' },
        scrollable: true,
        scrollbar: { bg: 'blue' },
      });
      const issuesByDir = await scanAndReport(logBox);
      displayFixTui(issuesByDir);
    } else if ((index === 4 && !AUTO_FIX) || (index === 5 && AUTO_FIX)) { // Save and exit
      screen.destroy();
      resolvePromise(initialConfig);
    }
  });

  screen.key(['h'], () => screen.render()); // Already on home screen
  screen.key(['q'], () => {
    if (!existsSync(CONFIG_PATH) && !initialConfig.directories.length && !Object.keys(initialConfig.aliases).length && !Object.keys(initialConfig.specialCases).length) {
      console.log(kleur.yellow('No configuration saved. To create monocheck.config.json manually, use:'));
      console.log(kleur.cyan(`echo '{\n  "directories": [],\n  "aliases": {},\n  "specialCases": {}\n}' > ${CONFIG_PATH}`));
    } else {
      writeFileSync(CONFIG_PATH, JSON.stringify(initialConfig, null, 2));
      console.log(kleur.green(`Config saved to ${CONFIG_PATH}`));
    }
    process.exit(0);
  });

  list.focus();
  screen.render();

  return promise;
}

// TUI Config Setup
async function initializeConfigWithTui(): Promise<Config> {
  mainScreen = blessed.screen({ smartCSR: true, title: 'monocheck Config Setup' });
  const configPromise = initializeMainMenu(mainScreen);
  return configPromise.then((cfg) => {
    if (!cfg.directories.length && !Object.keys(cfg.aliases).length && !Object.keys(cfg.specialCases).length) {
      console.log(kleur.yellow('No configuration saved. To create monocheck.config.json manually, use:'));
      console.log(kleur.cyan(`echo '{\n  "directories": [],\n  "aliases": {},\n  "specialCases": {}\n}' > ${CONFIG_PATH}`));
      process.exit(0);
    }
    return cfg;
  });
}

// TUI Report Viewer
function displayReportTui(issuesByDir: { [dir: string]: ImportIssue[] }) {
  const reportScreen = blessed.screen({ smartCSR: true, title: 'monocheck Reports' });

  const reportList = blessed.list({
    parent: reportScreen,
    top: 1,
    left: 1,
    width: '30%',
    height: '80%',
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, selected: { bg: 'blue' }, item: { fg: 'white' } },
    keys: true,
    items: Object.keys(issuesByDir).map((dir) => dir),
    interactive: true,
  });

  const issueBox = blessed.list({
    parent: reportScreen,
    top: 1,
    left: '30%+2',
    width: '70%-2',
    height: '80%',
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, selected: { bg: 'blue' }, item: { fg: 'white' } },
    keys: true,
    scrollable: true,
    interactive: true,
  });

  const status = blessed.text({
    parent: reportScreen,
    bottom: 0,
    left: 1,
    width: '100%',
    height: '20%',
    content: 'Tab to switch panels, h for home, q to return',
    style: { fg: 'yellow' },
  });

  reportList.on('select', (item, index) => {
    const dir = Object.keys(issuesByDir)[index];
    const issues = issuesByDir[dir];
    issueBox.setItems(
      issues.map((i) => `${i.file}:${i.line} - ${i.importPath} (${i.issue}) ${i.suggestion ? `[${i.suggestion}]` : ''}`),
    );
    issueBox.focus();
    reportScreen.render();
  });

  reportScreen.key(['tab'], () => {
    if (reportScreen.focused === reportList) issueBox.focus();
    else reportList.focus();
    reportScreen.render();
  });

  reportScreen.key(['h'], () => returnToMainScreen(reportScreen));
  reportScreen.key(['q'], () => returnToMainScreen(reportScreen));
  reportList.focus();
  reportScreen.render();
}

// TUI Fix Viewer
function displayFixTui(issuesByDir: { [dir: string]: ImportIssue[] }) {
  const fixScreen = blessed.screen({ smartCSR: true, title: 'Fix Issues' });

  const reportList = blessed.list({
    parent: fixScreen,
    top: 1,
    left: 1,
    width: '30%',
    height: '80%',
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, selected: { bg: 'blue' }, item: { fg: 'white' } },
    keys: true,
    items: Object.keys(issuesByDir).map((dir) => dir),
    interactive: true,
  });

  const issueBox = blessed.list({
    parent: fixScreen,
    top: 1,
    left: '30%+2',
    width: '70%-2',
    height: '80%',
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, selected: { bg: 'blue' }, item: { fg: 'white' } },
    keys: true,
    scrollable: true,
    interactive: true,
  });

  const status = blessed.text({
    parent: fixScreen,
    bottom: 0,
    left: 1,
    width: '100%',
    height: '20%',
    content: 'Tab to switch panels, Enter to fix, h for home, q to return',
    style: { fg: 'yellow' },
  });

  reportList.on('select', (item, index) => {
    const dir = Object.keys(issuesByDir)[index];
    const issues = issuesByDir[dir];
    issueBox.setItems(
      issues.map((i) => `${i.file}:${i.line} - ${i.importPath} (${i.issue}) ${i.suggestion ? `[${i.suggestion}]` : ''}${i.fixed ? ' [Fixed]' : ''}`),
    );
    issueBox.focus();
    fixScreen.render();
  });

  issueBox.on('select', async (item, index) => {
    const dir = reportList.getItem(reportList.selected)?.content;
    if (!dir) return;
    const issue = issuesByDir[dir][index];
    if (!issue.fixed && issue.suggestion) {
      const project = new Project({ tsConfigFilePath: config!.directories.find(d => d.path === dir)!.tsconfig });
      const file = project.getSourceFile(issue.file)!;
      const importDecl = file.getImportDeclarations().find(d => d.getStartLineNumber() === issue.line);
      if (importDecl && !issue.commented) {
        const newImportPath = issue.suggestion.match(/from '([^']+)'/)?.[1];
        if (newImportPath) {
          importDecl.setModuleSpecifier(newImportPath);
          await file.save();
          issue.fixed = true;
          issueBox.setItem(index, `${issue.file}:${issue.line} - ${issue.importPath} (${issue.issue}) [Fixed]`);
          status.setContent(`Fixed: ${issue.file}:${issue.line}`);
          fixScreen.render();
        }
      } else if (issue.commented) {
        const fullText = file.getFullText();
        const lines = fullText.split('\n');
        const newImportPath = issue.suggestion.match(/from '([^']+)'/)?.[1];
        if (newImportPath) {
          lines[issue.line - 1] = lines[issue.line - 1].replace(/^\s*\/\/+\s*|^#+\s*|\/\*|\*\//g, '').replace(issue.importPath, newImportPath);
          file.replaceWithText(lines.join('\n'));
          await file.save();
          issue.fixed = true;
          issueBox.setItem(index, `${issue.file}:${issue.line} - ${issue.importPath} (${issue.issue}) [Fixed]`);
          status.setContent(`Fixed commented import: ${issue.file}:${issue.line}`);
          fixScreen.render();
        }
      }
    }
  });

  fixScreen.key(['tab'], () => {
    if (fixScreen.focused === reportList) issueBox.focus();
    else reportList.focus();
    fixScreen.render();
  });

  fixScreen.key(['h'], () => returnToMainScreen(fixScreen));
  fixScreen.key(['q'], () => returnToMainScreen(fixScreen));
  reportList.focus();
  fixScreen.render();
}

// Scan and Report Logic
async function scanAndReport(logBox: blessed.Widgets.Log): Promise<{ [dir: string]: ImportIssue[] }> {
  const AUTO_FIX = process.argv.includes('--fix');
  const DRY_RUN = process.argv.includes('--dry-run');
  const communitySolutions = await fetchCommunitySolutions();
  const issuesByDir: { [dir: string]: ImportIssue[] } = {};

  for (const dir of config!.directories) {
    logBox.log(kleur.cyan(`Starting monocheck for ${dir.path}`));
    const project = new Project({ tsConfigFilePath: dir.tsconfig });
    let files = project.getSourceFiles(`${dir.path}/**/*.{ts,tsx}`);
    if (files.length === 0) {
      logBox.log(kleur.yellow(`No .ts/.tsx files found in ${dir.path}. Trying broader pattern...`));
      files = project.getSourceFiles(`${dir.path}/**/*.{ts,tsx,js,jsx}`);
    }

    const issues: ImportIssue[] = [];
    for (const file of files) {
      const filePath = file.getFilePath();
      const relativeFilePath = relative(process.cwd(), filePath);
      logBox.log(kleur.yellow(`Processing: ${relativeFilePath}`));
      const imports = file.getImportDeclarations();
      let fileModified = false;

      for (const importDecl of imports) {
        const importPath = importDecl.getModuleSpecifierValue();
        const line = importDecl.getStartLineNumber();

        if (!importPath.startsWith('.') && !importPath.startsWith('@')) continue;
        if (importPath.startsWith('@') && !Object.keys(config!.aliases).some((a) => importPath.startsWith(a))) {
          const rootPkg = importPath.split('/')[0];
          if (dir.dependencies?.[rootPkg] || existsSync(resolve('node_modules', rootPkg))) continue;
        }

        const resolvedPath = resolveImportPath(importPath, file);
        const specialCase = Object.entries(config!.specialCases).find(([key]) =>
          config!.specialCases[key].prefixOnly ? importPath.startsWith(key) : importPath === key,
        );
        let suggestionFromCommunity: string | null = null;
        const communityMatch = communitySolutions.find((sol) =>
          sol.prefixOnly ? importPath.startsWith(sol.from) : importPath === sol.from,
        );
        if (communityMatch) {
          suggestionFromCommunity =
            communityMatch.action === 'rename'
              ? `Rename to: import ... from '${communityMatch.to}'`
              : `Replace with: import from '${communityMatch.to}' (${communityMatch.description})`;
        }

        if (specialCase) {
          const [key, special] = specialCase;
          let suggestion: string | null = suggestionFromCommunity;
          let newImportPath: string | undefined;

          if (special.action === 'rename') {
            newImportPath = special.prefixOnly ? importPath.replace(key, special.value!) : special.value;
            suggestion = suggestion || `Rename to: import ... from '${newImportPath}'`;
          } else if (special.action === 'replace-method') {
            newImportPath = special.value;
            suggestion = suggestion || `Replace with: import { useUser } from '${newImportPath}' (adjust usage accordingly)`;
          } else {
            suggestion = 'Excluded from checks';
          }

          const issue: ImportIssue = { file: relativeFilePath, line, importPath, issue: `Special case: ${special.action}`, suggestion };
          if (AUTO_FIX && newImportPath && special.action !== 'exclude' && !DRY_RUN) {
            importDecl.setModuleSpecifier(newImportPath);
            issue.fixed = true;
            fileModified = true;
          }
          issues.push(issue);
          continue;
        }

        if (importPath.startsWith('.')) {
          const suggestedAlias = findMatchingAlias(resolvedPath);
          if (suggestedAlias) {
            const relativeImportPath = convertToAliasPath(resolvedPath!, suggestedAlias);
            const issue: ImportIssue = {
              file: relativeFilePath,
              line,
              importPath,
              issue: `Relative import should use alias '${suggestedAlias}'`,
              suggestion: relativeImportPath ? `Change to: import ... from '${relativeImportPath}'` : suggestionFromCommunity,
            };
            if (AUTO_FIX && relativeImportPath && !DRY_RUN) {
              importDecl.setModuleSpecifier(relativeImportPath);
              issue.fixed = true;
              fileModified = true;
            }
            issues.push(issue);
          } else if (!resolvedPath) {
            issues.push({
              file: relativeFilePath,
              line,
              importPath,
              issue: `Relative import '${importPath}' cannot be resolved`,
              suggestion: suggestionFromCommunity || `File not found at ${resolve(dirname(filePath), importPath)}`,
            });
          }
        } else if (importPath.startsWith('@')) {
          const aliasRoot = importPath.split('/')[0];
          const fullAlias = importPath.includes('/') ? importPath.split('/').slice(0, 2).join('/') : aliasRoot;

          if (!config!.aliases[fullAlias] && !config!.aliases[aliasRoot]) {
            const rootPkg = aliasRoot;
            const isSpecialCaseRoot = Object.keys(config!.specialCases).some((key) =>
              config!.specialCases[key].prefixOnly ? key.startsWith(rootPkg) : key === rootPkg,
            );
            const suggestion =
              suggestionFromCommunity ||
              (isSpecialCaseRoot || dir.dependencies?.[rootPkg]
                ? null
                : `Module '${rootPkg}' not found. Run: bun add ${rootPkg}`);
            issues.push({
              file: relativeFilePath,
              line,
              importPath,
              issue: `Unknown alias '${fullAlias}' or '${aliasRoot}'`,
              suggestion: suggestion || 'Verify alias in tsconfig.json or use relative path',
            });
          } else {
            const expectedPath = config!.aliases[fullAlias]?.path || config!.aliases[aliasRoot]?.path;
            if (resolvedPath && expectedPath && !resolvedPath.startsWith(expectedPath)) {
              const suggestedAlias = findMatchingAlias(resolvedPath);
              const relativeImportPath = suggestedAlias ? convertToAliasPath(resolvedPath, suggestedAlias) : null;
              const issue: ImportIssue = {
                file: relativeFilePath,
                line,
                importPath,
                issue: `Alias '${importPath}' resolves incorrectly`,
                suggestion: relativeImportPath
                  ? `Change to: import ... from '${relativeImportPath}'`
                  : suggestionFromCommunity || `Verify path for '${importPath}'`,
              };
              if (AUTO_FIX && relativeImportPath && !DRY_RUN) {
                importDecl.setModuleSpecifier(relativeImportPath);
                issue.fixed = true;
                fileModified = true;
              }
              issues.push(issue);
            }
          }
        }
      }

      const commentedImports = findCommentedImports(file);
      for (const { text, line, commentType } of commentedImports) {
        const importMatch = text.match(/import\s+.*\s+from\s+['"]([^'"]+)['"]/);
        if (!importMatch) {
          issues.push({ file: relativeFilePath, line, importPath: text, issue: `Invalid commented import syntax`, suggestion: 'Manually review and fix', commented: true });
          continue;
        }

        const importPath = importMatch[1];
        const resolvedPath = resolveImportPath(importPath, file);
        const specialCase = Object.entries(config!.specialCases).find(([key]) =>
          config!.specialCases[key].prefixOnly ? importPath.startsWith(key) : importPath === key,
        );
        let suggestionFromCommunity: string | null = null;
        const communityMatch = communitySolutions.find((sol) =>
          sol.prefixOnly ? importPath.startsWith(sol.from) : importPath === sol.from,
        );
        if (communityMatch) {
          suggestionFromCommunity =
            communityMatch.action === 'rename'
              ? `Uncomment and rename to: import ... from '${communityMatch.to}'`
              : `Uncomment and replace with: import from '${communityMatch.to}' (${communityMatch.description})`;
        }

        if (specialCase) {
          const [key, special] = specialCase;
          let suggestion: string | null = suggestionFromCommunity;
          let newImportPath: string | undefined;

          if (special.action === 'rename') {
            newImportPath = special.prefixOnly ? importPath.replace(key, special.value!) : special.value;
            suggestion = suggestion || `Uncomment and rename to: ${text.replace(/^\s*\/\/+\s*|^#+\s*|\/\*|\*\//g, '').replace(importPath, newImportPath)}`;
          } else if (special.action === 'replace-method') {
            newImportPath = special.value;
            suggestion = suggestion || `Uncomment and replace with: import { useUser } from '${newImportPath}' (adjust usage accordingly)`;
          } else {
            suggestion = 'Excluded from checks';
          }

          const issue: ImportIssue = { file: relativeFilePath, line, importPath, issue: `Commented special case: ${special.action}`, suggestion, commented: true };
          if (AUTO_FIX && newImportPath && special.action !== 'exclude' && !DRY_RUN) {
            const fullText = file.getFullText();
            const lines = fullText.split('\n');
            lines[line - 1] = text.replace(/^\s*\/\/+\s*|^#+\s*|\/\*|\*\//g, '').replace(importPath, newImportPath);
            file.replaceWithText(lines.join('\n'));
            issue.fixed = true;
            fileModified = true;
          }
          issues.push(issue);
          continue;
        }

        if (!resolvedPath) {
          const rootPkg = importPath.split('/')[0].startsWith('@') ? importPath.split('/').slice(0, 2).join('/') : importPath.split('/')[0];
          const isSpecialCaseRoot = Object.keys(config!.specialCases).some((key) =>
            config!.specialCases[key].prefixOnly ? key.startsWith(rootPkg) : key === rootPkg,
          );
          const suggestion =
            suggestionFromCommunity ||
            (isSpecialCaseRoot || dir.dependencies?.[rootPkg] ? 'Uncomment to use' : `Module '${rootPkg}' not found. Run: bun add ${rootPkg}`);
          issues.push({ file: relativeFilePath, line, importPath, issue: `Commented import '${importPath}' cannot be resolved`, suggestion, commented: true });
          continue;
        }

        const suggestedAlias = findMatchingAlias(resolvedPath);
        const newImportPath = suggestedAlias ? convertToAliasPath(resolvedPath, suggestedAlias) : importPath;
        const issue: ImportIssue = {
          file: relativeFilePath,
          line,
          importPath,
          issue: suggestedAlias ? `Commented import should use alias '${suggestedAlias}'` : `Commented import has no matching alias`,
          suggestion: suggestionFromCommunity || `Uncomment and change to: ${text.replace(/^\s*\/\/+\s*|^#+\s*|\/\*|\*\//g, '').replace(importPath, newImportPath)}`,
          commented: true,
        };
        if (AUTO_FIX && newImportPath && !DRY_RUN) {
          const fullText = file.getFullText();
          const lines = fullText.split('\n');
          lines[line - 1] = text.replace(/^\s*\/\/+\s*|^#+\s*|\/\*|\*\//g, '').replace(importPath, newImportPath);
          file.replaceWithText(lines.join('\n'));
          issue.fixed = true;
          fileModified = true;
        }
        issues.push(issue);
      }

      if (fileModified && AUTO_FIX && !DRY_RUN) {
        await file.save();
        logBox.log(kleur.green(`  Saved changes to ${relativeFilePath}`));
      }
    }

    issuesByDir[dir.path] = issues;
    const report = {
      totalFiles: files.length,
      totalIssues: issues.length,
      standardIssues: issues.filter((i) => !i.commented).length,
      commentedIssues: issues.filter((i) => i.commented).length,
      fixedIssues: issues.filter((i) => i.fixed).length,
      issues,
    };
    writeFileSync(dir.report, JSON.stringify(report, null, 2));
    logBox.log(kleur.cyan(`Completed monocheck for ${files.length} files in ${dir.path}`));
    logBox.log(kleur.gray(`Total issues: ${issues.length} (Standard: ${report.standardIssues}, Commented: ${report.commentedIssues})`));
    logBox.log(kleur.green(`Fixed issues: ${report.fixedIssues}`));
  }

  return issuesByDir;
}

// Main monocheck Logic
async function monocheck() {
  config = await initializeConfigWithTui();
  if (!config?.directories.length) {
    console.log(kleur.red('No directories configured. Please run setup to configure directories.'));
    process.exit(1);
  }
}

// Entry Point
monocheck().catch((err) => {
  console.error(kleur.red('Error running monocheck:'), err);
  process.exit(1);
});