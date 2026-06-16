# AGENTS.md — ai-translate

## Project Overview
CLI tool for translating EPUB/FB2 books via Ollama models, preserving original formatting.

## Tech Stack
- **Runtime:** Node.js 22+ (ES modules)
- **Language:** JavaScript (ESM, `"type": "module"` in package.json)
- **Testing:** Vitest
- **Key libs:** commander, adm-zip, node-html-parser, fast-xml-parser, ora, chalk

## Project Structure
```
src/
  index.js              # Entry point (#!/usr/bin/env node)
  cli/commands.js       # Commander CLI
  cli/progress.js       # Spinner/progress UI
  parsers/epub-parser.js
  parsers/epub-writer.js
  parsers/fb2-parser.js
  translators/ollama-client.js
  translators/orchestrator.js
  utils/constants.js
test/
  index.test.js
  parsers/epub-parser.test.js
  parsers/epub-writer.test.js
  parsers/fb2-parser.test.js
  translators/ollama-client.test.js
  translators/orchestrator.test.js
  integration/pipeline.test.js
  integration/e2e.test.js
  fixtures/
```

## Commands
- `npm test` — run all tests with vitest
- `npm run test:watch` — run tests in watch mode
- `node src/index.js <input> -l <lang>` — run CLI

## Commit Convention
- `feat:` new features
- `fix:` bug fixes
- `refactor:` code restructuring
- `test:` adding/updating tests
- `docs:` documentation changes
- `chore:` maintenance tasks

## Rules
- Every task ends with a commit only if all tests pass
- All new code must have corresponding tests
- ES modules only (import/export, not require)
- Use async/await, no raw callbacks
- Preserve original formatting: never strip HTML tags, CSS, or structural elements