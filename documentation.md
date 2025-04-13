# Monocheck TUI Documentation

This document outlines the architecture and core logic of the `monocheck` tool.

## Overview

`monocheck` is a command-line tool designed to analyze and fix import paths within TypeScript monorepos. It leverages `ts-morph` for code analysis and `blessed` to provide an interactive Terminal User Interface (TUI) for configuration, reporting, and fixing issues.

## Core Components

1.  **Configuration (`monocheck.config.json`):**
    *   Stores settings for the tool's operation.
    *   `directories`: An array defining the packages/workspaces within the monorepo to scan. Each entry includes the path to the directory, its `tsconfig.json`, and the desired path for the JSON report file. It can also store detected `package.json` info and workspace name.
    *   `aliases`: An object mapping TypeScript path aliases (e.g., `@/utils`) to their corresponding file system paths, typically extracted from `tsconfig.json` files.
    *   `specialCases`: An object defining custom rules for specific import paths. Actions include `rename` (change the import path), `replace-method` (suggest replacing specific imports, often for library migrations), and `exclude` (ignore the import path during checks). Rules can apply to exact matches or prefixes.

2.  **TypeScript Analysis (`ts-morph`):**
    *   Used to parse TypeScript source files (`.ts`, `.tsx`).
    *   Creates Abstract Syntax Trees (ASTs) for analysis.
    *   Identifies import declarations (`import ... from '...'`).
    *   Resolves module specifiers (import paths) to their actual file locations based on `tsconfig.json` settings and aliases.
    *   Modifies the AST to apply fixes (e.g., changing the module specifier) and saves the changes back to the file system.

3.  **Terminal User Interface (`blessed`):**
    *   Provides an interactive, menu-driven interface for users.
    *   Components used: Screens, Lists, Forms, Textboxes, Checkboxes, Buttons, Progress Bars, Log boxes.
    *   Handles user input (keyboard navigation, selections).
    *   Displays configuration options, scan progress, reports, and fixing options.

4.  **Helper Functions (`src/helpers.ts`):**
    *   Contains utility functions abstracted from the main logic:
        *   `scanMonorepo`: Detects potential project directories (e.g., based on `package.json` or `tsconfig.json`).
        *   `extractAliases`: Reads `tsconfig.json` to find path aliases.
        *   `resolveImportPath`: Determines the absolute file path for a given import specifier relative to a source file, considering aliases.
        *   `findMatchingAlias`: Finds the best alias corresponding to a resolved absolute path.
        *   `convertToAliasPath`: Converts an absolute path back into an alias-based path.
        *   `findCommentedImports`: Detects import statements that are commented out.
        *   `fetchCommunitySolutions`: (Assumed) Fetches predefined solutions/rules from an external source.

5.  **Change Tracking (`ChangeTracker` Class):**
    *   A simple undo mechanism.
    *   Backs up the original content of a file before any modifications are made during the fixing process.
    *   Allows reverting all modified files back to their original state if the user chooses to undo.

## Workflow Logic

1.  **Initialization:**
    *   The `monocheck` function starts the process.
    *   It calls `initializeConfigWithTui` to load or create the configuration via the TUI.

2.  **TUI Main Menu (`initializeMainMenu`):**
    *   Loads `monocheck.config.json` if it exists.
    *   Presents the main options:
        *   **Scan monorepo:** Finds directories, lets the user select which ones to include, extracts aliases, and triggers `scanAndReport`.
        *   **Add special case:** Opens a form to define a new rule in `specialCases`.
        *   **Community solutions:** Fetches external solutions and allows adding them as special cases.
        *   **Edit config:** Allows modifying the configuration (removing directories, deleting special cases, or opening the raw JSON in an editor).
        *   **Fix issues:** Triggers `scanAndReport` and then displays the fixing UI (`displayFixTui`).
        *   **Save and exit:** Writes the current configuration to disk and exits.

3.  **Scanning and Reporting (`scanAndReport`):**
    *   Iterates through each configured directory.
    *   Initializes a `ts-morph` Project for the directory's `tsconfig.json`.
    *   Gets all relevant source files (`.ts`, `.tsx`).
    *   For each file:
        *   Finds all import declarations.
        *   Finds commented-out imports using `findCommentedImports`.
        *   For each import (real or commented):
            *   Checks if it's a relative (`.`) or alias (`@`) path.
            *   Checks against `specialCases` and community solutions first.
            *   If relative: Resolves the path. If a matching alias exists, flags it as an issue suggesting the alias. If unresolved, flags it.
            *   If alias: Resolves the path. Checks if the alias is known. Checks if the resolved path matches the expected path for the alias. Flags mismatches or unknown aliases. Suggests installing missing modules if applicable.
            *   Creates an `ImportIssue` object detailing the file, line number, original import path, the identified issue, and a suggested fix (if available).
    *   Writes a JSON report file for each directory containing the list of issues found.
    *   Returns a map of directory paths to their list of issues.

4.  **Displaying Reports (`displayReportTui`):**
    *   Shows a list of scanned directories.
    *   When a directory is selected, displays the list of issues found in that directory.
    *   Provides an option to open the JSON report file in an editor.

5.  **Fixing Issues (`displayFixTui`):**
    *   Presents the issues similarly to the report view.
    *   Offers "Dry Run" (show what would be fixed) and "Auto Fix" (apply all suggested fixes automatically) options.
    *   Allows selecting individual issues to apply fixes one by one (if not in Auto Fix mode).
    *   When applying a fix:
        *   Uses `ts-morph` to get the `SourceFile` and `ImportDeclaration`.
        *   Backs up the original file content using `changeTracker.backup`.
        *   Modifies the import statement (e.g., `importDecl.setModuleSpecifier(...)` or text replacement for commented imports).
        *   If not in Dry Run mode, saves the file (`file.save()`) and records the change using `changeTracker.recordChange`.
        *   Updates the UI to mark the issue as fixed.
    *   Provides an "Undo Fixes" button (if changes have been made) that uses `changeTracker.undo()` to restore original file contents.

## Key Concepts

*   **Alias Resolution:** Converting alias paths like `@/components/Button` to absolute file paths and vice-versa.
*   **Special Cases:** Handling non-standard import scenarios or enforcing specific project conventions.
*   **Community Solutions:** Leveraging a shared database of common import fixes.
*   **Interactive TUI:** Providing a user-friendly way to manage the tool without complex command-line arguments.
*   **AST Manipulation:** Directly modifying the code structure via `ts-morph` for reliable fixes.
