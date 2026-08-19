import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_NAME = 'tbcli';
const MANIFEST = '.tbcli-managed.json';
const SOURCE = fileURLToPath(new URL('../../../skill/tbcli', import.meta.url));
const AGENT_ROOTS = Object.freeze({
  codex: path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills'),
  agents: path.join(os.homedir(), '.agents', 'skills'),
  openclaw: path.join(os.homedir(), '.openclaw', 'skills'),
  sealseek: path.join(os.homedir(), '.sealseek', 'skill_pool'),
});

export async function runSkillSource(opts = {}) {
  const result = {
    skill: SKILL_NAME,
    source: SOURCE,
    sourceDigest: await skillDigest(SOURCE),
    installHint: 'tbcli skill install --agent codex',
  };
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else console.log(SOURCE);
}

export async function runSkillStatus(opts = {}) {
  console.log(JSON.stringify(await getSkillStatus(resolveTargetRoot(opts)), null, 2));
}

export async function runSkillInstall(opts = {}) {
  const root = resolveTargetRoot(opts);
  const destination = path.join(root, SKILL_NAME);
  if (await pathExists(destination, { includeBrokenLink: true })) {
    throw new Error(`目标已存在，拒绝替换：${destination}；请先运行 tbcli skill status`);
  }
  if (!await isDirectory(SOURCE)) throw new Error(`tbcli 配套 Skill 源不存在：${SOURCE}`);
  const requestedMode = String(opts.mode || 'auto');
  if (!['auto', 'link', 'copy'].includes(requestedMode)) throw new Error('--mode 必须是 auto、link 或 copy');
  const mode = requestedMode === 'auto' ? (process.platform === 'win32' ? 'copy' : 'link') : requestedMode;
  await fs.mkdir(root, { recursive: true });
  if (mode === 'link') await fs.symlink(SOURCE, destination, process.platform === 'win32' ? 'junction' : 'dir');
  else await installManagedCopy(destination);
  console.log(JSON.stringify({ ...await getSkillStatus(root), action: 'installed' }, null, 2));
}

export async function runSkillUpdate(opts = {}) {
  const root = resolveTargetRoot(opts);
  const before = await getSkillStatus(root);
  if (before.state === 'absent') throw new Error(`Skill 尚未安装：${before.destination}`);
  if (before.state === 'current') {
    console.log(JSON.stringify({ ...before, action: 'unchanged' }, null, 2));
    return;
  }
  if (before.mode !== 'copy' || !before.managed) {
    throw new Error(`拒绝更新非 tbcli 管理的 Skill：${before.destination}`);
  }
  const backupRoot = path.join(os.homedir(), '.local', 'state', 'tbcli', 'skill-backups');
  await fs.mkdir(backupRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const backup = path.join(backupRoot, `${SKILL_NAME}-${stamp}`);
  if (await pathExists(backup, { includeBrokenLink: true })) throw new Error(`备份路径已存在：${backup}`);
  await fs.rename(before.destination, backup);
  try {
    await installManagedCopy(before.destination);
  } catch (error) {
    if (!await pathExists(before.destination, { includeBrokenLink: true })) await fs.rename(backup, before.destination);
    throw error;
  }
  console.log(JSON.stringify({ ...await getSkillStatus(root), action: 'updated', backup }, null, 2));
}

export async function getSkillStatus(root) {
  const destination = path.join(root, SKILL_NAME);
  const sourceDigest = await skillDigest(SOURCE);
  const base = { skill: SKILL_NAME, source: SOURCE, sourceDigest, targetRoot: root, destination };
  let stat;
  try { stat = await fs.lstat(destination); } catch (error) {
    if (error?.code === 'ENOENT') return { ...base, state: 'absent', managed: false, current: false };
    throw error;
  }
  if (stat.isSymbolicLink()) {
    let resolved;
    try { resolved = await fs.realpath(destination); } catch (error) {
      if (error?.code === 'ENOENT') return { ...base, state: 'broken-link', mode: 'link', managed: true, current: false };
      throw error;
    }
    const current = resolved === await fs.realpath(SOURCE);
    return { ...base, state: current ? 'current' : 'foreign-link', mode: 'link', managed: current, current, resolved };
  }
  const manifest = await readManifest(destination);
  const managed = manifest.managedBy === 'tbcli' && manifest.skill === SKILL_NAME;
  if (!managed) return { ...base, state: 'unmanaged', mode: 'copy', managed: false, current: false };
  const current = manifest.sourceDigest === sourceDigest;
  return { ...base, state: current ? 'current' : 'stale', mode: 'copy', managed: true, current, installedDigest: manifest.sourceDigest };
}

export function resolveTargetRoot(opts = {}) {
  const agent = String(opts.agent || '').trim();
  const targetDir = String(opts.targetDir || '').trim();
  if (Boolean(agent) === Boolean(targetDir)) throw new Error('必须且只能提供 --agent 或 --target-dir');
  if (agent) {
    if (!AGENT_ROOTS[agent]) throw new Error(`--agent 必须是：${Object.keys(AGENT_ROOTS).join('、')}`);
    return path.resolve(AGENT_ROOTS[agent]);
  }
  return path.resolve(targetDir);
}

async function installManagedCopy(destination) {
  await fs.cp(SOURCE, destination, { recursive: true, errorOnExist: true, force: false });
  const manifest = {
    managedBy: 'tbcli', skill: SKILL_NAME, sourceDigest: await skillDigest(SOURCE), installedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(destination, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

async function readManifest(destination) {
  try { return JSON.parse(await fs.readFile(path.join(destination, MANIFEST), 'utf8')); } catch { return {}; }
}

async function skillDigest(root) {
  if (!await isDirectory(root)) return '';
  const hash = crypto.createHash('sha256');
  for (const file of await listFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (relative === MANIFEST) continue;
    hash.update(relative); hash.update('\0'); hash.update(await fs.readFile(file)); hash.update('\0');
  }
  return hash.digest('hex');
}

async function listFiles(root) {
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const current = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(current));
    else if (entry.isFile()) files.push(current);
  }
  return files.sort();
}

async function isDirectory(target) {
  try { return (await fs.stat(target)).isDirectory(); } catch { return false; }
}

async function pathExists(target, { includeBrokenLink = false } = {}) {
  try { await (includeBrokenLink ? fs.lstat(target) : fs.stat(target)); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
