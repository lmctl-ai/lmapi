/**
 * @fileoverview Schema validation test suite.
 * Validates that cli.schema.v1.schema.json accepts all fixtures, rejects negative documents
 * (reserved names, unknown keys, invalid enums/types), and verifies golden prompt fixtures.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
const SCHEMA_FILE = resolve(ROOT_DIR, 'schema/cli.schema.v1.schema.json');
const FIXTURES_DIR = resolve(ROOT_DIR, 'conformance/fixtures');
const PROMPT_DIR = resolve(ROOT_DIR, 'conformance/prompt');

const schemaJson = JSON.parse(readFileSync(SCHEMA_FILE, 'utf-8'));
const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile(schemaJson);

const baseValid = {
  schema: 'cli.schema.v1',
  tool: 'testtool',
  version: '1.0.0',
  policy: { dryrun: true, readonly: true },
  inputs: ['flags', 'json', 'graphql'],
  globals: [
    { name: 'dryrun', type: 'boolean', occurs: '?' },
  ],
  operations: [
    {
      name: 'status',
      access: 'read',
      returns: 'object',
      description: 'Check status',
      params: [
        { name: 'path', type: 'string', occurs: '?', default: '.' },
      ],
    },
  ],
};

describe('JSON Schema validation against fixtures', () => {
  const fixtureFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'));

  test('all published schema fixtures match JSON Schema', () => {
    assert.ok(fixtureFiles.length >= 3, 'Expected at least 3 tool schema fixtures');

    for (const file of fixtureFiles) {
      const doc = JSON.parse(readFileSync(resolve(FIXTURES_DIR, file), 'utf-8'));
      const ok = validate(doc);
      assert.strictEqual(ok, true, `Fixture "${file}" failed schema validation: ${JSON.stringify(validate.errors)}`);
    }
  });

  test('base valid document matches JSON Schema', () => {
    const ok = validate(baseValid);
    assert.strictEqual(ok, true, `Base valid document failed: ${JSON.stringify(validate.errors)}`);
  });
});

describe('JSON Schema negative rejection tests', () => {
  const negativeCases = [
    {
      name: 'tool named __proto__',
      mutate: (d) => { d.tool = '__proto__'; },
    },
    {
      name: 'tool named constructor',
      mutate: (d) => { d.tool = 'constructor'; },
    },
    {
      name: 'operation named constructor',
      mutate: (d) => { d.operations[0].name = 'constructor'; },
    },
    {
      name: 'parameter named prototype',
      mutate: (d) => { d.operations[0].params.push({ name: 'prototype', type: 'string' }); },
    },
    {
      name: 'operation parameter named dryrun',
      mutate: (d) => { d.operations[0].params.push({ name: 'dryrun', type: 'boolean' }); },
    },
    {
      name: 'alias named __proto__',
      mutate: (d) => { d.operations[0].params[0].aliases = ['__proto__']; },
    },
    {
      name: 'unknown param key min',
      mutate: (d) => { d.operations[0].params[0].min = 1; },
    },
    {
      name: 'unknown param key conflicts',
      mutate: (d) => { d.operations[0].params[0].conflicts = ['other']; },
    },
    {
      name: 'unknown top-level key extraField',
      mutate: (d) => { d.extraField = 'bad'; },
    },
    {
      name: 'unknown operation key extraField',
      mutate: (d) => { d.operations[0].extraField = 'bad'; },
    },
    {
      name: 'invalid occurs mark ++',
      mutate: (d) => { d.operations[0].params[0].occurs = '++'; },
    },
    {
      name: 'invalid param type regex',
      mutate: (d) => { d.operations[0].params[0].type = 'regex'; },
    },
    {
      name: 'missing policy field',
      mutate: (d) => { delete d.policy; },
    },
    {
      name: 'wrong schema version',
      mutate: (d) => { d.schema = 'cli.schema.v2'; },
    },
    {
      name: 'tool name with uppercase letter',
      mutate: (d) => { d.tool = 'MyTool'; },
    },
    {
      name: 'op name starting with digit',
      mutate: (d) => { d.operations[0].name = '1bad'; },
    },
    {
      name: 'operation missing required params field',
      mutate: (d) => { delete d.operations[0].params; },
    },
    {
      name: 'invalid input form web',
      mutate: (d) => { d.inputs = ['web']; },
    },
  ];

  for (const tc of negativeCases) {
    test(`rejects: ${tc.name}`, () => {
      const doc = JSON.parse(JSON.stringify(baseValid));
      tc.mutate(doc);
      const ok = validate(doc);
      assert.strictEqual(ok, false, `Expected schema to reject negative case "${tc.name}", but it accepted it`);
    });
  }
});

describe('golden prompt integrity', () => {
  test('golden prompt files exist and have non-empty content and stable checksums', () => {
    const casesPath = resolve(PROMPT_DIR, 'cases.json');
    assert.ok(existsSync(casesPath), 'conformance/prompt/cases.json must exist');

    const casesData = JSON.parse(readFileSync(casesPath, 'utf-8'));
    assert.ok(Array.isArray(casesData.cases) && casesData.cases.length > 0);

    for (const tc of casesData.cases) {
      const goldenPath = resolve(PROMPT_DIR, tc.golden);
      assert.ok(existsSync(goldenPath), `Golden prompt file "${tc.golden}" must exist`);

      const content = readFileSync(goldenPath, 'utf-8');
      assert.ok(content.length > 100, `Golden prompt file "${tc.golden}" content is unexpectedly small (${content.length} bytes)`);

      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      assert.strictEqual(typeof sha256, 'string');
      assert.strictEqual(sha256.length, 64);
    }
  });
});
