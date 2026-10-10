/**
 * @fileoverview Documentation integrity test suite.
 * Asserts that:
 * 1. All relative markdown links in README.md, docs/protocol.md, and conformance/README.md resolve to existing files.
 * 2. Every exit code and issue code documented in docs/protocol.md matches the implementation / conformance vectors.
 * 3. Every validation issue code tested in conformance vectors appears in docs/protocol.md.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
const PROTOCOL_MD = resolve(ROOT_DIR, 'docs/protocol.md');
const DISTRIBUTION_MD = resolve(ROOT_DIR, 'docs/distribution.md');
const README_MD = resolve(ROOT_DIR, 'README.md');
const CONFORMANCE_README = resolve(ROOT_DIR, 'conformance/README.md');
const CONFORMANCE_DIR = resolve(ROOT_DIR, 'conformance');

const MARKDOWN_FILES = [README_MD, PROTOCOL_MD, DISTRIBUTION_MD, CONFORMANCE_README];

const EXPECTED_EXIT_CODES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 127];

const EXPECTED_ERROR_CODES = new Set([
  'COMMAND_FAILED',
  'INTERNAL_ERROR',
  'UNKNOWN_ERROR',
  'INVALID_REQUEST',
  'VALIDATION_ERROR',
  'PARSE_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'FORBIDDEN',
  'READONLY_VIOLATION',
  'TIMEOUT',
  'SERVICE_UNAVAILABLE',
  'MISSING_CONFIRMATION',
  'UNSUPPORTED_PRODUCT_VERSION',
  'COMMAND_NOT_FOUND',
]);

function getAllJsonFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...getAllJsonFiles(fullPath));
    } else if (entry.endsWith('.json')) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectConformanceIssueCodes() {
  const codes = new Set();
  const jsonFiles = getAllJsonFiles(CONFORMANCE_DIR);
  for (const file of jsonFiles) {
    const content = JSON.parse(readFileSync(file, 'utf-8'));
    if (content && Array.isArray(content.cases)) {
      for (const tc of content.cases) {
        if (tc.expect && Array.isArray(tc.expect.issues)) {
          for (const issue of tc.expect.issues) {
            if (issue.code) {
              codes.add(issue.code);
            }
          }
        }
      }
    }
  }
  return codes;
}

describe('documentation link verification', () => {
  for (const mdPath of MARKDOWN_FILES) {
    const relMd = mdPath.replace(ROOT_DIR + '/', '');

    test(`all relative links in "${relMd}" resolve on disk`, () => {
      assert.ok(existsSync(mdPath), `Markdown file "${relMd}" must exist`);
      const content = readFileSync(mdPath, 'utf-8');

      // Match markdown links: [text](target)
      const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
      let match;
      let checkedCount = 0;

      while ((match = linkRegex.exec(content)) !== null) {
        const rawTarget = match[2].trim();

        // Skip anchors, external web links, mailto
        if (
          rawTarget.startsWith('#') ||
          rawTarget.startsWith('http://') ||
          rawTarget.startsWith('https://') ||
          rawTarget.startsWith('mailto:')
        ) {
          continue;
        }

        // Strip anchor from path if present (e.g. `doc.md#section` -> `doc.md`)
        const targetPath = rawTarget.split('#')[0];
        if (!targetPath) continue;

        const resolved = resolve(dirname(mdPath), targetPath);
        assert.ok(
          existsSync(resolved),
          `In "${relMd}", link to "${rawTarget}" resolved to "${resolved}" which does not exist on disk`,
        );
        checkedCount++;
      }

      if (relMd === 'README.md') {
        assert.ok(checkedCount > 0, `Expected to verify at least one link in "${relMd}"`);
      }
    });
  }
});

describe('protocol.md error & issue codes consistency', () => {
  const protocolText = readFileSync(PROTOCOL_MD, 'utf-8');

  test('all standard exit codes and error categories appear in protocol.md', () => {
    for (const code of EXPECTED_EXIT_CODES) {
      assert.ok(
        protocolText.includes(`\`${code}\``),
        `Exit code ${code} is missing from docs/protocol.md`,
      );
    }

    for (const err of EXPECTED_ERROR_CODES) {
      assert.ok(
        protocolText.includes(`\`${err}\``),
        `Error code "${err}" is missing from docs/protocol.md`,
      );
    }
  });

  test('every issue code in conformance vectors appears in protocol.md', () => {
    const conformanceCodes = collectConformanceIssueCodes();
    assert.ok(conformanceCodes.size > 0, 'Expected non-empty set of conformance issue codes');

    for (const code of conformanceCodes) {
      assert.ok(
        protocolText.includes(`\`${code}\``) || protocolText.includes(`"${code}"`),
        `Issue code "${code}" from conformance vectors does not appear in docs/protocol.md`,
      );
    }
  });
});
