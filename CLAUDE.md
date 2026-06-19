# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` in this repo is the authoritative project guide (architecture, schema, ID generation, file structure). Read it first. This file captures the essentials plus things AGENTS.md does not spell out.

## What this is

CLI + Web tool for translating EPUB/FB2/PDF books via an OpenAI-compatible `/v1/chat/completions` API (Ollama, LM Studio, OpenAI, …). Each paragraph becomes a block; blocks are stored in PostgreSQL, translated one-by-one, then reassembled into an output EPUB.

```
Input file → Parser (Epub/Fb2/Pdf) → Block Extractor → PostgreSQL
                                                       ↓
Output EPUB ← Block Assembler ← Translated blocks ← LLM client (block-by-block)
```

Node.js 22+, TypeScript (strict, ES modules, `Node16` module resolution — imports must use `.js` extensions). Tested with Vitest. DB is PostgreSQL via `pg`, database `ai_translate`.

## Commands

- `npm run typecheck` — `tsc --noEmit`, zero errors required.
- `npm test` — run the full Vitest suite (see test caveat below).
- `npm run test:watch` — Vitest watch.
- `npm run build` — compile TS to `dist/`.
- `npm run dev -- <file> -l <lang>` — translate a book via the CLI.
- `npm run web` — start the Express web server on `PORT` (default 3000).
- `npm run web:build` — build the React frontend (Vite) into `src/web/public/`.
- `npm run web:dev` — Vite dev server for the frontend (run separately from `npm run web`).

Running a single test file or test name (Vitest):
```bash
npx vitest run test/db/database.test.js
npx vitest run -t "name of test"
```

## Workflow rules (from AGENTS.md — mandatory before reporting done)

1. `npm run typecheck` — zero errors.
2. `npm test` — all pass. Fix tests broken by your changes; add tests for new functionality.
3. Lint by hand: remove unused imports, dead code, leftover temp files.
4. Commit with `git add -A && git commit -m "<imperative-mood English message>"`. Split multiple logical steps into multiple commits.

Do not report "done" without running tests and committing.

## Architecture notes that require reading multiple files

### Two translation entry points share one DB
- **CLI** (`src/cli/commands.ts`) — direct translation.
- **Web** (`src/web/server.ts` + `src/web/pipeline.ts`) — upload via Express, background job tracked by `src/web/job-queue.ts`, progress pushed over WebSocket (`ws`).
Both go through `src/db/database.ts` (`TranslateDb`, a shared `pg.Pool`) and the block extractor/assembler.

### ID generation is content-addressed (deterministic, not random)
IDs are UUID v5 derived from content hashes so re-importing/re-translating the same input is idempotent. Book ID from `keccak256(fileBytes)`; original block ID from `"bookId:docPath:index:content"`; translation block ID from `"sourceBlockId:lang:model"`; file ID from `keccak256(data)`. See AGENTS.md "ID Generation" — don't switch these to random UUIDs or dedup breaks.

### Block types and the HTML↔Markdown round-trip
Blocks (`heading`, `paragraph`, `image`, `list_item`, `quote`, `code`, `table_row`, `other`) are extracted from parsed HTML to Markdown via Turndown (`block-extractor.ts`) and reassembled Markdown→HTML via markdown-it (`block-assembler.ts`). The round-trip is lossy in edge cases — `test/parsers/inline-formatting.test.js` and `block-assembler.test.js` pin the expected behavior; touch them when changing either side.

### Web API is JSON-RPC 2.0, not REST
`src/web/jsonrpc.ts` is the router (`POST /rpc`); methods are registered in `src/web/rpc-methods.ts`. File uploads arrive as multipart form (`multer`) with the RPC request in an `rpc` form field (`rpcWithFile` in the frontend). Error codes: JSON-RPC reserved (`-32xxx`) plus app-level codes (`10001+`, see `APP_ERRORS` in `jsonrpc.ts`). The React frontend (`src/web/frontend/`) talks to the backend exclusively through `/rpc` via `src/web/frontend/src/api.ts`.

### LLM provider abstraction
`LLM_PROVIDER` env (`lmstudio` | `ollama` | `remote`) selects model lifecycle management (`src/translators/model-manager.ts` loads/unloads models via the `lms` CLI for `lmstudio`). `ollama-client.ts` is the OpenAI-compatible HTTP client used for actual translation. `ocr-client.ts` handles PDF OCR via a vision model. `UPLOAD_ONLY=true` parses and stores without translating — handy for testing the upload pipeline.

## Testing caveats

- `vitest.config.ts` sets `fileParallelism: false` and loads `./test/setup.js` (which runs `import 'dotenv/config'`). DB tests share a global `pg.Pool` — running test files in parallel can close each other's pool. Keep parallelism off.
- Tests read real env vars (`DATABASE_URL`, etc.) from `.env`; a live PostgreSQL `ai_translate` database must be reachable for `test/db/database.test.js` and the integration tests under `test/integration/`.

## Environment

See `.env.example`. Key vars: `DATABASE_URL`, `OPENAI_BASE_URL` (legacy alias `OLLAMA_URL`), `TRANSLATE_MODEL` (legacy `OLLAMA_MODEL`), `OCR_MODEL`, `LLM_PROVIDER`, `OPENAI_API_KEY`, `CHUNK_SIZE`, `PORT`, `UPLOAD_ONLY`. Defaults live in `src/utils/constants.ts`.