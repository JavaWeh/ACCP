import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import YAML from 'yaml';

export function loadContracts(root = process.cwd()) {
  const schemaDirectory = resolve(root, 'contracts/schemas');
  const schemas = readdirSync(schemaDirectory).filter((name) => name.endsWith('.schema.json'))
    .map((name) => JSON.parse(readFileSync(resolve(schemaDirectory, name), 'utf8')));
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true });
  addFormats(ajv);
  for (const schema of schemas) ajv.addSchema(schema);
  for (const schema of schemas) {
    if (!ajv.validateSchema(schema)) throw new Error(`Invalid schema ${schema.$id}: ${ajv.errorsText()}`);
    if (schema.$defs) {
      for (const name of Object.keys(schema.$defs)) ajv.getSchema(`${schema.$id}#/$defs/${name}`);
    } else ajv.getSchema(schema.$id);
  }
  return { ajv, schemas };
}

export function checkExamples(root = process.cwd()) {
  const { ajv, schemas } = loadContracts(root);
  const manifestPath = resolve(root, 'contracts/examples/manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const failures = [];
  const coveredEvents = new Set();
  const coveredSchemas = new Set();
  const declaredFiles = new Set();
  let positive = 0;
  let negative = 0;
  for (const entry of manifest.cases) {
    if (declaredFiles.has(entry.file)) throw new Error(`Duplicate example ${entry.file}`);
    declaredFiles.add(entry.file);
    const validator = ajv.getSchema(entry.schema);
    if (!validator) throw new Error(`Unknown schema ${entry.schema}`);
    const data = JSON.parse(readFileSync(resolve(dirname(manifestPath), entry.file), 'utf8'));
    const valid = validator(data);
    if (entry.valid) {
      positive += 1;
      coveredSchemas.add(entry.schema);
      if (data.type?.startsWith('io.accp.')) coveredEvents.add(data.type);
      if (!valid) failures.push(`${entry.file}: ${ajv.errorsText(validator.errors)}`);
    } else {
      negative += 1;
      if (!entry.expected_error) throw new Error(`Negative example lacks expected_error: ${entry.file}`);
      const { keyword, ...params } = entry.expected_error;
      const matched = validator.errors?.some((error) => error.keyword === keyword
        && Object.entries(params).every(([key, value]) => error.params[key] === value));
      if (valid || !matched) failures.push(`${entry.file}: expected rejection ${JSON.stringify(entry.expected_error)}, got ${valid ? 'valid' : ajv.errorsText(validator.errors)}`);
    }
  }
  for (const folder of ['valid', 'invalid']) {
    for (const name of readdirSync(resolve(dirname(manifestPath), folder))) {
      if (name.endsWith('.json') && !declaredFiles.has(`${folder}/${name}`)) failures.push(`Unregistered example ${folder}/${name}`);
    }
  }
  const eventSchema = schemas.find((schema) => schema.$id.endsWith('/event.schema.json'));
  for (const type of eventSchema.properties.type.enum) {
    if (!coveredEvents.has(type)) failures.push(`Missing positive event example ${type}`);
  }
  const domain = schemas.find((schema) => schema.$id.endsWith('/domain.schema.json'));
  for (const name of ['CreateTask', 'Task', 'TaskRun', 'AgentSession', 'ContextSnapshot', 'ContextVersion', 'Artifact', 'Approval', 'ToolInvocation', 'AuditRecord']) {
    if (!coveredSchemas.has(`${domain.$id}#/$defs/${name}`)) failures.push(`Missing core model example ${name}`);
  }
  const api = YAML.parse(readFileSync(resolve(root, 'contracts/openapi.yaml'), 'utf8'));
  let compiled = 0;
  const queue = [api];
  while (queue.length) {
    const value = queue.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'schema' && child && typeof child === 'object') {
        const normalized = JSON.parse(JSON.stringify(child).replace(/\.\/schemas\/([a-z0-9.-]+\.schema\.json)/g, (_match, file) => {
          const schema = schemas.find((candidate) => candidate.$id.endsWith('/' + file));
          if (!schema) throw new Error(`Unknown schema file ${file}`);
          return schema.$id;
        }));
        ajv.compile(normalized);
        compiled += 1;
      } else if (typeof child === 'object') queue.push(child);
    }
  }
  return { failures, positive, negative, compiled };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = checkExamples();
    if (result.failures.length) {
      result.failures.forEach((failure) => console.error(failure));
      process.exitCode = 1;
    } else {
      console.log(`Contracts passed: ${result.positive} positive, ${result.negative} negative examples; ${result.compiled} OpenAPI schema positions compiled.`);
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
