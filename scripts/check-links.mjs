import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, relative, extname, isAbsolute } from 'node:path';
import MarkdownIt from 'markdown-it';
import GithubSlugger from 'github-slugger';
import { publicFiles, isForbiddenPath } from './check-private.mjs';

const root = process.cwd();
const markdown = new MarkdownIt({ html: true });
const files = publicFiles(root).filter((file) => file.endsWith('.md') && !isForbiddenPath(file));
const anchors = new Map();
const failures = [];

for (const file of files) {
  if (!existsSync(file)) continue;
  const tokens = markdown.parse(readFileSync(file, 'utf8'), {});
  const slugger = new GithubSlugger();
  const ids = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].type !== 'heading_open') continue;
    const inline = tokens[i + 1];
    const text = (inline.children ?? []).filter((token) => ['text', 'code_inline', 'image'].includes(token.type))
      .map((token) => token.content).join('');
    ids.add(slugger.slug(text));
  }
  anchors.set(resolve(file), ids);
}

for (const file of files) {
  if (!existsSync(file)) continue;
  const queue = [...markdown.parse(readFileSync(file, 'utf8'), {})];
  while (queue.length) {
    const token = queue.pop();
    if (token.children) queue.push(...token.children);
    const href = token.type === 'image' ? token.attrGet('src') : token.type === 'link_open' ? token.attrGet('href') : null;
    if (!href || /^(https?:|mailto:)/i.test(href)) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
      failures.push(`${file}: unsupported local link ${href}`);
      continue;
    }
    const hash = href.indexOf('#');
    const targetPart = hash < 0 ? href : href.slice(0, hash);
    const fragment = hash < 0 ? '' : decodeURIComponent(href.slice(hash + 1));
    const localPath = decodeURIComponent(targetPart.split('?')[0]);
    const target = localPath ? resolve(dirname(file), localPath) : resolve(file);
    const fromRoot = relative(root, target);
    if (isAbsolute(localPath) || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('..\\') || fromRoot.startsWith('../')) {
      failures.push(`${file}: link leaves repository ${href}`);
    } else if (isForbiddenPath(fromRoot)) {
      failures.push(`${file}: link points to local/private content ${href}`);
    } else if (!existsSync(target)) {
      failures.push(`${file}: missing link target ${href}`);
    } else if (fragment && extname(target) === '.md' && statSync(target).isFile() && !anchors.get(target)?.has(fragment)) {
      failures.push(`${file}: missing heading ${href}`);
    }
  }
}

if (failures.length) {
  failures.forEach((failure) => console.error(failure));
  process.exitCode = 1;
} else {
  console.log(`Internal links and heading anchors passed (${files.length} Markdown files).`);
}
