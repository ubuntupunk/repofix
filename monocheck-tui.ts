async function initializeConfigWithTui(): Promise<Config> {
    let initialConfig: Config = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) : { directories: [], aliases: {}, specialCases: {} };
    const screen = blessed.screen({ smartCSR: true, title: 'monocheck Config Setup' });
  
    const list = blessed.list({
      parent: screen,
      top: 1,
      left: 1,
      width: '90%',
      height: '50%',
      border: { type: 'line' },
      style: { border: { fg: 'cyan' }, selected: { bg: 'blue' }, item: { fg: 'white' } },
      keys: true,
      items: ['1. Scan monorepo', '2. Add special case', '3. Community solutions', '4. Edit config', '5. Save and exit'],
    });
  
    const status = blessed.text({
      parent: screen,
      bottom: 0,
      left: 1,
      width: '100%',
      height: '20%',
      content: 'Select an option with arrow keys, press Enter to confirm, q to quit',
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
  
        const dirStatus = blessed.text({
          parent: dirScreen,
          bottom: 0,
          left: 1,
          width: '100%',
          height: '20%',
          content: 'Space to toggle exclusion, Enter to confirm, q to return',
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
  
        dirScreen.key(['enter'], () => {
          initialConfig.directories = directories.filter((_, i) => !excluded.has(i));
          for (const dir of initialConfig.directories) {
            if (!existsSync(dir.path)) {
              dir.path = dirname(dir.tsconfig);
              console.log(kleur.yellow(`No 'src' dir found for ${dir.tsconfig}. Using ${dir.path} instead.`));
            }
            Object.assign(initialConfig.aliases, extractAliases(dir.tsconfig));
          }
          dirScreen.destroy();
          const newScreen = blessed.screen({ smartCSR: true, title: 'monocheck Config Setup' });
          list.parent = newScreen; // Reattach to new screen
          status.parent = newScreen;
          list.focus();
          newScreen.render();
        });
  
        dirScreen.key(['q'], () => {
          dirScreen.destroy();
          const newScreen = blessed.screen({ smartCSR: true, title: 'monocheck Config Setup' });
          list.parent = newScreen;
          status.parent = newScreen;
          list.focus();
          newScreen.render();
        });
  
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
          content: 'Tab to navigate, Enter to submit, q to return',
          style: { fg: 'yellow' },
        });
  
        specialScreen.key(['enter'], () => {
          const importPath = importInput.getValue().trim();
          const action = actionList.getItem(actionList.selected)?.content as 'rename' | 'replace-method' | 'exclude';
          const value = valueInput.getValue().trim() || undefined;
          const prefixOnly = prefixCheckbox.checked;
          if (importPath && action) {
            initialConfig.specialCases[importPath] = { action, value, prefixOnly };
            specialStatus.setContent('Special case added!');
            specialScreen.render();
            setTimeout(() => {
              specialScreen.destroy();
              const newScreen = blessed.screen({ smartCSR: true, title: 'monocheck Config Setup' });
              list.parent = newScreen;
              status.parent = newScreen;
              list.focus();
              newScreen.render();
            }, 500); // Brief delay for feedback
          } else {
            specialStatus.setContent('Please fill in import path and action.');
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
  
        specialScreen.key(['q'], () => {
          specialScreen.destroy();
          const newScreen = blessed.screen({ smartCSR: true, title: 'monocheck Config Setup' });
          list.parent = newScreen;
          status.parent = newScreen;
          list.focus();
          newScreen.render();
        });
  
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
          content: 'Space to select, Enter to customize/add, q to return',
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
            selected: ['rename', 'replace-method', 'exclude'].indexOf(sol.action),
          });
          const prefixCheckbox = blessed.checkbox({ parent: form, top: 12, left: 1, content: 'Prefix only?', mouse: true, style: { fg: 'white' }, checked: sol.prefixOnly });
  
          const editStatus = blessed.text({
            parent: editScreen,
            bottom: 0,
            left: 1,
            width: '100%',
            height: '20%',
            content: 'Tab to navigate, Enter to add, q to return',
            style: { fg: 'yellow' },
          });
  
          editScreen.key(['enter'], () => {
            const value = valueInput.getValue().trim() || undefined;
            const action = actionList.getItem(actionList.selected)?.content as 'rename' | 'replace-method' | 'exclude';
            const prefixOnly = prefixCheckbox.checked;
            initialConfig.specialCases[sol.from] = { action, value, prefixOnly };
            editStatus.setContent('Special case added!');
            editScreen.render();
            setTimeout(() => {
              editScreen.destroy();
              const newScreen = blessed.screen({ smartCSR: true, title: 'monocheck Config Setup' });
              list.parent = newScreen;
              status.parent = newScreen;
              list.focus();
              newScreen.render();
            }, 500);
          });
  
          editScreen.key(['tab'], () => {
            const current = editScreen.focused;
            if (current === valueInput) actionList.focus();
            else if (current === actionList) prefixCheckbox.focus();
            else valueInput.focus();
            editScreen.render();
          });
  
          editScreen.key(['q'], () => {
            editScreen.destroy();
            const newScreen = blessed.screen({ smartCSR: true, title: 'monocheck Config Setup' });
            list.parent = newScreen;
            status.parent = newScreen;
            list.focus();
            newScreen.render();
          });
  
          valueInput.focus();
          editScreen.render();
        });
  
        commScreen.key(['q'], () => {
          commScreen.destroy();
          const newScreen = blessed.screen({ smartCSR: true, title: 'monocheck Config Setup' });
          list.parent = newScreen;
          status.parent = newScreen;
          list.focus();
          newScreen.render();
        });
  
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
            editScreen.destroy();
            const { spawnSync } = require('child_process');
            spawnSync(editorCmd, [CONFIG_PATH], { stdio: 'inherit' });
            try {
              initialConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
            } catch (e) {
              console.log(kleur.yellow('Config not created or invalid. Returning to menu.'));
            }
            const newScreen = blessed.screen({ smartCSR: true, title: 'monocheck Config Setup' });
            list.parent = newScreen;
            status.parent = newScreen;
            list.focus();
            newScreen.render();
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
            ],
            interactive: true,
          });
  
          const editStatus = blessed.text({
            parent: editScreen,
            bottom: 0,
            left: 1,
            width: '100%',
            height: '20%',
            content: 'Select to edit, q to return',
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
                dirScreen.destroy();
                const newScreen = blessed.screen({ smartCSR: true, title: 'monocheck Config Setup' });
                list.parent = newScreen;
                status.parent = newScreen;
                list.focus();
                newScreen.render();
              });
  
              dirScreen.key(['q'], () => {
                dirScreen.destroy();
                const newScreen = blessed.screen({ smartCSR: true, title: 'monocheck Config Setup' });
                list.parent = newScreen;
                status.parent = newScreen;
                list.focus();
                newScreen.render();
              });
  
              dirList.items.forEach((item: any) => (item.style.fg = 'green'));
              dirList.focus();
              dirScreen.render();
            } else if (i === 1) {
              console.log(kleur.yellow('Alias editing not yet implemented in TUI. Modify monocheck.config.json manually.'));
              const newScreen = blessed.screen({ smartCSR: true, title: 'monocheck Config Setup' });
              list.parent = newScreen;
              status.parent = newScreen;
              list.focus();
              newScreen.render();
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
  
              specialScreen.key(['enter'], () => {
                specialScreen.destroy();
                const newScreen = blessed.screen({ smartCSR: true, title: 'monocheck Config Setup' });
                list.parent = newScreen;
                status.parent = newScreen;
                list.focus();
                newScreen.render();
              });
  
              specialScreen.key(['q'], () => {
                specialScreen.destroy();
                const newScreen = blessed.screen({ smartCSR: true, title: 'monocheck Config Setup' });
                list.parent = newScreen;
                status.parent = newScreen;
                list.focus();
                newScreen.render();
              });
  
              specialList.focus();
              specialScreen.render();
            }
          });
  
          editScreen.key(['q'], () => {
            editScreen.destroy();
            const newScreen = blessed.screen({ smartCSR: true, title: 'monocheck Config Setup' });
            list.parent = newScreen;
            status.parent = newScreen;
            list.focus();
            newScreen.render();
          });
  
          editList.focus();
          editScreen.render();
        }
      } else if (index === 4) { // Save and exit
        screen.destroy();
        resolvePromise(initialConfig);
      }
    });
  
    screen.key(['q', 'C-c'], () => process.exit(0));
    list.focus();
    screen.render();
  
    return promise.then((cfg) => {
      if (!cfg.directories.length && !Object.keys(cfg.aliases).length && !Object.keys(cfg.specialCases).length) {
        console.log(kleur.yellow('No configuration saved. To create monocheck.config.json manually, use:'));
        console.log(kleur.cyan(`echo '{\n  "directories": [],\n  "aliases": {},\n  "specialCases": {}\n}' > ${CONFIG_PATH}`));
        console.log(kleur.gray('Then edit with your preferred editor (e.g., nano or vim) and rerun monocheck.'));
        process.exit(0); // Graceful exit
      }
      writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
      console.log(kleur.green(`Config saved to ${CONFIG_PATH}`));
      return cfg;
    });
  }