/**
 * @fileoverview Validation script for cli.schema.v1.schema.json.
 * Validates the schema itself, validates real published tool schemas,
 * and asserts that negative (invalid) documents are correctly rejected.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
const SCHEMA_FILE = resolve(ROOT_DIR, 'schema/cli.schema.v1.schema.json');

console.log('Loading JSON Schema:', SCHEMA_FILE);
const schemaJson = JSON.parse(readFileSync(SCHEMA_FILE, 'utf-8'));

const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile(schemaJson);

let passedCount = 0;
let rejectedCount = 0;

// 1. Validate real published documents from git2, gh2, aws2
const tools = ['git2', 'gh2', 'aws2'];
for (const tool of tools) {
  const cliPath = resolve(ROOT_DIR, `../../git-poc/packages/${tool}/src/cli.ts`);
  let doc;
  if (existsSync(cliPath)) {
    const stdout = execFileSync('bun', [cliPath, '--schema'], { encoding: 'utf-8' });
    doc = JSON.parse(stdout);
  } else {
    // Fallback to fixture if git-poc packages not found
    const fixturePath = resolve(ROOT_DIR, `conformance/fixtures/${tool}.cli.schema.v1.json`);
    doc = JSON.parse(readFileSync(fixturePath, 'utf-8'));
  }

  const ok = validate(doc);
  if (!ok) {
    console.error(`FAIL: Real document for ${tool} failed schema validation:`, validate.errors);
    process.exit(1);
  }
  console.log(`PASS: Real document for "${tool}" matches schema.`);
  passedCount++;
}

// 2. Base valid schema for negative test permutations
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
      description: 'Show status',
      params: [
        { name: 'path', type: 'string', occurs: '?', description: 'Path to check' },
      ],
    },
  ],
};

const okBase = validate(baseValid);
if (!okBase) {
  console.error('FAIL: Base valid schema unexpectedly failed:', validate.errors);
  process.exit(1);
}
passedCount++;
console.log('PASS: Base valid document matches schema.');

// 3. Negative tests — every document MUST fail validation
const negativeCases = [
  {
    name: 'tool named __proto__',
    mutate: (d) => { d.tool = '__proto__'; },
  },
  {
    name: 'operation named constructor',
    mutate: (d) => { d.operations[0].name = 'constructor'; },
  },
  {
    name: 'parameter named prototype',
    mutate: (d) => { d.operations[0].params[0].name = 'prototype'; },
  },
  {
    name: 'operation parameter named dryrun',
    mutate: (d) => { d.operations[0].params[0].name = 'dryrun'; },
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
    name: 'unknown operation key extraField',
    mutate: (d) => { d.operations[0].extraField = true; },
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
    name: 'tool name with uppercase letter',
    mutate: (d) => { d.tool = 'MyTool'; },
  },
  {
    name: 'op name starting with digit',
    mutate: (d) => { d.operations[0].name = '1status'; },
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
  const doc = JSON.parse(JSON.stringify(baseValid));
  tc.mutate(doc);
  const ok = validate(doc);
  if (ok) {
    console.error(`FAIL: Negative case "${tc.name}" was unexpectedly accepted!`);
    process.exit(1);
  }
  rejectedCount++;
  console.log(`PASS: Negative case "${tc.name}" correctly rejected.`);
}

console.log(`\nSummary: ${passedCount} positive documents passed, ${rejectedCount} negative documents rejected.`);
console.log('All JSON Schema validation checks passed successfully.');
