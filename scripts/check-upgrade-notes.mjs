import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const RELEASES_DIR = 'docs/releases';
const VERSION_FILE_RE = /^v.+\.md$/;

/** Headings that every release notes file must contain (exact ## title after normalize). */
export const REQUIRED_SECTIONS = [
  'Compatibility',
  'Migrations',
  'Grants / privileges',
  'Config / secrets / compose',
  'Breaking / operator actions',
  'Reviewed-against',
  'Artifacts',
];

const GRANTS_SQL_RE = /deploy\/production\/grants\.sql/i;
const ACCP_OPS_CHECK_RE = /accp-ops\s+check/i;

/**
 * Parse CLI args.
 * @param {string[]} argv
 * @returns {{ version: string | null, help: boolean }}
 */
export function parseArgs(argv) {
  let version = null;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--version') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) {
        throw new Error('Usage: node scripts/check-upgrade-notes.mjs [--version vX.Y.Z]');
      }
      version = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\nUsage: node scripts/check-upgrade-notes.mjs [--version vX.Y.Z]`);
  }
  return { version, help };
}

/**
 * @param {string} root
 * @returns {string[]} absolute paths to docs/releases/v*.md
 */
export function listReleaseNoteFiles(root) {
  const dir = join(root, RELEASES_DIR);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => VERSION_FILE_RE.test(name) && name.toLowerCase() !== 'readme.md')
    .sort()
    .map((name) => join(dir, name));
}

/**
 * Normalize a markdown heading title for comparison.
 * @param {string} title
 */
export function normalizeHeading(title) {
  return title.replace(/\s+/g, ' ').trim();
}

/**
 * Extract ## headings and the body under each until the next ##.
 * @param {string} markdown
 * @returns {{ title: string | null, sections: Map<string, string> }}
 */
export function parseReleaseNotes(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let title = null;
  /** @type {Map<string, string>} */
  const sections = new Map();
  let current = null;
  /** @type {string[]} */
  let buffer = [];

  const flush = () => {
    if (current !== null) {
      sections.set(current, buffer.join('\n').trim());
    }
    buffer = [];
  };

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1 && title === null) {
      title = h1[1].trim();
      continue;
    }
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      flush();
      current = normalizeHeading(h2[1]);
      continue;
    }
    if (current !== null) {
      buffer.push(line);
    }
  }
  flush();
  return { title, sections };
}

/**
 * Paths listed as bullets under Reviewed-against.
 * @param {string} body
 * @returns {string[]}
 */
export function reviewedAgainstPaths(body) {
  const paths = [];
  for (const line of body.split('\n')) {
    const match = line.match(/^\s*[-*]\s+`?([^\s`]+)`?\s*$/);
    if (!match) continue;
    const path = match[1].replace(/^\.\//, '');
    if (path.startsWith('docs/') || path.startsWith('deploy/') || path.startsWith('contracts/')) {
      paths.push(path);
    } else if (/\.(md|sql|yml|yaml)$/i.test(path)) {
      paths.push(path);
    }
  }
  return paths;
}

/**
 * Validate one release notes file.
 * @param {string} root repo root
 * @param {string} filePath absolute path
 * @param {{ expectVersion?: string | null }} [opts]
 * @returns {string[]} error messages (empty = ok)
 */
export function validateReleaseNotesFile(root, filePath, opts = {}) {
  const errors = [];
  const relative = filePath.replace(/\\/g, '/').includes(`${RELEASES_DIR}/`)
    ? filePath.replace(/\\/g, '/').slice(filePath.replace(/\\/g, '/').lastIndexOf(`${RELEASES_DIR}/`))
    : filePath;
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  const fileVersion = base.replace(/\.md$/i, '');

  if (opts.expectVersion && fileVersion !== opts.expectVersion) {
    errors.push(`${relative}: file version ${fileVersion} does not match --version ${opts.expectVersion}`);
  }

  let markdown;
  try {
    markdown = readFileSync(filePath, 'utf8');
  } catch (error) {
    errors.push(`${relative}: cannot read (${error.message})`);
    return errors;
  }

  if (!markdown.trim()) {
    errors.push(`${relative}: file is empty`);
    return errors;
  }

  const { title, sections } = parseReleaseNotes(markdown);
  if (!title) {
    errors.push(`${relative}: missing level-1 title`);
  } else if (title !== fileVersion) {
    errors.push(`${relative}: title "${title}" must match file version ${fileVersion}`);
  }

  for (const name of REQUIRED_SECTIONS) {
    if (!sections.has(name)) {
      errors.push(`${relative}: missing required section "## ${name}"`);
    } else if (!sections.get(name)?.trim()) {
      errors.push(`${relative}: section "## ${name}" must not be empty`);
    }
  }

  const grantsBody = sections.get('Grants / privileges') ?? '';
  if (sections.has('Grants / privileges')) {
    if (!GRANTS_SQL_RE.test(grantsBody)) {
      errors.push(`${relative}: Grants / privileges must mention deploy/production/grants.sql`);
    }
    if (!ACCP_OPS_CHECK_RE.test(grantsBody)) {
      errors.push(`${relative}: Grants / privileges must mention accp-ops check`);
    }
  }

  const reviewed = sections.get('Reviewed-against') ?? '';
  if (sections.has('Reviewed-against')) {
    const paths = reviewedAgainstPaths(reviewed);
    if (paths.length < 3) {
      errors.push(`${relative}: Reviewed-against must list at least three in-repo document paths`);
    }
    for (const path of paths) {
      const absolute = join(root, path);
      if (!existsSync(absolute)) {
        errors.push(`${relative}: Reviewed-against path does not exist: ${path}`);
      }
    }
  }

  return errors;
}

/**
 * @param {string} root
 * @param {{ version?: string | null }} [opts]
 * @returns {{ ok: boolean, checked: string[], errors: string[] }}
 */
export function checkUpgradeNotes(root, opts = {}) {
  const version = opts.version ?? null;
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  let files = listReleaseNoteFiles(root);

  if (version) {
    const expected = join(root, RELEASES_DIR, `${version}.md`);
    if (!existsSync(expected)) {
      return {
        ok: false,
        checked: [],
        errors: [`Missing release notes for ${version}: ${RELEASES_DIR}/${version}.md`],
      };
    }
    files = [expected];
  }

  if (files.length === 0) {
    return {
      ok: false,
      checked: [],
      errors: [`No ${RELEASES_DIR}/v*.md files found`],
    };
  }

  const checked = [];
  for (const file of files) {
    checked.push(file.replace(/\\/g, '/').slice(root.replace(/\\/g, '/').length).replace(/^\//, ''));
    errors.push(...validateReleaseNotesFile(root, file, { expectVersion: version }));
  }

  return { ok: errors.length === 0, checked, errors };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { version, help } = parseArgs(process.argv.slice(2));
    if (help) {
      console.log('Usage: node scripts/check-upgrade-notes.mjs [--version vX.Y.Z]');
      process.exitCode = 0;
    } else {
      const result = checkUpgradeNotes(process.cwd(), { version });
      if (!result.ok) {
        console.error('Upgrade notes check failed:');
        for (const error of result.errors) console.error(`  ${error}`);
        process.exitCode = 1;
      } else {
        console.log(`Upgrade notes check passed (${result.checked.length} file(s)).`);
      }
    }
  } catch (error) {
    console.error(`Upgrade notes check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
