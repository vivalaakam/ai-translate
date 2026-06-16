# AGENTS.md — ai-translate

## Project Overview
CLI + Web tool for translating EPUB/FB2 books via Ollama models, preserving original formatting.

## Tech Stack
- **Runtime:** Node.js 22+ (ES modules)
- **Language:** TypeScript (strict mode)
- **Testing:** Vitest
- **Web:** Express 5, WebSocket (ws), multer
- **Key libs:** commander, adm-zip, node-html-parser, fast-xml-parser, ora, chalk

## Project Structure
```
src/
  index.ts               # Entry point
  types.ts               # Shared TypeScript interfaces
  cli/commands.ts         # Commander CLI (translate + web subcommands)
  cli/progress.ts         # Spinner/progress UI
  parsers/epub-parser.ts  # EPUB ZIP parser
  parsers/epub-writer.ts  # EPUB reassembler
  parsers/fb2-parser.ts   # FB2 XML parser
  translators/ollama-client.ts   # Ollama REST API client
  translators/orchestrator.ts    # DOM text extraction/translation
  web/server.ts           # Express web server + WebSocket
  web/job-queue.ts        # Translation job tracker
  web/pipeline.ts         # Web translation pipeline
  web/public/index.html   # Web UI (single-page app)
test/
  index.test.js
  parsers/epub-parser.test.js
  parsers/epub-writer.test.js
  parsers/fb2-parser.test.js
  translators/ollama-client.test.js
  translators/orchestrator.test.js
  integration/pipeline.test.js
  web/server.test.js
  fixtures/
```

## Commands
- `npm run build` — compile TypeScript to dist/
- `npm test` — run all tests with vitest (76 tests)
- `npm run test:watch` — run tests in watch mode
- `npm run dev -- <input> -l <lang>` — run CLI via tsx (development)
- `npm run web` — start web server on port 3000
- `npm start` — run compiled CLI from dist/
- `npm run typecheck` — type-check without emitting

## Web Server
- `npm run web` or `node dist/index.js web [--port 3000] [--url http://localhost:11434]`
- Web UI at http://localhost:3000
- API endpoints:
  - POST /api/translate — upload file + start translation (multipart form)
  - GET /api/jobs — list all jobs
  - GET /api/jobs/:id — job status
  - GET /api/jobs/:id/download — download translated file
  - DELETE /api/jobs/:id — delete job
  - GET /api/models — list Ollama models
  - GET /api/health — health check
- WebSocket at /ws for real-time job updates

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