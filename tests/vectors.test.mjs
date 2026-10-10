/**
 * @fileoverview Conformance vectors integrity test suite.
 * Validates syntax, structure, schema references, unique case names,
 * documented issue codes, and absence of secrets / absolute paths across all vectors.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
const CONFORMANCE_DIR = resolve(ROOT_DIR, 'conformance');

const VALID_ISSUE_CODES = new Set([
  'UNKNOWN_PARAM',
  'TYPE_MISMATCH',
  'MISSING_REQUIRED',
  'ENUM_VIOLATION',
  'FORM_NOT_ALLOWED',
  'MISSING_VALUE',
  'EXTRA_POSITIONAL',
  'DOCUMENT_PARSE',
  'OP_MISMATCH',
  'MIXED_INPUT',
  'DUPLICATE_FLAG',
  'RESERVED_NAME',
  'SHELL_SYNTAX',
  'UNKNOWN_TOOL',
  'UNKNOWN_OPERATION',
  'FLAG_BEFORE_OP',
]);

const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9_]{36}/,
  /github_pat_[A-Za-z0-9_]{82}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
];

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

describe('conformance vector files integrity', () => {
  const allJsonFiles = getAllJsonFiles(CONFORMANCE_DIR);

  test('conformance directory contains expected JSON files', () => {
    assert.ok(allJsonFiles.length >= 10, `Expected at least 10 JSON files, found ${allJsonFiles.length}`);
  });

  for (const filePath of allJsonFiles) {
    const relPath = filePath.replace(CONFORMANCE_DIR + '/', '');

    test(`file "${relPath}" is valid JSON without secrets or home paths`, () => {
      const raw = readFileSync(filePath, 'utf-8');

      // 1. Valid JSON
      let parsed;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(raw);
      }, `File ${relPath} must be valid JSON`);

      // 2. No absolute paths pointing to user home directories
      assert.strictEqual(
        /\/home\/[a-zA-Z0-9_-]+|\/Users\/[a-zA-Z0-9_-]+/.test(raw),
        false,
        `File ${relPath} contains absolute home directory path`,
      );

      // 3. No secrets or tokens
      for (const secretRe of SECRET_PATTERNS) {
        assert.strictEqual(secretRe.test(raw), false, `File ${relPath} contains potential secret: ${secretRe}`);
      }

      // If it's a test case file (has "cases" array)
      if (parsed && Array.isArray(parsed.cases)) {
        const caseNames = new Set();

        for (const tc of parsed.cases) {
          // Unique case names per file
          assert.ok(typeof tc.name === 'string' && tc.name.length > 0, `${relPath}: case must have a non-empty name`);
          assert.strictEqual(
            caseNames.has(tc.name),
            false,
            `${relPath}: duplicate case name "${tc.name}"`,
          );
          caseNames.add(tc.name);

          // Referenced fixtures exist
          if (typeof tc.schemas === 'string') {
            const fixturePath = resolve(CONFORMANCE_DIR, tc.schemas);
            assert.ok(existsSync(fixturePath), `${relPath} [${tc.name}]: referenced schemas fixture "${tc.schemas}" does not exist`);
          }
          if (typeof tc.golden === 'string') {
            const goldenPath = resolve(dirname(filePath), tc.golden);
            assert.ok(existsSync(goldenPath), `${relPath} [${tc.name}]: referenced golden prompt "${tc.golden}" does not exist`);
          }

          // Expect shape validation
          if (tc.expect) {
            assert.ok(typeof tc.expect.ok === 'boolean', `${relPath} [${tc.name}]: expect.ok must be boolean`);
            if (tc.expect.ok === false && tc.expect.issues) {
              assert.ok(Array.isArray(tc.expect.issues), `${relPath} [${tc.name}]: expect.issues must be an array`);
              for (const issue of tc.expect.issues) {
                assert.ok(typeof issue.code === 'string', `${relPath} [${tc.name}]: issue code must be string`);
                assert.ok(
                  VALID_ISSUE_CODES.has(issue.code),
                  `${relPath} [${tc.name}]: issue code "${issue.code}" must be in documented set (${Array.from(VALID_ISSUE_CODES).join(', ')})`,
                );
              }
            }
          }
        }
      }
    });
  }
});
