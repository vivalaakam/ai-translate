# AGENTS.md — ai-translate

## Project Overview
CLI tool for translating EPUB/FB2 books via Ollama models, preserving original formatting.

## Tech Stack
- **Runtime:** Node.js 22+ (ES modules)
- **Language:** TypeScript (strict mode)
- **Testing:** Vitest
- **Key libs:** commander, adm-zip, node-html-parser, fast-xml-parser, ora, chalk

## Project Structure
```
src/
  index.ts               # Entry point (#!/usr/bin/env node)
  types.ts               # Shared TypeScript interfaces
  cli/commands.ts         # Commander CLI
  cli/progress.ts         # Spinner/progress UI
  parsers/epub-parser.ts
  parsers/epub-writer.ts
  parsers/fb2-parser.ts
  translators/ollama-client.ts
  translators/orchestrator.ts
  utils/constants.ts
test/
  index.test.js
  parsers/epub-parser.test.js
  parsers/epub-writer.test.js
  parsers/fb2-parser.test.js
  translators/ollama-client.test.js
  translators/orchestrator.test.js
  integration/pipeline.test.js
  fixtures/
```

## Commands
- `npm run build` — compile TypeScript to dist/
- `npm test` — run all tests with vitest
- `npm run test:watch` — run tests in watch mode
- `npm run dev` — run CLI via tsx (development)
- `npm start` — run compiled CLI from dist/
- `npm run typecheck` — type-check without emitting

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
- TypeScript strict mode — all types must be explicit
- ES modules only (import/export, not require)
- Use .js extensions in relative imports for Node16 module resolution
- Use async/await, no raw callbacks
- Preserve original formatting: never strip HTML tags, CSS, or structural elements