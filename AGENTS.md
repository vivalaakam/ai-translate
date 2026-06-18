# AGENTS.md — ai-translate

## Project Overview
CLI + Web tool for translating EPUB/FB2 books via OpenAI-compatible API.
Blocks are extracted per-paragraph, stored in SQLite, translated one-by-one, then reassembled.

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
Input file → Parser (Epub/Fb2) → Block Extractor → SQLite DB
                                                    ↓
Output EPUB ← Block Assembler ← Translated blocks ← OllamaClient (block-by-block)
```

### Key Modules
- `src/db/database.ts` — TranslateDb: PostgreSQL books, blocks, translations, files tables, UUID v5 IDs
- `src/parsers/block-extractor.ts` — HTML → Markdown blocks (via Turndown)
- `src/parsers/block-assembler.ts` — Markdown blocks → HTML (via markdown-it)
- `src/translators/ollama-client.ts` — OpenAI-compatible /v1/chat/completions streaming
- `src/web/server.ts` — Express REST API + WebSocket for progress
- `src/web/pipeline.ts` — block-by-block translation pipeline with DB
- `src/web/job-queue.ts` — in-memory job tracker for web UI

### Database Schema
- **books** — id (UUID v5 from keccak256), title, author, language, total_blocks, translated_blocks, target_lang, source_lang, model, timestamps
- **blocks** — id (UUID v5 from bookId+text), book_id FK, block_index, doc_path, type, original_md, file_id FK, tag_name, attributes
- **translations** — id (UUID v5 from blockId+lang+model), block_id FK, translated_md, lang, model, created_at (unique per block+lang+model)
- **files** — id (UUID v5 from keccak256), book_id FK, original_path, mime_type, data (BYTEA), created_at

### Block Types
`heading`, `paragraph`, `image`, `list_item`, `quote`, `code`, `table_row`, `other`

### ID Generation
- Book ID: `UUIDv5(keccak256(fileBytes), DNS_NS)`
- Block ID: `UUIDv5("bookId:docPath:index:originalMd", URL_NS)`
- Translation ID: `UUIDv5("blockId:lang:model", TRANSLATION_NS)`
- File ID: `UUIDv5(keccak256(data), FILE_NS)`

## Key Commands
- `npm test` — run all tests (103)
- `npm run build` — compile TypeScript
- `npm run dev -- book.epub -l ru` — translate via CLI
- `npm run web` — start web UI on port 3000
- `npm run typecheck` — tsc --noEmit

## Environment Variables
See `.env.example` — DATABASE_URL, OPENAI_BASE_URL, OLLAMA_MODEL, OPENAI_API_KEY, LLM_PROVIDER, CHUNK_SIZE, PORT

## File Structure
```
src/
  cli/commands.ts       — CLI (translate, web subcommands)
  db/database.ts         — SQLite manager
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