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
import { TranslationOrchestrator } from '../translators/orchestrator.js';
import { SUPPORTED_INPUT_FORMATS, OLLAMA_DEFAULT_URL, DEFAULT_MODEL, DEFAULT_CHUNK_SIZE } from '../utils/constants.js';
import { formatProgress, formatStats } from './progress.js';

/**
 * Detect file format from extension.
 */
function detectFormat(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.epub') return 'epub';
  if (ext === '.fb2') return 'fb2';
  return null;
}

/**
 * Generate output path from input path.
 */
function generateOutputPath(inputPath, targetLang) {
  const dir = path.dirname(inputPath);
  const ext = path.extname(inputPath);
  const base = path.basename(inputPath, ext);
  return path.join(dir, `${base}_${targetLang}.epub`);
}

/**
 * Main translate command handler.
 */
async function translateCommand(inputFile, options) {
  const spinner = ora();

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

    const targetLang = options.lang;
    const sourceLang = options.source || 'auto';
    const model = options.model || DEFAULT_MODEL;
    const url = options.url || OLLAMA_DEFAULT_URL;
    const chunkSize = parseInt(options.chunkSize, 10) || DEFAULT_CHUNK_SIZE;
    const outputPath = options.output || generateOutputPath(inputFile, targetLang);
    const force = options.force || false;
    const dryRun = options.dryRun || false;
    const verbose = options.verbose || false;

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
    console.log(chalk.white(`  Chunk size: ${chunkSize} chars`));
    console.log();

    // Check Ollama availability
    const client = new OllamaClient({ baseUrl: url, model });
    spinner.start('Checking Ollama availability...');
    const available = await client.checkAvailable();
    if (!available) {
      spinner.fail(`Ollama is not available at ${url}`);
      console.error(chalk.gray('Make sure Ollama is running: ollama serve'));
      process.exit(1);
    }
    spinner.succeed('Ollama is available');

    // Parse input file
    spinner.start(`Parsing ${format.toUpperCase()} file...`);
    let parsed;
    if (format === 'epub') {
      const parser = new EpubParser(inputFile);
      parsed = await parser.parse();
    } else if (format === 'fb2') {
      const parser = new Fb2Parser(inputFile);
      parsed = await parser.parse();
    }
    spinner.succeed(`Parsed ${format.toUpperCase()} (${parsed.contentDocs.length} content documents)`);

    if (verbose) {
      console.log(chalk.gray(`  Title: ${parsed.metadata.title}`));
      console.log(chalk.gray(`  Author: ${parsed.metadata.author}`));
      console.log(chalk.gray(`  Language: ${parsed.metadata.language}`));
    }

    // Extract text and count
    const orchestrator = new TranslationOrchestrator(client, { chunkSize });
    let totalNodes = 0;
    for (const doc of parsed.contentDocs) {
      totalNodes += orchestrator.extractTextNodes(doc.dom).length;
    }
    console.log(chalk.white(`  Translatable text nodes: ${totalNodes}`));

    if (dryRun) {
      console.log(chalk.yellow('\n--dry-run mode: no translation performed.'));
      console.log(chalk.white(`  Would translate ${totalNodes} text nodes in ${parsed.contentDocs.length} documents.`));
      return;
    }

    // Translate each content document
    console.log(chalk.cyan('\nTranslating...\n'));
    const totalDocs = parsed.contentDocs.length;
    let completedNodes = 0;

    for (let i = 0; i < totalDocs; i++) {
      const doc = parsed.contentDocs[i];
      const docSpinner = ora(`Document ${i + 1}/${totalDocs}: ${path.basename(doc.path)}`).start();

      await orchestrator.translateDocument(doc.dom, {
        sourceLang: sourceLang === 'auto' ? parsed.metadata.language : sourceLang,
        targetLang,
        onProgress: (progress) => {
          completedNodes = progress.translated;
          docSpinner.text = formatProgress(i + 1, totalDocs, completedNodes, totalNodes, doc.path);
        },
      });

      // Update the content document in the writer
      docSpinner.succeed(formatProgress(i + 1, totalDocs, completedNodes, totalNodes, doc.path, true));
    }

    // Write output
    spinner.start('Writing translated EPUB...');
    const writer = new EpubWriter(parsed);
    for (const doc of parsed.contentDocs) {
      writer.updateContentDoc(doc.path, doc.dom.outerHTML);
    }
    await writer.write(outputPath);
    spinner.succeed(chalk.green(`Written to: ${outputPath}`));

    console.log(chalk.cyan(`\n✅ Translation complete!`));
    console.log(formatStats(totalNodes, totalDocs, outputPath));

  } catch (error) {
    if (spinner.isSpinning) {
      spinner.fail('Error');
    }
    console.error(chalk.red(`\nError: ${error.message}`));
    if (options.verbose && error.stack) {
      console.error(chalk.gray(error.stack));
    }
    process.exit(1);
  }
}

/**
 * Set up and run the CLI.
 */
export function run() {
  const program = new Command();

  program
    .name('ai-translate')
    .description('Translate EPUB/FB2 books using Ollama models while preserving formatting')
    .version('0.1.0')
    .argument('<input>', 'Input file (EPUB or FB2)')
    .option('-o, --output <path>', 'Output file path')
    .option('-l, --lang <target>', 'Target language (required)')
    .option('-s, --source <lang>', 'Source language (default: auto-detect)')
    .option('-m, --model <model>', 'Ollama model name', DEFAULT_MODEL)
    .option('-u, --url <url>', 'Ollama API URL', OLLAMA_DEFAULT_URL)
    .option('-c, --chunk-size <n>', 'Max chars per translation chunk', String(DEFAULT_CHUNK_SIZE))
    .option('-f, --force', 'Overwrite output file if exists')
    .option('--dry-run', 'Show what would be translated without translating')
    .option('-v, --verbose', 'Verbose output')
    .action(translateCommand);

  program.parse();
}