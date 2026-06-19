# AGENTS.md — ai-translate

## Project Overview
CLI + Web tool for translating EPUB/FB2 books via OpenAI-compatible API.
Blocks are extracted per-paragraph, stored in PostgreSQL, translated one-by-one, then reassembled.

## Tech Stack
- **Runtime:** Node.js 22+ (ES modules)
- **Language:** TypeScript (strict)
- **DB:** PostgreSQL (via pg, database `ai_translate`)
- **Web:** Express 5 + WebSocket (ws)
- **Translation:** OpenAI-compatible /v1/chat/completions API (Ollama, LM Studio, OpenAI, etc.)
- **Testing:** Vitest
- **HTML→Markdown:** Turndown
- **Markdown→HTML:** markdown-it

## Architecture

```
Input file → Parser (Epub/Fb2) → Block Extractor → PostgreSQL DB
                                                    ↓
Output EPUB ← Block Assembler ← Translated blocks ← OllamaClient (block-by-block)
```

### Key Modules
- `src/db/database.ts` — TranslateDb: PostgreSQL books, blocks, files tables, UUID v5 IDs
- `src/parsers/block-extractor.ts` — HTML → Markdown blocks (via Turndown)
- `src/parsers/block-assembler.ts` — Markdown blocks → HTML (via markdown-it)
- `src/translators/ollama-client.ts` — OpenAI-compatible /v1/chat/completions streaming
- `src/web/server.ts` — Express REST API + WebSocket for progress
- `src/web/pipeline.ts` — block-by-block translation pipeline with DB
- `src/web/job-queue.ts` — in-memory job tracker for web UI

### Database Schema
- **books** — id (UUID v5 from keccak256), title, author, language, total_blocks, translated_blocks, target_lang, source_lang, model, timestamps
- **blocks** — id, book_id FK, block_index, doc_path, type, content, lang, model, source_id, file_id FK, tag_name, attributes, created_at. Originals: source_id=NULL, model=NULL. Translations: source_id=original block id, model=model name. Unique index on (source_id, lang, model) for translations.
- **files** — id (UUID v5 from keccak256), book_id FK, original_path, mime_type, data (BYTEA), created_at

### Block Types
`heading`, `paragraph`, `image`, `list_item`, `quote`, `code`, `table_row`, `other`

### ID Generation
- Book ID: `UUIDv5(keccak256(fileBytes), DNS_NS)`
- Block ID (original): `UUIDv5("bookId:docPath:index:content", URL_NS)`
- Block ID (translation): `UUIDv5("sourceBlockId:lang:model", TRANSLATION_NS)`
- File ID: `UUIDv5(keccak256(data), FILE_NS)`

## Key Commands
- `npm test` — run all tests (Vitest)
- `npm run build` — compile TypeScript
- `npm run dev -- book.epub -l ru` — translate via CLI
- `npm run web` — start web UI on port 3000
- `npm run typecheck` — tsc --noEmit

## Workflow Rules (MANDATORY)
At the end of every task, before reporting completion, you MUST:

1. **Typecheck:** `npm run typecheck` — zero errors required
2. **Tests:** `npm test` — all tests must pass. If tests are broken by your changes, fix them. If you added new functionality, add tests for it.
3. **Lint:** Check for unused imports, dead code, leftover temp files. Remove them.
4. **Commit:** Stage and commit all changes with a descriptive message:
   ```bash
   git add -A && git commit -m "description of changes"
   ```
   - Commit message in English, imperative mood (e.g. "Migrate from SQLite to PostgreSQL")
   - If the change spans multiple logical steps, make multiple commits

Do NOT skip any of these steps. Do NOT report "done" without running tests and committing.

## Environment Variables
See `.env.example` — DATABASE_URL, OPENAI_BASE_URL, TRANSLATE_MODEL, OCR_MODEL, OPENAI_API_KEY, LLM_PROVIDER, CHUNK_SIZE, PORT

## File Structure
```
src/
  cli/commands.ts       — CLI (translate, web subcommands)
  db/database.ts         — PostgreSQL manager (pg, Pool)
  parsers/
    epub-parser.ts       — EPUB → ParsedEpub
    fb2-parser.ts         — FB2 → ParsedEpub
    epub-writer.ts       — ParsedEpub → EPUB
    block-extractor.ts   — ParsedEpub → Block[]
    block-assembler.ts   — Block[] → HTML
  translators/
    ollama-client.ts     — OpenAI-compatible API client
    orchestrator.ts      — legacy chunk translator (pre-DB)
  utils/constants.ts     — config defaults from env
  web/
    server.ts            — Express + WebSocket
    pipeline.ts          — block-by-block translation
    job-queue.ts         — in-memory job tracker
    public/index.html     — web UI
  types.ts               — shared interfaces
test/                     — Vitest test files
```