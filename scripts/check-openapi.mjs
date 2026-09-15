import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Redocly resolves references by file location; JSON Schema resolves them by $id.
// Lint an offline mirror with only the known canonical schema URLs localized.
// check-contracts separately compiles the untouched schemas by their real $id.
const root = process.cwd();
mkdirSync(resolve(root, '.accp-local'), { recursive: true });
const mirror = mkdtempSync(resolve(root, '.accp-local/openapi-'));
try {
  mkdirSync(resolve(mirror, 'schemas'));
  const files = readdirSync(resolve(root, 'contracts/schemas')).filter((name) => name.endsWith('.schema.json'));
  const schemas = files.map((name) => [name, JSON.parse(readFileSync(resolve(root, 'contracts/schemas', name), 'utf8'))]);
  const identities = new Map(schemas.map(([name, schema]) => [schema.$id, name]));
  const localize = (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') {
      const [base, fragment] = value.$ref.split('#');
      if (identities.has(base)) value.$ref = `./${identities.get(base)}${fragment === undefined ? '' : `#${fragment}`}`;
      else if (/^https?:/.test(base)) throw new Error(`Unexpected external schema reference: ${base}`);
    }
    for (const child of Object.values(value)) localize(child);
  };
  for (const [name, schema] of schemas) {
    localize(schema);
    writeFileSync(resolve(mirror, 'schemas', name), JSON.stringify(schema, null, 2));
  }
  writeFileSync(resolve(mirror, 'openapi.yaml'), readFileSync(resolve(root, 'contracts/openapi.yaml')));
  execFileSync(process.execPath, [resolve(root, 'node_modules/@redocly/cli/bin/cli.js'), 'lint', resolve(mirror, 'openapi.yaml'), '--config', resolve(root, 'redocly.yaml')], { stdio: 'inherit' });
} finally {
  // mkdtemp created this exact directory below the workspace; never remove caller-supplied paths.
  rmSync(mirror, { recursive: true, force: true });
}
