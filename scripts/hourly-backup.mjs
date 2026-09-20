import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, appendFileSync, readdirSync, lstatSync, unlinkSync, copyFileSync, constants, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const { values } = parseArgs({ options: Object.fromEntries(['directory','database-url-file','recipient-file','config-manifest','image','ops-image','network'].map(name => [name, { type: 'string' }])) });
for (const name of ['directory','database-url-file','recipient-file','config-manifest','image','ops-image','network']) if (!values[name]) throw new Error(`--${name} required`);
const directory = resolve(values.directory);
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (lstatSync(directory).isSymbolicLink()) throw new Error('Backup directory cannot be a symbolic link');
const root = realpathSync(directory), lock = join(root, 'backup.lock');
const fd = openSync(lock, 'wx', 0o600);
const id = randomUUID(), timestamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const filename = `accp-hourly-${timestamp}-${id}.age`;
const journal = (phase, extra = {}) => appendFileSync(join(root, 'backup-journal.jsonl'), JSON.stringify({ id, at: new Date().toISOString(), phase, file: filename, ...extra }) + '\n', { mode: 0o600 });
try {
  writeFileSync(fd, JSON.stringify({ pid: process.pid, id, at: timestamp }));
  journal('STARTED');
  const recipient = readFileSync(resolve(values['recipient-file']), 'utf8').trim();
  if (!/^age1[0-9a-z]+$/.test(recipient)) throw new Error('Expected an age public recipient, not a private identity');
  const result = spawnSync('docker', ['run','--rm',...(process.getuid ? ['--user',`${process.getuid()}:${process.getgid()}`] : []),'--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--tmpfs','/tmp:rw,noexec,nosuid,size=4g','--network',values.network,
    '--mount',`type=bind,source=${root},target=/backups`,
    '--mount',`type=bind,source=${resolve(values['database-url-file'])},target=/run/db-url,readonly`,
    '--mount',`type=bind,source=${resolve(values['config-manifest'])},target=/run/config.json,readonly`,
    values['ops-image'],'backup','--database-url-file','/run/db-url','--recipient',recipient,'--config-manifest','/run/config.json','--image',values.image,'--output',`/backups/${filename}`], { encoding:'utf8', windowsHide:true, timeout:55*60*1000, maxBuffer:2*1024*1024 });
  if (result.status !== 0) throw new Error('Backup command failed; inspect local operator diagnostics');
  const manifest = JSON.parse(result.stdout);
  if (manifest.format !== 1 || !manifest.dump_sha256) throw new Error('Backup did not return a verified export manifest');
  const daily = `accp-daily-${timestamp.slice(0,8)}.age`;
  try { copyFileSync(join(root, filename), join(root, daily), constants.COPYFILE_EXCL); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  let pruned = 0;
  for (const [pattern, keep] of [[/^accp-hourly-\d{8}T\d{6}Z-[a-f0-9-]{36}\.age$/,48],[/^accp-daily-\d{8}\.age$/,30]]) {
    const entries = readdirSync(root).filter(name => pattern.test(name)).sort().reverse();
    for (const name of entries.slice(keep)) {
      const path = join(root, name), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unexpected backup retention entry');
      unlinkSync(path); pruned++;
    }
  }
  journal('SUCCEEDED', { snapshot_at:manifest.snapshot_at, dump_sha256:manifest.dump_sha256, pruned });
  console.log(JSON.stringify({ ok:true, file:filename, snapshot_at:manifest.snapshot_at, pruned }));
} catch (error) {
  journal('FAILED'); throw error;
} finally { closeSync(fd); unlinkSync(lock); }
