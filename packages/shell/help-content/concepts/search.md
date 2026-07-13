# Search

Brainstorm has one search that reaches everywhere in your vault, and a per-app search that's scoped to what you're looking at.

## The launcher

`Cmd+K` (macOS) or `Ctrl+K` (Windows/Linux) opens the launcher from anywhere. Start typing and hits stream in across every app — notes, tasks, files, bookmarks, calendar events, people, anything stored in your vault.

The launcher searches:

- Entity **titles** and **names**.
- Entity **body text** (note content, captured page text, code-file content).
- Selected **properties** — tag names, dictionary entries.

Use arrow keys to move through hits. `Enter` opens the top hit; `Cmd/Ctrl+1..9` opens the Nth hit. Holding modifiers opens in a new window or pins it.

## Filters

Narrow the launcher with prefixes:

- `note: meeting` — only notes.
- `task: urgent` — only tasks.
- `file: report.pdf` — only files.
- `in:Project-X` — only entities in a collection called `Project-X`.
- `tag:idea` — only entities with the `idea` tag.

You can combine: `task: in:Project-X tag:urgent`.

## Per-app search

Each app has its own search box for the work shown in that window. Notes searches within your note titles and bodies. Files searches by name and path. The [Database app](../apps/database.md) filters the current view.

App-scoped search is faster (smaller index) and lets you narrow without leaving the app.

## Indexing

Brainstorm builds a search index as you work. New content is searchable within a second or two of being saved. If something feels missing, **Settings → Data → Rebuild index** forces a full rebuild.
