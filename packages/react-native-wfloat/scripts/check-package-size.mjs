import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Our conservative publishing budget, not a claim about npm's exact limit.
// npm embeds the compressed tarball as base64 in a larger JSON request.
export const MAX_PACKAGE_BYTES = 180 * 1024 * 1024;
export function checkPackageSize(file) {
  const size = statSync(file).size;
  if (size > MAX_PACKAGE_BYTES) throw new Error(`Package is ${size} bytes; exceeds our ${MAX_PACKAGE_BYTES}-byte compressed publishing budget.`);
  console.log(`Package size: ${size} bytes (budget: ${MAX_PACKAGE_BYTES}).`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node check-package-size.mjs <tarball>');
  checkPackageSize(process.argv[2]);
}
