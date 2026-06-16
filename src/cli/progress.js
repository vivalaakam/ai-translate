import chalk from 'chalk';
import path from 'path';

/**
 * Format progress message for translation.
 */
export function formatProgress(docNum, totalDocs, translatedNodes, totalNodes, docPath, done = false) {
  const icon = done ? '✓' : '→';
  const percentage = totalNodes > 0 ? Math.round((translatedNodes / totalNodes) * 100) : 0;
  const barLength = 20;
  const filled = Math.round((percentage / 100) * barLength);
  const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);

  const basename = path.basename(docPath || 'unknown');
  return `${icon} Doc ${docNum}/${totalDocs} [${bar}] ${percentage}% — ${basename}`;
}

/**
 * Format final statistics.
 */
export function formatStats(totalNodes, totalDocs, outputPath) {
  return [
    chalk.white(`  Nodes translated: ${totalNodes}`),
    chalk.white(`  Documents processed: ${totalDocs}`),
    chalk.white(`  Output: ${outputPath}`),
  ].join('\n');
}

/**
 * Format file size in human-readable form.
 */
export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}