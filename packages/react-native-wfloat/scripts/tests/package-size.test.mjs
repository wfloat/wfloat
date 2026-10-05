import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkPackageSize, MAX_PACKAGE_BYTES } from '../check-package-size.mjs';

test('compressed publishing budget includes its boundary and rejects larger packages', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wfloat-size-test-'));
  try {
    const file = path.join(root, 'package.tgz');
    writeFileSync(file, '');
    truncateSync(file, MAX_PACKAGE_BYTES);
    assert.doesNotThrow(() => checkPackageSize(file));
    truncateSync(file, MAX_PACKAGE_BYTES + 1);
    assert.throws(() => checkPackageSize(file), /compressed publishing budget/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
