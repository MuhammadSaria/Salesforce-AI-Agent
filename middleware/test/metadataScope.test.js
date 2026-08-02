import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMetadataComponents } from '../src/services/orgInspectionService.js';

test('metadata component validation rejects command-like names', () => {
  assert.throws(
    () => validateMetadataComponents([{ type: 'Flow', apiName: 'Good_Flow; sf org display' }]),
    (error) => error.code === 'INVALID_METADATA_COMPONENT'
  );
});

test('metadata component validation sorts and deduplicates bounded components', () => {
  const components = validateMetadataComponents([
    { type: 'Flow', apiName: 'B_Flow', dependencyLevel: 1 },
    { type: 'Flow', apiName: 'A_Flow', dependencyLevel: 1 },
    { type: 'Flow', apiName: 'A_Flow', dependencyLevel: 1 }
  ], { maxComponents: 3, maxDepth: 2 });

  assert.deepEqual(components.map((item) => `${item.type}:${item.apiName}`), ['Flow:A_Flow', 'Flow:B_Flow']);
});

test('metadata component validation enforces component and dependency-depth bounds', () => {
  assert.throws(
    () => validateMetadataComponents([
      { type: 'Flow', apiName: 'A_Flow', dependencyLevel: 1 },
      { type: 'Flow', apiName: 'B_Flow', dependencyLevel: 1 }
    ], { maxComponents: 1 }),
    (error) => error.code === 'METADATA_SCOPE_LIMIT'
  );

  assert.throws(
    () => validateMetadataComponents([{ type: 'Flow', apiName: 'A_Flow', dependencyLevel: 3 }], { maxDepth: 2 }),
    (error) => error.code === 'DEPENDENCY_DEPTH_LIMIT'
  );
});
