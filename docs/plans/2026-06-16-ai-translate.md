# AI-Translate Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Build a Node.js CLI tool that takes an EPUB or FB2 file, translates its text content through an Ollama model, and produces a translated EPUB file with formatting preserved.

**Architecture:** Pipeline architecture — parse → extract text segments → translate in chunks → reassemble → write EPUB. Each stage is a separate module with a clear interface. EPUB parsing uses `epub2` (or `adm-zip` + manual OPF parsing) to handle the ZIP structure, HTML parsing uses `node-html-parser` for its faithful round-trip capability. FB2 uses `fast-xml-parser`. Translation calls Ollama's local REST API with chunking and retry logic.

**Tech Stack:** Node.js 22+, ES modules, `commander` for CLI, `node-html-parser` for HTML round-trip, `fast-xml-parser` for FB2 XML, `adm-zip` for EPUB ZIP operations, Ollama REST API for translation.

---

## Key Design Decisions

1. **EPUB = ZIP of XHTML files.** We unzip, parse each XHTML content document, translate text nodes while preserving all tags/attributes, then rezip. This avoids breaking the format.

2. **Text extraction preserves inline markers.** We wrap each translatable text segment with a unique marker (`<!--t:N-->...<!--/t:N-->`) so we can put the translated text back in the exact same position. Markers are stripped from the final output.

3. **Chunk-based translation.** Text is split into chunks of ~2000 tokens (approx 8000 chars) with paragraph boundaries respected. Each chunk is sent to Ollama with a system prompt that specifies source/target language.

4. **FB2 → EPUB conversion.** FB2 files are first converted to a normalized internal representation (same as EPUB's), then go through the same translation pipeline. The output is always EPUB regardless of input format.

5. **Idempotent translation.** If the output file already exists and the source hasn't changed, we skip (or use `--force` to overwrite).

---

## Task Breakdown

### Task 1: Project scaffolding + dependencies

**Objective:** Set up project structure, install dependencies, configure tooling.

**Files:**
- Create: `package.json` (already done)
- Create: `src/index.js` — main entry point
- Create: `src/utils/constants.js` — shared constants
- Modify: `package.json` — add dependencies

**Step 1: Install dependencies**

```bash
cd /Users/vivalaakam/work/ai-translate
npm install commander adm-zip node-html-parser fast-xml-parser ora chalk
npm install -D vitest
```

**Step 2: Create src/index.js**

```javascript
#!/usr/bin/env node
import { run } from './cli/commands.js';
run();
```

**Step 3: Create src/utils/constants.js**

```javascript
export const DEFAULT_CHUNK_SIZE = 8000; // chars per translation chunk
export const OLLAMA_DEFAULT_URL = 'http://localhost:11434';
export const DEFAULT_MODEL = 'llama3.1';
export const TEMP_MARKER_PREFIX = 'ai-tr-t';
```

**Step 4: Update package.json scripts**

Add `"start": "node src/index.js"` and `"test": "vitest run"`.

**Step 5: Create initial test**

```javascript
// test/index.test.js
import { describe, it, expect } from 'vitest';

describe('ai-translate', () => {
  it('should have a working test runner', () => {
    expect(1 + 1).toBe(2);
  });
});
```

**Step 6: Verify**

```bash
npx vitest run
```

**Step 7: Commit**

```bash
git add -A && git commit -m "feat: project scaffolding with dependencies"
```

---

### Task 2: EPUB parser module

**Objective:** Parse an EPUB file into its constituent XHTML documents, extracting translatable text segments with position markers.

**Files:**
- Create: `src/parsers/epub-parser.js`
- Create: `test/parsers/epub-parser.test.js`
- Create: `test/fixtures/sample.epub` (minimal test EPUB)

**Step 1: Write failing tests for EPUB parser**

Tests should cover:
- Opening an EPUB file (it's a ZIP)
- Finding content documents from container.xml → content.opf → spine
- Extracting text nodes from XHTML while preserving structure
- Returning a list of content documents with their paths and parsed HTML

**Step 2: Create a minimal test EPUB fixture**

Use `adm-zip` to programmatically create a tiny valid EPUB with:
- `mimetype` file
- `META-INF/container.xml`
- `OEBPS/content.opf`
- `OEBPS/toc.ncx`
- `OEBPS/chapter1.xhtml` with `<p>Hello world</p>`

**Step 3: Implement EPUB parser**

Key exports:
```javascript
export class EpubParser {
  constructor(filePath) { ... }
  async parse() { ... }           // Returns { metadata, contentDocs: [{ path, dom, doc }] }
  getContentDocPaths() { ... }    // Ordered list of XHTML file paths from spine
  getMetadata() { ... }           // Title, author, language
}
```

**Step 4: Run tests**

```bash
npx vitest run test/parsers/
```

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: EPUB parser module"
```

---

### Task 3: FB2 parser module

**Objective:** Parse FB2 (FictionBook2) XML files, extract text with structure, and normalize into the same internal format as EPUB.

**Files:**
- Create: `src/parsers/fb2-parser.js`
- Create: `test/parsers/fb2-parser.test.js`
- Create: `test/fixtures/sample.fb2`

**Step 1: Write failing tests for FB2 parser**

Tests should cover:
- Parsing FB2 XML structure
- Extracting `<body>` sections with `<p>`, `<title>`, `<section>` elements
- Converting to internal content document format
- Preserving inline formatting tags (`<strong>`, `<emphasis>`, etc.)

**Step 2: Create minimal test FB2 fixture**

```xml
<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description><title-info><book-title>Test Book</book-title></title-info></description>
  <body><section><title><p>Chapter 1</p></title><p>Hello world</p></section></body>
</FictionBook>
```

**Step 3: Implement FB2 parser**

Key exports:
```javascript
export class Fb2Parser {
  constructor(filePath) { ... }
  async parse() { ... }          // Returns same format as EpubParser
  getTextSections() { ... }       // Ordered sections with text nodes
  getMetadata() { ... }
}
```

**Step 4: Run tests**

```bash
npx vitest run test/parsers/
```

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: FB2 parser module"
```

---

### Task 4: Ollama translation client

**Objective:** Create a client that communicates with Ollama's REST API to translate text chunks, with retry logic and progress tracking.

**Files:**
- Create: `src/translators/ollama-client.js`
- Create: `test/translators/ollama-client.test.js`

**Step 1: Write failing tests**

Tests should cover:
- Building the correct request payload for Ollama `/api/generate` endpoint
- Chunk splitting at paragraph boundaries
- Retry logic on transient errors (with mocked fetch)
- Rate limiting / concurrent request management

**Step 2: Implement Ollama client**

Key exports:
```javascript
export class OllamaClient {
  constructor({ baseUrl = OLLAMA_DEFAULT_URL, model = DEFAULT_MODEL } = {}) { ... }
  async translate(text, { sourceLang, targetLang, onProgress } = {}) { ... }
  async checkAvailable() { ... }  // Health check — is Ollama running?
  splitIntoChunks(text, maxChars = DEFAULT_CHUNK_SIZE) { ... }
}
```

Translation prompt template:
```
You are a professional translator. Translate the following text from {sourceLang} to {targetLang}. 
Preserve all formatting, paragraph breaks, and special markers exactly as they appear.
Only output the translation, nothing else.

Text to translate:
{text}
```

**Step 3: Run tests**

```bash
npx vitest run test/translators/
```

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: Ollama translation client"
```

---

### Task 5: Translation orchestrator (chunking, preserving formatting)

**Objective:** Orchestrate the full translation pipeline: extract text from parsed documents → chunk → translate → replace text in original document structure.

**Files:**
- Create: `src/translators/orchestrator.js`
- Create: `test/translators/orchestrator.test.js`

**Step 1: Write failing tests**

Tests should cover:
- Extracting text nodes from a parsed HTML DOM
- Splitting extracted text into translation chunks (respecting paragraph boundaries)
- Replacing translated text back into the DOM at correct positions
- Verifying that HTML structure/tags are untouched after replacement

**Step 2: Implement orchestrator**

Key exports:
```javascript
export class TranslationOrchestrator {
  constructor(ollamaClient, options = {}) { ... }
  
  // Extract all translatable text from a content document
  extractTextNodes(dom) { ... }  // Returns [{ id, text, node, parentPath }]
  
  // Group text nodes into chunks for translation
  groupIntoChunks(textNodes, maxChars) { ... }  // Returns [[nodeGroup1], [nodeGroup2], ...]
  
  // Translate all text in a content document
  async translateDocument(dom, { sourceLang, targetLang, onProgress }) { ... }
  
  // Replace text in nodes from translation result
  replaceText(dom, translations) { ... }
}
```

**Critical:** The orchestrator must:
1. Walk the DOM, find all text nodes with non-whitespace content
2. Assign each text node a unique ID (`data-ai-tr-id` attribute on parent)
3. Group nodes into chunks respecting paragraph boundaries
4. Send chunks to OllamaClient with markers in the prompt
5. Parse the response and map translations back to nodes
6. Clean up temporary attributes from the DOM

**Step 3: Run tests**

```bash
npx vitest run test/translators/
```

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: translation orchestrator with chunking"
```

---

### Task 6: EPUB reassembler (write back preserving structure)

**Objective:** Take a parsed + translated EPUB structure and write it back as a valid EPUB file with all formatting, images, stylesheets, and metadata intact.

**Files:**
- Create: `src/parsers/epub-writer.js`
- Create: `test/parsers/epub-writer.test.js`

**Step 1: Write failing tests**

Tests should cover:
- Writing a valid EPUB from parsed content
- Round-trip: parse → modify text → write → re-parse → verify text changed, structure intact
- Preserving binary files (images, fonts)
- Preserving CSS/stylesheets unchanged
- Validating the output EPUB structure (mimetype, container.xml, etc.)

**Step 2: Implement EPUB writer**

Key exports:
```javascript
export class EpubWriter {
  constructor(parsedEpub) { ... }  // Takes output from EpubParser
  updateContentDoc(path, newHtml) { ... }
  async write(outputPath) { ... }
}
```

Implementation:
- Reuse the original ZIP entries
- Only modify the content XHTML files that were translated
- Keep mimetype as first entry, uncompressed
- Keep all other entries (images, CSS, fonts) byte-for-byte identical

**Step 3: Run tests**

```bash
npx vitest run test/parsers/epub-writer.test.js
```

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: EPUB writer module"
```

---

### Task 7: CLI interface

**Objective:** Create the command-line interface using `commander` that ties all modules together.

**Files:**
- Create: `src/cli/commands.js`
- Create: `src/cli/progress.js`

**Step 1: Design CLI interface**

```bash
ai-translate <input> [options]

Options:
  -o, --output <path>      Output file path (default: input_translated.epub)
  -l, --lang <target>      Target language (required)
  -s, --source <lang>      Source language (default: auto-detect)
  -m, --model <model>      Ollama model (default: llama3.1)
  -u, --url <url>          Ollama API URL (default: http://localhost:11434)
  -c, --chunk-size <n>     Max chars per translation chunk (default: 8000)
  -f, --force              Overwrite output file if exists
      --dry-run             Show what would be translated without translating
  -v, --verbose            Verbose output
```

**Step 2: Implement commands.js**

```javascript
import { Command } from 'commander';
import { EpubParser } from '../parsers/epub-parser.js';
import { Fb2Parser } from '../parsers/fb2-parser.js';
import { OllamaClient } from '../translators/ollama-client.js';
import { TranslationOrchestrator } from '../translators/orchestrator.js';
import { EpubWriter } from '../parsers/epub-writer.js';

export async function run() { ... }
```

**Step 3: Implement progress.js**

Use `ora` for spinner progress and `chalk` for colored output:
- Show which file is being processed
- Show translation progress (chunk X/Y)
- Show estimated time remaining
- Show final output path

**Step 4: Add bin entry to package.json**

```json
"bin": {
  "ai-translate": "./src/index.js"
}
```

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: CLI interface with commander"
```

---

### Task 8: Integration tests + end-to-end test

**Objective:** Write integration tests that verify the full pipeline works, and an end-to-end test with a real Ollama instance (skipped if Ollama is not running).

**Files:**
- Create: `test/integration/pipeline.test.js`
- Create: `test/integration/e2e.test.js`

**Step 1: Write integration test**

Tests:
- Parse EPUB → extract text → chunk → mock translate → replace → write → verify
- Parse FB2 → same pipeline
- Round-trip test: verify no structural changes after translate+write
- Error handling: missing file, invalid EPUB, empty content

**Step 2: Write end-to-end test**

Test that:
1. Creates a sample EPUB with real English text
2. Calls the full CLI pipeline (with real Ollama if available, mock otherwise)
3. Verifies the output EPUB is valid and contains translated text
4. Skips with a message if Ollama is not running

**Step 3: Run all tests**

```bash
npx vitest run
```

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: integration and e2e tests"
```

---

## File Structure (Final)

```
ai-translate/
├── package.json
├── .gitignore
├── docs/
│   └── plans/
│       └── 2026-06-16-ai-translate.md
├── src/
│   ├── index.js                    # Entry point
│   ├── cli/
│   │   ├── commands.js             # Commander CLI definition
│   │   └── progress.js             # Spinner/progress UI
│   ├── parsers/
│   │   ├── epub-parser.js          # EPUB → parsed structure
│   │   ├── epub-writer.js          # Parsed structure → EPUB
│   │   └── fb2-parser.js           # FB2 → parsed structure
│   ├── translators/
│   │   ├── ollama-client.js        # Ollama API client
│   │   └── orchestrator.js          # Translation pipeline orchestrator
│   └── utils/
│       └── constants.js            # Shared constants
├── test/
│   ├── index.test.js
│   ├── parsers/
│   │   ├── epub-parser.test.js
│   │   ├── epub-writer.test.js
│   │   └── fb2-parser.test.js
│   ├── translators/
│   │   ├── ollama-client.test.js
│   │   └── orchestrator.test.js
│   ├── integration/
│   │   ├── pipeline.test.js
│   │   └── e2e.test.js
│   └── fixtures/
│       ├── sample.epub
│       └── sample.fb2
└── docs/
    └── plans/
        └── 2026-06-16-ai-translate.md
```