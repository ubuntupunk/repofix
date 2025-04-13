# Repofix

A powerful tool for managing and fixing import paths in TypeScript monorepos. Repofix helps you maintain clean and consistent import paths across your TypeScript projects, with support for alias detection, special case handling, and interactive fixes.

## Features

- 🔍 Automatic monorepo scanning and configuration
- 🎯 Smart detection of TypeScript path aliases
- 🛠️ Interactive import path fixing
- 📦 Support for special case handling
- 🤝 Community-driven solutions database
- 🚀 Batch processing with automatic fixes
- 💡 Intelligent import path suggestions
- Fix issues with dry run and undo support

## TUI Branch

Check out the `tui` branch for an enhanced version featuring a full blessed TUI with interactive menu options for a more user-friendly experience.

## Installation

```bash
npm install monocheck
```
## Navigation
Navigate the TUI with arrow keys, select options with Enter, and use:

    h to return to the main menu
    q to quit or return from sub-screens
    c to confirm fixes
    u to undo fixes

## Special Cases
* *Special cases allow you to handle specific import scenarios:

* Rename : Change import paths

* Replace Method : Replace specific method imports

* Exclude : Ignore specific import patterns

## Community Solutions
Repofix includes a community-driven database of common import path solutions. These are automatically suggested during configuration and fixes.

## Reports
After each run, Repofix generates detailed reports containing:

* Found issues

* Applied fixes

* Skipped imports

* Error logs

* Reports are saved as JSON files in the configured report locations.

## CLI Options
`--fix`            Enable automatic fixing of import issues
`--interactive`    Enable interactive mode for reviewing fixes

## Development Setup
### Setup
```bash
git clone <repository-url>
cd repofix
npm install
```
### Build
```bash
npm run build
```
### Test
```bash
npm test
```
### Lint
```bash
npm run lint
```
## Contributing
* Fork the repository

* Create your feature branch ( ```git checkout -b feature/amazing-feature```)

* Commit your changes ( ```git commit -m 'Add amazing feature'```)

* Push to the branch ( ```git push origin feature/amazing-feature```)

* Open a Pull Request

## Contributing to Special Cases

Repofix's special-cases.json is a community-driven database of special case handling for import scenarios. Your contributions help improve the tool for the benefit of the community. To contribute to special-cases.json:

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/special-case-update`
3. **Add/update special case(s)**: Modify `special-cases.json` with your changes
4. **Commit changes**: `git commit -m 'Add/update special case for [brief description]'`
5. **Push to the feature branch**: `git push origin feature/special-case-update`
6. **Open a Pull Request**

## Requirements
Node.js >= 14.0.0

TypeScript >= 4.9.5

## License
This project is licensed under the MIT License - see the [LICENSE] file for details.

## Acknowledgments
* Thanks to the TypeScript team for ts-morph

* All contributors and community solution providers

## Support
For bugs and feature requests, please open an issue in the GitHub repository.
