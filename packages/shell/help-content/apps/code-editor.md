# Code

Code lets you edit text and code files alongside the rest of your work — config files, scripts, snippets, drafts of code, anything you'd open in a quick editor.

## Opening a file

- **Click** a code file in [Files](./files.md).
- **Drag** a file from your desktop into the Code window.
- **Cmd+O** (macOS) / **Ctrl+O** (Windows/Linux) for the open dialog.

Recently opened files appear in the sidebar.

## Languages

Syntax highlighting works out of the box for: JavaScript, TypeScript, Python, Go, Rust, C, C++, Java, Ruby, Swift, Kotlin, PHP, SQL, HTML, CSS, JSON, YAML, TOML, Markdown, Shell, and Dockerfile. The language is auto-detected from the extension; you can override it from the status bar.

## Editing

The editor is a full code editor with:

- **Find / replace** — `Cmd/Ctrl+F`, regex toggle.
- **Multi-cursor** — `Alt+Click` to add cursors, `Cmd/Ctrl+D` to add a cursor at the next match.
- **Block selection** — `Alt+Shift` drag.
- **Smart indent** — auto-indent on paste; configurable tab width per file or per language.
- **Bracket and quote pairing** — type one, the other inserts itself.

## Themes

The editor's colour scheme follows your global [theme](../concepts/themes.md). Switching themes recolours the editor immediately.

## File vs entity

A file edited in Code is still a [`File` entity](../concepts/entities.md). The editor reads and writes through the same vault store as [Files](./files.md); changes you make are visible there.

## Not an IDE

Code is a text editor, not an integrated development environment. There's no project model, no language server, no build system integration. For serious development, use VS Code or a similar IDE and let Brainstorm hold your notes about the code.
