// 1. Imports and Types
import { Project, SourceFile } from 'ts-morph';
import { resolve, relative, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import kleur from 'kleur';
import blessed from 'blessed';
import {
  fetchCommunitySolutions,
  scanMonorepo,
  extractAliases,
  resolveImportPath,
  findMatchingAlias,
  convertToAliasPath,
  findCommentedImports,
} from './helpers';

// 2. Configuration and Constants
const CONFIG_PATH = './monocheck.config.json';

// Interfaces
interface AliasConfig { path: string; description: string; }
interface DirectoryConfig { path: string; tsconfig: string; report: string; packageJson?: string; dependencies?: { [key: string]: string }; workspaceName?: string; }
interface SpecialCase { action: 'rename' | 'replace-method' | 'exclude'; value?: string; prefixOnly?: boolean; }
interface Config { directories: DirectoryConfig[]; aliases: { [key: string]: AliasConfig }; specialCases: { [key: string]: SpecialCase }; }
interface CommunitySolution { from: string; to: string; action: 'rename' | 'replace-method' | 'exclude'; description: string; prefixOnly?: boolean; category: string; priority: number; examples: { before: string; after: string }[]; }
interface ImportIssue { file: string; line: number; importPath: string; issue: string; suggestion: string | null; fixed?: boolean; commented?: boolean; userChoice?: string; }

interface BlessedListWithItems extends blessed.Widgets.ListElement {
  items: blessed.Widgets.Node[];
  selected: number;
}

// Change Tracker for Undo
class ChangeTracker {
  private changes: Array<{ file: string; originalContent: string; newContent?: string }> = [];

  backup(file: string, content: string) {
    if (!this.changes.find(c => c.file === file)) {
      this.changes.push({ file, originalContent: content });
    }
  }

  recordChange(file: string, newContent: string) {
    const change = this.changes.find(c => c.file === file);
    if (change) change.newContent = newContent;
  }

  undo() {
    for (const change of this.changes) {
      if (change.newContent) {
        writeFileSync(change.file, change.originalContent);
      }
    }
    this.changes = this.changes.filter(c => !c.newContent);
    return this.changes.length === 0;
  }

  hasChanges(): boolean {
    return this.changes.some(c => c.newContent);
  }
}

// Module-Level Config
let config: Config | undefined;
let mainScreen: blessed.Widgets.Screen;
let activeProjects: Project[] = [];
const changeTracker = new ChangeTracker();
const isDebug = process.argv.includes('--debug');

// Return to Main Screen Function
function returnToMainScreen(currentScreen: blessed.Widgets.Screen) {
  if (isDebug) console.log('DEBUG: Returning to main screen from', currentScreen.title);
  activeProjects = [];
  currentScreen.destroy();
  mainScreen = blessed.screen({ smartCSR: true, title: 'monocheck Config Setup' });
  initializeMainMenu(mainScreen);
}

// Main Menu Setup
function initializeMainMenu(screen: blessed.Widgets.Screen) {
  let initialConfig: Config = existsSync(CONFIG_PATH)
    ? JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    : { directories: [], aliases: {}, specialCases: {} };
  if (!initialConfig.specialCases) initialConfig.specialCases = {};

  const list = blessed.list({
    parent: screen,
    top: 1,
    left: 1,
    width: '90%',
    height: '50%',
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, selected: { bg: 'blue' }, item: { fg: 'white' } },
    scrollbar: {
      style: {
        bg: 'blue'
      }
    },
    keys: true,
    items: ['1. Scan monorepo', '2. Add special case', '3. Community solutions', '4. Edit config', '5. Fix issues', '6. Save and exit'],
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

  list.on('select', async (item: any, blessed: { screen: (arg0: { smartCSR: boolean; title: string; }) => any; list: (arg0: { parent: any; top: number; left: number; width: string; height: string | number; border: { type: string; } | { type: string; } | { type: string; } | { type: string; } | { type: string; } | { type: string; } | { type: string; }; style: { border: { fg: string; }; selected: { bg: string; }; item: { fg: string; }; } | { border: { fg: string; }; selected: { bg: string; }; item: { fg: string; }; } | { border: { fg: string; }; selected: { bg: string; }; item: { fg: string; }; } | { border: { fg: string; }; selected: { bg: string; }; item: { fg: string; }; } | { border: { fg: string; }; selected: { bg: string; }; item: { fg: string; }; } | { border: { fg: string; }; selected: { bg: string; }; item: { fg: string; }; } | { border: { fg: string; }; selected: { bg: string; }; item: { fg: string; }; }; keys: boolean; mouse?: boolean; items: string[] | string[]; interactive: boolean; scrollable?: boolean; scrollbar?: { style: { bg: string; }; } | { style: { bg: string; }; } | { style: { bg: string; }; }; autoSelect?: boolean; selected?: number; }) => any; log: (arg0: { parent: any; top: string; left: number; width: string; height: string; border: { type: string; }; style: { border: { fg: string; }; fg: string; }; scrollable: boolean; scrollbar: { style: { bg: string; }; }; }) => any; progressbar: (arg0: { parent: any; top: string; left: number; width: string; height: number; border: { type: string; }; style: { border: { fg: string; }; bar: { bg: string; }; }; filled: number; }) => blessed.Widgets.ProgressBarElement; text: (arg0: { parent: any; bottom?: number; left: number; width?: string; height?: string; content: string; style: { fg: string; } | { fg: string; } | { fg: string; } | { fg: string; } | { fg: string; } | { fg: string; } | { fg: string; } | { fg: string; } | { fg: string; } | { fg: string; } | { fg: string; }; top?: number; }) => void; form: (arg0: { parent: any; top: number; left: number; width: string; height: string; border: { type: string; } | { type: string; }; style: { border: { fg: string; }; } | { border: { fg: string; }; }; keys: boolean; }) => any; textbox: (arg0: { parent: any; top: number; left: number; width: string; height: number; inputOnFocus: boolean; border: { type: string; } | { type: string; } | { type: string; }; style: { fg: string; border: { fg: string; }; } | { fg: string; border: { fg: string; }; } | { fg: string; border: { fg: string; }; }; value?: string; }) => any; checkbox: (arg0: { parent: any; top: number; left: number; content: string; mouse: boolean; style: { fg: string; } | { fg: string; }; checked?: boolean | undefined; }) => any; box: (arg0: { parent: any; top: string; left: number; width: string; height: string; border: { type: string; }; style: { border: { fg: string; }; fg: string; }; content: string; }) => any; prompt: (arg0: { parent: any; top: string; left: string; width: string; height: string; border: { type: string; } | { type: string; }; style: { border: { fg: string; }; fg: string; } | { border: { fg: string; }; fg: string; }; label: string; content: string; }) => any; }.Widgets: any.Element: any, index: number) => {
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
        mouse: true,
        items: directories.map((d, i) => `${i + 1}. ${d.workspaceName || d.path.slice(0, 50)} (tsconfig: ${d.tsconfig.slice(0, 50)})`),
        interactive: true,
        scrollable: true,
        scrollbar: {
          style: { 
            bg: 'blue'
          }
        },
      });

      const logBox = blessed.log({
        parent: dirScreen,
        top: '50%+2',
        left: 1,
        width: '90%',
        height: '20%',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' }, fg: 'white' },
        scrollable: true,
        scrollbar: {
          style: {
            bg: 'blue'
          }
        }, 
      });

      const progressBar = blessed.progressbar({
        parent: dirScreen,
        top: '70%+2',
        left: 1,
        width: '90%',
        height: 3,
        border: { type: 'line' },
        style: { border: { fg: 'cyan' }, bar: { bg: 'green' } },
        filled: 0,
      }) as blessed.Widgets.ProgressBarElement;

      const dirStatus = blessed.text({
        parent: dirScreen,
        bottom: 0,
        left: 1,
        width: '100%',
        height: '10%',
        content: 'Space to toggle exclusion, Enter to scan, h for home, q to return',
        style: { fg: 'yellow' },
      });

      dirScreen.key(['space'], () => {
        const index = dirList.selected;
        if (excluded.has(index)) {
          excluded.delete(index);
          (dirList as BlessedListWithItems).items[index].style.fg = 'green';
        } else {
          excluded.add(index);
          (dirList as BlessedListWithItems).items[index].style.fg = 'gray';
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
        try {
          const issuesByDir = await scanAndReport(logBox, progressBar);
          dirScreen.destroy();
          displayReportTui(issuesByDir);
        } catch (err) {
          logBox.log(kleur.red(`Scan failed: ${err}`));
          dirScreen.render();
        }
      });

      dirScreen.key(['h'], () => returnToMainScreen(dirScreen));
      dirScreen.key(['q'], () => returnToMainScreen(dirScreen));

      (dirList as BlessedListWithItems).items.forEach((item) => (item.style.fg = 'green'));
      dirList.focus();
      dirScreen.render();
    } else if (index === 1) { // Add special case
      screen.destroy();
      const specialScreen = blessed.screen({ smartCSR: true, title: 'Add Special Case' });
      let lastRender = 0;
      const specialScreenRenderDebounced = () => {
        const now = Date.now();
        if (now - lastRender > 50) {
          specialScreen.render();
          lastRender = now;
        }
      };
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
        mouse: true,
        autoSelect: true,
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
        content: 'Tab to navigate, Enter to submit, h for home, q to return',
        style: { fg: 'yellow' },
      });

      actionList.on('select', () => {
        (actionList as BlessedListWithItems).items.forEach((item: blessed.Widgets.Node, i: number) => {
          item.style.fg = i === actionList.selected() ? 'green' : 'white';
        });
        specialScreenRenderDebounced();
      });

      form.on('submit', () => {
        const importPath = importInput.getValue().trim();
        const action = actionList.getItem(actionList.selected())?.content as 'rename' | 'replace-method' | 'exclude';
        const value = valueInput.getValue().trim() || undefined;
        const prefixOnly = prefixCheckbox.checked;
        if (importPath && action) {
          initialConfig.specialCases[importPath] = { action, value, prefixOnly };
          try {
            writeFileSync(CONFIG_PATH, JSON.stringify(initialConfig, null, 2));
            specialStatus.setContent(kleur.green(`Special case saved to ${CONFIG_PATH}`));
          } catch (err) {
            specialStatus.setContent(kleur.red(`Failed to save config: ${err}`));
          }
          specialScreenRenderDebounced();
          setTimeout(() => returnToMainScreen(specialScreen), 1000);
        } else {
          specialStatus.setContent(kleur.red('Please fill in import path and select an action.'));
          specialScreenRenderDebounced();
        }
      });

      specialScreen.key(['enter'], () => form.submit());

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
        status.setContent(kleur.red('No community solutions available. Check network and try again.'));
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
        mouse: true,
        items: solutions.map((s) => `${s.from.slice(0, 50)} → ${s.to.slice(0, 50)} (${s.description}) [${s.category}]`),
        interactive: true,
        scrollable: true,
        scrollbar: {
          style: {
            bg: 'blue'
          }
        }
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
        content: 'Space to select, Enter to customize/add, e to edit, h for home',
        style: { fg: 'yellow' },
      });
    
      let lastRender = 0;
      const renderDebounced = () => {
        const now = Date.now();
        if (now - lastRender > 50) {
          commScreen.render();
          lastRender = now;
        }
      };
    
      commList.on('select', (item, i) => {
        const sol = solutions[i];
        exampleBox.setContent(`Before: ${sol.examples[0]?.before || 'N/A'}\nAfter: ${sol.examples[0]?.after || 'N/A'}`);
        renderDebounced();
      });
    
      commScreen.key(['space'], () => {
        const index = commList.selected();
        if (selected.has(index)) {
          selected.delete(index);
          (commList as BlessedListWithItems).items[index].style.fg = 'white';
        } else {
          selected.add(index);
          (commList as BlessedListWithItems).items[index].style.fg = 'green';
        }
        renderDebounced();
      });
    
      const openEditScreen = (sol: CommunitySolution, index: number) => {
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
        const valueInput = blessed.textbox({
          parent: form,
          top: 3,
          left: 1,
          width: '80%',
          height: 3,
          inputOnFocus: true,
          border: { type: 'line' },
          style: { fg: 'white', border: { fg: 'gray' } },
          value: sol.to,
        });
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
          mouse: true,
          autoSelect: true,
          interactive: true,
          selected: ['rename', 'replace-method', 'exclude'].indexOf(sol.action),
        });
        const prefixCheckbox = blessed.checkbox({
          parent: form,
          top: 12,
          left: 1,
          content: 'Prefix only?',
          mouse: true,
          style: { fg: 'white' },
          checked: sol.prefixOnly,
        });
    
        const editStatus = blessed.text({
          parent: editScreen,
          bottom: 0,
          left: 1,
          width: '100%',
          height: '20%',
          content: 'Tab to navigate, Enter to add, h for home',
          style: { fg: 'yellow' },
        });
    
        actionList.on('select', () => {
          (actionList as BlessedListWithItems).items.forEach((item: blessed.Widgets.Node, i: number) => {
            item.style.fg = i === actionList.selected() ? 'green' : 'white';
          });
          editScreen.render();
        });
    
        form.on('submit', () => {
          const value = valueInput.getValue().trim() || undefined;
          const action = actionList.getItem(actionList.selected())?.content as 'rename' | 'replace-method' | 'exclude';
          const prefixOnly = prefixCheckbox.checked;
          if (action) {
            initialConfig.specialCases[sol.from] = { action, value, prefixOnly };
            try {
              writeFileSync(CONFIG_PATH, JSON.stringify(initialConfig, null, 2));
              editStatus.setContent(kleur.green(`Special case saved to ${CONFIG_PATH}`));
            } catch (err) {
              editStatus.setContent(kleur.red(`Failed to save config: ${err}`));
            }
            editScreen.render();
            setTimeout(() => returnToMainScreen(editScreen), 1000);
          } else {
            editStatus.setContent(kleur.red('Please select an action.'));
            editScreen.render();
          }
        });
    
        editScreen.key(['enter'], () => form.submit());
    
        editScreen.key(['tab'], () => {
          const current = editScreen.focused;
          if (current === valueInput) actionList.focus();
          else if (current === actionList) prefixCheckbox.focus();
          else valueInput.focus();
          editScreen.render();
        });
    
        editScreen.key(['h'], () => returnToMainScreen(editScreen));
    
        valueInput.focus();
        editScreen.render();
      };
    
      commScreen.key(['enter'], () => {
        const index = commList.selected();
        const sol = solutions[index];
        openEditScreen(sol, index);
      });
    
      commScreen.key(['e'], () => {
        const index = commList.selected();
        const sol = solutions[index];
        openEditScreen(sol, index);
      });
    
      commScreen.key(['h'], () => returnToMainScreen(commScreen));
      commScreen.key(['q'], () => returnToMainScreen(commScreen));
    
      commList.focus();
      renderDebounced();
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

        editorPrompt.readInput('Editor (nano/vim, default: nano): ', 'nano', (err: Error | null, editor: string) => {
          const editorCmd = editor?.trim() === 'vim' ? 'vim' : 'nano';
          if (!existsSync(CONFIG_PATH)) {
            writeFileSync(CONFIG_PATH, JSON.stringify({ directories: [], aliases: {}, specialCases: {} }, null, 2));
          }
          editScreen.destroy();
          spawnSync(editorCmd, [CONFIG_PATH], { stdio: 'inherit' });
          try {
            initialConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
            if (!initialConfig.specialCases) initialConfig.specialCases = {};
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
          mouse: true,
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

        editList.on('select', (item: blessed.Widgets.Element, i: number) => {
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
              mouse: true,
              items: initialConfig.directories.map((d, i) => `${i + 1}. ${d.path.slice(0, 50)} (tsconfig: ${d.tsconfig.slice(0, 50)})`),
              interactive: true,
              scrollable: true,
              scrollbar: { 
                style: { 
                  bg: 'blue' 
                }
              },
            });

            dirScreen.key(['space'], () => {
              const index = dirList.selected();
              if (excluded.has(index)) {
                excluded.delete(index);
                (dirList as BlessedListWithItems).items[index].style.fg = 'green';
              } else {
                excluded.add(index);
                (dirList as BlessedListWithItems).items[index].style.fg = 'gray';
              }
              dirScreen.render();
            });

            dirScreen.key(['enter'], () => {
              initialConfig.directories = initialConfig.directories.filter((_, i) => !excluded.has(i));
              try {
                writeFileSync(CONFIG_PATH, JSON.stringify(initialConfig, null, 2));
              } catch (err) {
                console.log(kleur.red(`Failed to save config: ${err}`));
              }
              returnToMainScreen(dirScreen);
            });

            dirScreen.key(['h'], () => returnToMainScreen(dirScreen));
            dirScreen.key(['q'], () => returnToMainScreen(dirScreen));

            (dirList as BlessedListWithItems).items.forEach((item) => (item.style.fg = 'green'));
            dirList.focus();
            dirScreen.render();
          } else if (i === 1) {
            console.log(kleur.yellow('Alias editing not yet implemented in TUI. Modify monocheck.config.json manually.'));
            returnToMainScreen(editScreen);
          } else if (i === 2) {
            const specialScreen = blessed.screen({ smartCSR: true, title: 'Edit Special Cases' });
            let lastRender = 0;
            const specialScreenRenderDebounced = () => {
              const now = Date.now();
              if (now - lastRender > 50) {
                specialScreen.render();
                lastRender = now;
              }
            };
            
            const specialList = blessed.list({
              parent: specialScreen,
              top: 1,
              left: 1,
              width: '90%',
              height: '50%',
              border: { type: 'line' },
              style: {
                border: { fg: 'cyan' },
                selected: { bg: 'blue' },
                item: { fg: 'white' }
              },
              keys: true,
              items: Object.entries(initialConfig.specialCases).map(([k, v]) => `${k}: ${v.action}${v.value ? ` → ${v.value}` : ''}${v.prefixOnly ? ' (prefix)' : ''}`),
              interactive: true,
            });

            specialScreen.key(['d'], () => {
              const index = specialList.selected();
              const key = Object.keys(initialConfig.specialCases)[index];
              delete initialConfig.specialCases[key];
              specialList.removeItem(index);
              specialScreen.render();
            });

            specialScreen.key(['enter'], () => {
              try {
                writeFileSync(CONFIG_PATH, JSON.stringify(initialConfig, null, 2));
              } catch (err) {
                console.log(kleur.red(`Failed to save config: ${err}`));
              }
              returnToMainScreen(specialScreen);
            });
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
                if (!initialConfig.specialCases) initialConfig.specialCases = {};
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
    } else if (index === 4) { // Fix issues
      screen.destroy();
      config = initialConfig;
      try {
        const issuesByDir = await scanAndReport(null);
        if (isDebug) console.log('DEBUG: Fix screen loading with issues:', Object.keys(issuesByDir).length);
        displayFixTui(issuesByDir);
      } catch (err) {
        console.log(kleur.red(`Fix scan failed: ${err}`));
        returnToMainScreen(screen);
      }
    } else if (index === 5) { // Save and exit
      screen.destroy();
      try {
        writeFileSync(CONFIG_PATH, JSON.stringify(initialConfig, null, 2));
        console.log(kleur.green(`Config saved to ${CONFIG_PATH}`));
      } catch (err) {
        console.log(kleur.red(`Failed to save config: ${err}`));
      }
      resolvePromise(initialConfig);
    }
  });

  screen.key(['h'], () => screen.render());
  screen.key(['q'], () => {
    try {
      writeFileSync(CONFIG_PATH, JSON.stringify(initialConfig, null, 2));
      console.log(kleur.green(`Config saved to ${CONFIG_PATH}`));
    } catch (err) {
      console.log(kleur.red(`Failed to save config: ${err}`));
    }
    process.exit(0);
  });
  screen.key(['C-c'], () => process.exit(0));

  list.focus();
  screen.render();

  return promise;
}

// 4 UI Component Functions

// 4.1 TUI Report Viewer
function displayReportTui(issuesByDir: { [dir: string]: ImportIssue[] }) {
  if (isDebug) console.log('DEBUG: Displaying report screen');
  const reportScreen = blessed.screen({ smartCSR: true, title: 'monocheck Report Viewer' });

  const reportList = blessed.list({
    parent: reportScreen,
    top: 1,
    left: 1,
    width: '30%',
    height: '80%',
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, selected: { bg: 'blue' }, item: { fg: 'white' } },
    keys: true,
    mouse: true,
    items: Object.keys(issuesByDir).map((dir) => {
      const dirConfig = config!.directories.find(d => d.path === dir);
      return dirConfig?.workspaceName || dir.slice(0, 28);
    }),
    interactive: true,
    scrollable: true,
    scrollbar: { style: { bg: 'blue' } },
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
    mouse: true,
    scrollable: true,
    interactive: true,
  });

  const status = blessed.text({
    parent: reportScreen,
    bottom: 0,
    left: 1,
    width: '100%',
    height: '20%',
    content: `Viewing reports for ${Object.keys(issuesByDir).length} directories. Tab to switch panels, e to edit report, h for home`,
    style: { fg: 'yellow' },
  });

  let lastRender = 0;
  const renderDebounced = () => {
    const now = Date.now();
    if (now - lastRender > 50) {
      reportScreen.render();
      lastRender = now;
    }
  };

  reportList.on('select', (item, index) => {
    const dir = Object.keys(issuesByDir)[index];
    const issues = issuesByDir[dir];
    if (issues.length === 0) {
      issueBox.setItems(['No issues found for this directory.']);
      issueBox.style.item.fg = 'green';
    } else {
      issueBox.setItems(
        issues.map((i) => `${i.file.slice(0, 50)}:${i.line} - ${i.importPath.slice(0, 30)} (${i.issue}) ${i.suggestion ? `[${i.suggestion.slice(0, 50)}]` : ''}`),
      );
      issueBox.style.item.fg = 'white';
    }
    issueBox.focus();
    renderDebounced();
  });

  reportScreen.key(['tab'], () => {
    if (reportScreen.focused === reportList) issueBox.focus();
    else reportList.focus();
    renderDebounced();
  });

  reportScreen.key(['e'], () => {
    const index = reportList.selected();
    const dir = Object.keys(issuesByDir)[index];
    const reportPath = config!.directories.find(d => d.path === dir)?.report;
    if (reportPath) {
      const editorPrompt = blessed.prompt({
        parent: reportScreen,
        top: 'center',
        left: 'center',
        width: '50%',
        height: 'shrink',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' }, fg: 'white' },
        label: 'Edit Report',
        content: 'Launch editor to modify report?',
      });

      editorPrompt.readInput('Editor (nano/vim, default: nano): ', 'nano', (err: Error | null, editor: string | null) => {
        const editorCmd = editor?.trim() === 'vim' ? 'vim' : 'nano';
        reportScreen.destroy();
        spawnSync(editorCmd, [reportPath], { stdio: 'inherit' });
        displayReportTui(issuesByDir);
      });
    }
  });

  reportScreen.key(['h'], () => returnToMainScreen(reportScreen));
  reportScreen.key(['q'], () => returnToMainScreen(reportScreen));
  reportScreen.key(['C-c'], () => process.exit(0));

  reportList.focus();
  renderDebounced();
}

// 4.2 TUI Fix Viewer
function displayFixTui(issuesByDir: { [dir: string]: ImportIssue[] }) {
  console.log('DEBUG: Displaying fix screen');
  const fixScreen = blessed.({ smartCSR: true, title: 'monocheck Fix Issues' });

  const form = blessed.form({
    parent: fixScreen,
    top: 1,
    left: 1,
    width: '90%',
    height: '20%',
    border: { type: 'line' },
    style: { border: { fg: 'cyan' } },
    keys: true,
  });

  const dryRunCheckbox = blessed.checkbox({
    parent: form,
    top: 1,
    left: 1,
    content: 'Dry Run (simulate fixes)?',
    mouse: true,
    style: { fg: 'white' },
    checked: true,
  });

  const autoFixCheckbox = blessed.checkbox({
    parent: form,
    top: 3,
    left: 1,
    content: 'Auto Fix (apply all fixes)?',
    mouse: true,
    style: { fg: 'white' },
    checked: false,
  });

  const confirmButton = blessed.button({
    parent: form,
    top: 5,
    left: 1,
    width: 20,
    height: 3,
    content: 'Confirm Fixes',
    border: { type: 'line' },
    style: { fg: 'white', border: { fg: 'gray' }, hover: { bg: 'blue' } },
  });

  const undoButton = blessed.button({
    parent: form,
    top: 5,
    left: 22,
    width: 20,
    height: 3,
    content: 'Undo Fixes',
    border: { type: 'line' },
    style: { fg: 'white', border: { fg: 'gray' }, hover: { bg: 'blue' } },
    hidden: !changeTracker.hasChanges(),
  });

  const reportList = blessed.list({
    parent: fixScreen,
    top: '20%+2',
    left: 1,
    width: '30%',
    height: '60%',
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, selected: { bg: 'blue' }, item: { fg: 'white' } },
    keys: true,
    mouse: true,
    items: Object.keys(issuesByDir).map((dir) => dir.slice(0, 28)),
    interactive: true,
    scrollable: true,
    scrollbar: { style: { bg: 'blue' } },
  });

  const issueBox = blessed.list({
    parent: fixScreen,
    top: '20%+2',
    left: '30%+2',
    width: '70%-2',
    height: '60%',
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, selected: { bg: 'blue' }, item: { fg: 'white' } },
    keys: true,
    mouse: true,
    scrollable: true,
    interactive: true,
  });

  const logBox = blessed.log({
    parent: fixScreen,
    top: '80%+2',
    left: 1,
    width: '90%',
    height: '20%-2',
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, fg: 'white' },
    scrollable: true,
    scrollbar: { style: { bg: 'blue' } },
  });

  const status = blessed.text({
    parent: fixScreen,
    bottom: 0,
    left: 1,
    width: '100%',
    height: '10%',
    content: 'Tab to navigate, Enter to fix manually, c to confirm, u to undo, h for home, q to return',
    style: { fg: 'yellow' },
  });

  let lastRender = 0;
  const renderDebounced = () => {
    const now = Date.now();
    if (now - lastRender > 50) {
      fixScreen.render();
      lastRender = now;
    }
  };

  reportList.on('select', (item, index) => {
    const dir = Object.keys(issuesByDir)[index];
    const issues = issuesByDir[dir];
    issueBox.setItems(
      issues.map((i) => `${i.file.slice(0, 50)}:${i.line} - ${i.importPath.slice(0, 30)} (${i.issue}) ${i.suggestion ? `[${i.suggestion.slice(0, 50)}]` : ''}${i.fixed ? ' [Fixed]' : ''}`),
    );
    issueBox.focus();
    renderDebounced();
  });

  const applyFix = async (issue: ImportIssue, dir: string, index: number) => {
    const project = new Project({ tsConfigFilePath: config!.directories.find(d => d.path === dir)!.tsconfig });
    activeProjects.push(project);
    const file = project.getSourceFile(issue.file)!;
    changeTracker.backup(issue.file, file.getFullText());
    const importDecl = file.getImportDeclarations().find(d => d.getStartLineNumber() === issue.line);
    let success = false;

    if (importDecl && !issue.commented) {
      const newImportPath = issue.suggestion?.match(/from '([^']+)'/)?.[1];
      if (newImportPath) {
        importDecl.setModuleSpecifier(newImportPath);
        success = true;
      }
    } else if (issue.commented) {
      const fullText = file.getFullText();
      const lines = fullText.split('\n');
      const newImportPath = issue.suggestion?.match(/from '([^']+)'/)?.[1];
      if (newImportPath) {
        lines[issue.line - 1] = lines[issue.line - 1].replace(/^\s*\/\/+\s*|^#+\s*|\/\*|\*\//g, '').replace(issue.importPath, newImportPath);
        file.replaceWithText(lines.join('\n'));
        success = true;
      }
    }

    if (success) {
      if (!dryRunCheckbox.checked) {
        await file.save();
        changeTracker.recordChange(issue.file, file.getFullText());
        issue.fixed = true;
        issueBox.setItem(index, `${issue.file.slice(0, 50)}:${issue.line} - ${issue.importPath.slice(0, 30)} (${issue.issue}) [Fixed]`); 
        logBox.log(kleur.green(`Fixed: ${issue.file}:${issue.line}`));
      } else {
        logBox.log(kleur.yellow(`[Dry Run] Would fix: ${issue.file}:${issue.line} to ${issue.suggestion}`));
      }
      undoButton.hidden = !changeTracker.hasChanges();
      renderDebounced();
    }
  };

  issueBox.on('select', async (item, index) => {
    if (autoFixCheckbox.checked) return;
    const dir = reportList.getItem(reportList.selected())?.content;
    if (!dir) {
      logBox.log(kleur.yellow('No directory selected.'));
      renderDebounced();
      return;
    }
    const issue = issuesByDir[dir][index];
    if (issue.fixed) {
      logBox.log(kleur.yellow('Issue already fixed.'));
      renderDebounced();
      return;
    }
    if (!issue.suggestion) {
      logBox.log(kleur.yellow('No fix available for this issue.'));
      renderDebounced();
      return;
    }
    await applyFix(issue, dir, index);
  });

  confirmButton.on('press', async () => {
    if (autoFixCheckbox.checked) {
      for (const dir of Object.keys(issuesByDir)) {
        const issues = issuesByDir[dir];
        for (let i = 0; i < issues.length; i++) {
          const issue = issues[i];
          if (!issue.fixed && issue.suggestion) {
            await applyFix(issue, dir, i);
            issueBox.setItems(
              issues.map((i, idx) => `${i.file.slice(0, 50)}:${i.line} - ${i.importPath.slice(0, 30)} (${i.issue}) ${i.suggestion ? `[${i.suggestion.slice(0, 50)}]` : ''}${i.fixed ? ' [Fixed]' : ''}`),
            );
          }
        }
      }
      logBox.log(kleur.green('All fixes applied.'));
    } else if (dryRunCheckbox.checked) {
      for (const dir of Object.keys(issuesByDir)) {
        const issues = issuesByDir[dir];
        for (const issue of issues) {
          if (!issue.fixed && issue.suggestion) {
            logBox.log(kleur.yellow(`[Dry Run] Would fix: ${issue.file}:${issue.line} to ${issue.suggestion}`));
          }
        }
      }
    }
    renderDebounced();
  });

  undoButton.on('press', () => {
    if (changeTracker.undo()) {
      logBox.log(kleur.green('All fixes undone.'));
      for (const dir of Object.keys(issuesByDir)) {
        const issues = issuesByDir[dir];
        for (const issue of issues) {
          issue.fixed = false;
        }
      }
      const selectedDir = reportList.getItem(reportList.selected())?.content;
      if (selectedDir) {
        issueBox.setItems(
          issuesByDir[selectedDir].map((i) => `${i.file.slice(0, 50)}:${i.line} - ${i.importPath.slice(0, 30)} (${i.issue}) ${i.suggestion ? `[${i.suggestion.slice(0, 50)}]` : ''}`),
        );
      }
      undoButton.hidden = true;
      renderDebounced();
    }
  });

  fixScreen.key(['tab'], () => {
    const current = fixScreen.focused;
    if (current === dryRunCheckbox) autoFixCheckbox.focus();
    else if (current === autoFixCheckbox) confirmButton.focus();
    else if (current === confirmButton && !undoButton.hidden) undoButton.focus();
    else if (current === undoButton || current === confirmButton) reportList.focus();
    else if (current === reportList) issueBox.focus();
    else dryRunCheckbox.focus();
    renderDebounced();
  });

  fixScreen.key(['c'], () => confirmButton.emit('press'));
  fixScreen.key(['u'], () => undoButton.emit('press'));
  fixScreen.key(['h'], () => returnToMainScreen(fixScreen));
  fixScreen.key(['q'], () => returnToMainScreen(fixScreen));
  fixScreen.key(['C-c'], () => process.exit(0));

  reportList.focus();
  renderDebounced();
}

// 5. Main Application Functions
// 5.1 Scan and Report Logic
async function scanAndReport(logBox: blessed.Widgets.Log | null, progressBar?: blessed.Widgets.ProgressBarElement): Promise<{ [dir: string]: ImportIssue[] }> {
  const communitySolutions = await fetchCommunitySolutions();
  const issuesByDir: { [dir: string]: ImportIssue[] } = {};

  for (const dir of config!.directories) {
    logBox?.log(kleur.cyan(`Starting monocheck for ${dir.workspaceName || dir.path}`));
    if (isDebug) console.log(`DEBUG: Scanning ${dir.path}`);
    const project = new Project({ tsConfigFilePath: dir.tsconfig });
    activeProjects.push(project);
    let files: SourceFile[] = [];
    try {
      files = project.getSourceFiles(`${dir.path}/**/*.{ts,tsx}`);
      if (files.length === 0) {
        logBox?.log(kleur.yellow(`No .ts/.tsx files found in ${dir.path}. Trying broader pattern...`));
        if (isDebug) console.log(`DEBUG: No TS files in ${dir.path}, trying broader pattern`);
        files = project.getSourceFiles(`${dir.path}/**/*.{ts,tsx,js,jsx}`);
      }
    } catch (err) {
      logBox?.log(kleur.red(`Error scanning files in ${dir.path}: ${err}`));
      if (isDebug) console.log(kleur.red(`Error scanning ${dir.path}: ${err}`));
      continue;
    }

    const issues: ImportIssue[] = [];
    const totalFiles = files.length;
    let processedFiles = 0;

    for (const file of files) {
      try {
        const filePath = file.getFilePath();
        if (typeof relative !== 'function') {
          logBox?.log(kleur.red('Error: relative function is undefined'));
          if (isDebug) console.log('DEBUG: relative is undefined');
          throw new Error('relative function is undefined');
        }
        const relativeFilePath = relative(process.cwd(), filePath);
        logBox?.log(kleur.yellow(`Processing: ${relativeFilePath}`));
        if (isDebug) console.log(`DEBUG: Processing ${relativeFilePath}`);
        const imports = file.getImportDeclarations();

        for (const importDecl of imports) {
          const importPath = importDecl.getModuleSpecifierValue();
          const line = importDecl.getStartLineNumber();

          if (!importPath.startsWith('.') && !importPath.startsWith('@')) continue;
          if (importPath.startsWith('@') && !Object.keys(config!.aliases).some((a) => importPath.startsWith(a))) {
            const rootPkg = importPath.split('/')[0];
            if (dir.dependencies?.[rootPkg] || existsSync(resolve('node_modules', rootPkg))) continue;
          }

          const resolvedPath = config ? resolveImportPath(importPath, file, config) : null;
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
            if (special.action === 'rename') {
              const newImportPath = special.prefixOnly ? importPath.replace(key, special.value!) : special.value;
              suggestion = suggestion || `Rename to: import ... from '${newImportPath}'`;
            } else if (special.action === 'replace-method') {
              suggestion = suggestion || `Replace with: import { useUser } from '${special.value}' (adjust usage accordingly)`;
            } else {
              suggestion = 'Excluded from checks';
            }
            issues.push({ file: relativeFilePath, line, importPath, issue: `Special case: ${special.action}`, suggestion });
            continue;
          }

          if (importPath.startsWith('.')) {
            const suggestedAlias = config ? findMatchingAlias(resolvedPath, config) : null;
            if (suggestedAlias) {
              const relativeImportPath = config ? convertToAliasPath(resolvedPath!, suggestedAlias, config) : null;
              issues.push({
                file: relativeFilePath,
                line,
                importPath,
                issue: `Relative import should use alias '${suggestedAlias}'`,
                suggestion: relativeImportPath ? `Change to: import ... from '${relativeImportPath}'` : (suggestionFromCommunity || ''),
              });
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
                const suggestedAlias = config ? findMatchingAlias(resolvedPath, config) : null;
                const relativeImportPath = suggestedAlias && config ? convertToAliasPath(resolvedPath, suggestedAlias, config) : null;
                issues.push({
                  file: relativeFilePath,
                  line,
                  importPath,
                  issue: `Alias '${importPath}' resolves incorrectly`,
                  suggestion: relativeImportPath
                    ? `Change to: import ... from '${relativeImportPath}'`
                    : suggestionFromCommunity || `Verify path for '${importPath}'`,
                });
              }
            }
          }
        }

        const commentedImports = findCommentedImports(file);
        for (const { text, line } of commentedImports) {
          const importMatch = text.match(/import\s+.*\s+from\s+['"]([^'"]+)['"]/);
          if (!importMatch) {
            issues.push({ file: relativeFilePath, line, importPath: text, issue: `Invalid commented import syntax`, suggestion: 'Manually review and fix', commented: true });
            continue;
          }

          const importPath = importMatch[1];
          const resolvedPath = config ? resolveImportPath(importPath, file, config) : null;
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
            if (special.action === 'rename') {
              const newImportPath = special.prefixOnly ? importPath.replace(key, special.value!) : special.value;
              suggestion: relativeImportPath ? `Change to: import ... from '${relativeImportPath}'` : (suggestionFromCommunity ?? ''),
            } else if (special.action === 'replace-method') {
              suggestion = suggestion || `Uncomment and replace with: import { useUser } from '${special.value}' (adjust usage accordingly)`;
            } else {
              suggestion = 'Excluded from checks';
            }
            issues.push({ file: relativeFilePath, line, importPath, issue: `Commented special case: ${special.action}`, suggestion, commented: true });
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

          const suggestedAlias = config ? findMatchingAlias(resolvedPath, config) : null;
          const newImportPath = suggestedAlias && config ? convertToAliasPath(resolvedPath, suggestedAlias, config) : importPath;
          issues.push({
            file: relativeFilePath,
            line,
            importPath,
            issue: suggestedAlias ? `Commented import should use alias '${suggestedAlias}'` : `Commented import has no matching alias`,
            suggestion: suggestionFromCommunity ?? `Verify path for '${importPath}'`,
            commented: true,
          });
        }
      } catch (err) {
        logBox?.log(kleur.red(`Error processing ${file.getFilePath()}: ${err}`));
        if (isDebug) console.log(kleur.red(`Error processing ${file.getFilePath()}: ${err}`));
      }

      processedFiles++;
      if (progressBar && totalFiles > 0 && logBox) {
        progressBar.setProgress((processedFiles / totalFiles) * 100);
        logBox.screen.render();
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
    try {
      writeFileSync(dir.report, JSON.stringify(report, null, 2));
      logBox?.log(kleur.cyan(`Completed monocheck for ${files.length} files in ${dir.path}`));
      logBox?.log(kleur.gray(`Total issues: ${issues.length} (Standard: ${report.standardIssues}, Commented: ${report.commentedIssues})`));
      logBox?.log(kleur.green(`Fixed issues: ${report.fixedIssues}`));
    } catch (err) {
      logBox?.log(kleur.red(`Error writing report for ${dir.path}: ${err}`));
      console.log(kleur.red(`Error writing report for ${dir.path}: ${err}`));
    }
  }

  return issuesByDir;
}

// 5.2 TUI Config Setup
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

// 6. Main Function and Entry Point
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