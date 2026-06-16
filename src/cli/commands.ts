#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import fs from 'fs';

import { EpubParser } from '../parsers/epub-parser.js';
import { Fb2Parser } from '../parsers/fb2-parser.js';
import { EpubWriter } from '../parsers/epub-writer.js';
import { OllamaClient } from '../translators/ollama-client.js';
import { TranslateDb, generateBookId } from '../db/database.js';
import { extractAllBlocks } from '../parsers/block-extractor.js';
import { assembleDocHtml } from '../parsers/block-assembler.js';
import { SUPPORTED_INPUT_FORMATS, OLLAMA_DEFAULT_URL, DEFAULT_MODEL, DEFAULT_CHUNK_SIZE, DEFAULT_PORT, DEFAULT_API_KEY, DEFAULT_LLM_PROVIDER } from '../utils/constants.js';
import { formatProgress, formatStats } from './progress.js';
import { startServer } from '../web/server.js';
import { parseProvider, ensureModelLoaded, unloadIfWeLoaded } from '../translators/model-manager.js';
import type { ParsedEpub, Block } from '../types.js';

/**
 * Detect file format from extension.
 */
function detectFormat(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.epub') return 'epub';
  if (ext === '.fb2') return 'fb2';
  return null;
}

/**
 * Generate output path from input path.
 */
function generateOutputPath(inputPath: string, targetLang: string): string {
  const dir = path.dirname(inputPath);
  const ext = path.extname(inputPath);
  const base = path.basename(inputPath, ext);
  return path.join(dir, `${base}_${targetLang}.epub`);
}

/**
 * Main translate command handler — block-by-block via SQLite.
 */
async function translateCommand(inputFile: string, options: Record<string, any>): Promise<void> {
  const spinner = ora();

  // Declare variables needed in finally block
  const model: string = options.model || DEFAULT_MODEL;
  const providerStr: string = options.provider || DEFAULT_LLM_PROVIDER;
  const provider = parseProvider(providerStr);
  let modelLoadedByUs = false;

  try {
    // Validate input file
    if (!fs.existsSync(inputFile)) {
      console.error(chalk.red(`Error: File not found: ${inputFile}`));
      process.exit(1);
    }

    const format = detectFormat(inputFile);
    if (!format) {
      console.error(chalk.red(`Error: Unsupported file format. Supported: ${SUPPORTED_INPUT_FORMATS.join(', ')}`));
      process.exit(1);
    }

    // Validate target language
    if (!options.lang) {
      console.error(chalk.red('Error: Target language is required (-l, --lang)'));
      process.exit(1);
    }

    const targetLang: string = options.lang;
    const sourceLang: string = options.source || 'auto';
    const url: string = options.url || OLLAMA_DEFAULT_URL;
    const apiKey: string = options.apiKey || DEFAULT_API_KEY;
    const outputPath: string = options.output || generateOutputPath(inputFile, targetLang);
    const force: boolean = options.force || false;
    const dryRun: boolean = options.dryRun || false;
    const verbose: boolean = options.verbose || false;

    // Check if output file exists
    if (fs.existsSync(outputPath) && !force) {
      console.error(chalk.red(`Error: Output file already exists: ${outputPath}`));
      console.error(chalk.gray('Use --force to overwrite.'));
      process.exit(1);
    }

    console.log(chalk.cyan(`\n📖 ai-translate: EPUB/FB2 Translation Tool\n`));
    console.log(chalk.white(`  Input:     ${inputFile}`));
    console.log(chalk.white(`  Format:    ${format.toUpperCase()}`));
    console.log(chalk.white(`  Output:    ${outputPath}`));
    console.log(chalk.white(`  Language:  ${sourceLang} → ${targetLang}`));
    console.log(chalk.white(`  Model:     ${model}`));
    console.log(chalk.white(`  API:       ${url}`));
    if (apiKey) {
      console.log(chalk.white(`  API key:   ****${apiKey.slice(-4)}`));
    }
    console.log();

    // Check API availability
    const client = new OllamaClient({ baseUrl: url, model, apiKey });
    spinner.start('Checking API availability...');
    const available = await client.checkAvailable();
    if (!available) {
      spinner.fail(`API is not available at ${url}`);
      console.error(chalk.gray('Make sure your API server is running.'));
      process.exit(1);
    }
    spinner.succeed('API is available');

    // Load model if using LM Studio and it's not already loaded
    if (provider === 'lmstudio') {
      spinner.start(`Checking if model "${model}" is loaded in LM Studio...`);
      modelLoadedByUs = ensureModelLoaded(model, provider);
      if (modelLoadedByUs) {
        spinner.succeed(`Model "${model}" loaded into LM Studio`);
      } else {
        spinner.succeed(`Model "${model}" already loaded in LM Studio`);
      }
    }

    // Parse input file
    spinner.start(`Parsing ${format.toUpperCase()} file...`);
    let parsed: ParsedEpub;
    if (format === 'epub') {
      const parser = new EpubParser(inputFile);
      parsed = await parser.parse();
    } else {
      const parser = new Fb2Parser(inputFile);
      parsed = await parser.parse();
    }
    spinner.succeed(`Parsed ${format.toUpperCase()} (${parsed.contentDocs.length} content documents)`);

    if (verbose) {
      console.log(chalk.gray(`  Title: ${parsed.metadata.title}`));
      console.log(chalk.gray(`  Author: ${parsed.metadata.author}`));
      console.log(chalk.gray(`  Language: ${parsed.metadata.language}`));
    }

    // Generate book ID and open DB
    const fileBuffer = fs.readFileSync(inputFile);
    const bookId = generateBookId(fileBuffer);
    const db = new TranslateDb();

    // Extract blocks and store in DB
    spinner.start('Extracting blocks...');
    const blocks = extractAllBlocks(parsed.contentDocs, bookId);

    // Insert or update book record
    const existingBook = db.getBook(bookId);
    if (!existingBook) {
      db.insertBook({
        id: bookId,
        title: parsed.metadata.title,
        author: parsed.metadata.author,
        language: parsed.metadata.language,
        filename: path.basename(inputFile),
        totalBlocks: blocks.length,
        targetLang,
        sourceLang,
        model,
      });
    } else {
      db.setBookTranslationConfig(bookId, targetLang, sourceLang, model);
    }

    db.insertBlocks(blocks);
    spinner.succeed(`Extracted ${blocks.length} blocks`);

    // Skip image blocks for translation count
    const translatableBlocks = blocks.filter(b => b.type !== 'image');
    console.log(chalk.white(`  Total blocks: ${blocks.length} (translatable: ${translatableBlocks})`));

    if (dryRun) {
      console.log(chalk.yellow('\n--dry-run mode: no translation performed.'));
      console.log(chalk.white(`  Would translate ${translatableBlocks.length} blocks in ${parsed.contentDocs.length} documents.`));
      db.close();
      return;
    }

    // Check if translation already completed
    const untranslated = db.getUntranslatedBlocks(bookId);
    if (untranslated.length === 0) {
      console.log(chalk.green('\n✅ Book is already fully translated!'));
    } else {
      // Translate blocks one by one
      console.log(chalk.cyan('\nTranslating block-by-block...\n'));
      const resolvedSourceLang = sourceLang === 'auto' ? parsed.metadata.language : sourceLang;
      const totalToTranslate = untranslated.length;
      let done = 0;

      for (const block of untranslated) {
        const blockSpinner = ora(`Block ${done + 1}/${totalToTranslate}: ${block.originalMd.slice(0, 50)}...`).start();

        try {
          const translatedMd = await client.translate(block.originalMd, {
            sourceLang: resolvedSourceLang,
            targetLang,
            maxRetries: 3,
          });

          db.updateBlockTranslation(block.id, translatedMd);
          done++;

          const progress = Math.round((done / totalToTranslate) * 100);
          blockSpinner.succeed(`[${progress}%] Block ${done}/${totalToTranslate} ✓`);
        } catch (err: any) {
          // Fallback to original on error
          db.updateBlockTranslation(block.id, block.originalMd);
          done++;
          blockSpinner.warn(`Block ${done}/${totalToTranslate} — fallback to original: ${err.message}`);
        }
      }

      db.updateBookProgress(bookId, db.countBlocks(bookId).translated);
    }

    // Assemble translated EPUB
    spinner.start('Assembling translated EPUB...');
    const writer = new EpubWriter(parsed);
    const docPaths = db.getDocPaths(bookId);

    for (const docPath of docPaths) {
      const docBlocks = db.getBlocksByDoc(bookId, docPath);
      const html = assembleDocHtml(docBlocks);
      writer.updateContentDoc(docPath, html);
    }

    await writer.write(outputPath);
    db.completeBook(bookId);
    db.close();

    spinner.succeed(chalk.green(`Written to: ${outputPath}`));

    const counts = db.countBlocks(bookId);
    console.log(chalk.cyan(`\n✅ Translation complete!`));
    console.log(chalk.white(`  Blocks: ${counts.translated}/${counts.total} translated`));
    console.log(chalk.white(`  Output: ${outputPath}`));

  } catch (error) {
    if (spinner.isSpinning) {
      spinner.fail('Error');
    }
    const err = error as Error;
    console.error(chalk.red(`\nError: ${err.message}`));
    if (options.verbose && err.stack) {
      console.error(chalk.gray(err.stack));
    }
    process.exit(1);
  } finally {
    // Unload model if we loaded it (LM Studio)
    if (modelLoadedByUs) {
      const unloadSpinner = ora(`Unloading model "${model}" from LM Studio...`).start();
      try {
        unloadIfWeLoaded(model, modelLoadedByUs, provider);
        unloadSpinner.succeed(`Model "${model}" unloaded from LM Studio`);
      } catch {
        unloadSpinner.warn(`Failed to unload model "${model}" — you may need to unload manually: lms unload ${model}`);
      }
    }
  }
}

/**
 * Web server command handler.
 */
async function webCommand(options: Record<string, any>): Promise<void> {
  const port = parseInt(options.port, 10) || DEFAULT_PORT;
  const url = options.url || OLLAMA_DEFAULT_URL;
  const model = options.model || DEFAULT_MODEL;
  const apiKey = options.apiKey || DEFAULT_API_KEY;
  const providerStr = options.provider || DEFAULT_LLM_PROVIDER;

  console.log(chalk.cyan('\n🌐 Starting ai-translate web server...\n'));
  console.log(chalk.white(`  Port:      ${port}`));
  console.log(chalk.white(`  API:       ${url}`));
  console.log(chalk.white(`  Model:     ${model}`));
  if (apiKey) {
    console.log(chalk.white(`  API key:   ****${apiKey.slice(-4)}`));
  }
  if (providerStr) {
    console.log(chalk.white(`  Provider:  ${providerStr}`));
  }
  console.log();

  startServer(port, { ollamaUrl: url, defaultModel: model, apiKey, provider: providerStr });
}

/**
 * Set up and run the CLI.
 */
export function run(): void {
  const program = new Command();

  program
    .name('ai-translate')
    .description('Translate EPUB/FB2 books using OpenAI-compatible API while preserving formatting')
    .version('0.2.0');

  // translate command (default)
  program
    .command('translate', { isDefault: true })
    .description('Translate an EPUB/FB2 file')
    .argument('<input>', 'Input file (EPUB or FB2)')
    .option('-o, --output <path>', 'Output file path')
    .option('-l, --lang <target>', 'Target language (required)')
    .option('-s, --source <lang>', 'Source language (default: auto-detect)')
    .option('-m, --model <model>', 'Model name', DEFAULT_MODEL)
    .option('-u, --url <url>', 'API base URL', OLLAMA_DEFAULT_URL)
    .option('-k, --api-key <key>', 'API key (or set OPENAI_API_KEY env)', DEFAULT_API_KEY)
    .option('--provider <type>', 'LLM provider: lmstudio, ollama, remote', DEFAULT_LLM_PROVIDER)
    .option('-f, --force', 'Overwrite output file if exists')
    .option('--dry-run', 'Show what would be translated without translating')
    .option('-v, --verbose', 'Verbose output')
    .action(translateCommand);

  // web command
  program
    .command('web')
    .description('Start web server for browser-based translation')
    .option('-p, --port <port>', 'Server port', String(DEFAULT_PORT))
    .option('-u, --url <url>', 'API base URL', OLLAMA_DEFAULT_URL)
    .option('-m, --model <model>', 'Default model', DEFAULT_MODEL)
    .option('-k, --api-key <key>', 'API key (or set OPENAI_API_KEY env)', DEFAULT_API_KEY)
    .option('--provider <type>', 'LLM provider: lmstudio, ollama, remote', DEFAULT_LLM_PROVIDER)
    .action(webCommand);

  program.parse();
}