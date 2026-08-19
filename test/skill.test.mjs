import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { getSkillStatus, resolveTargetRoot } from '../src/tbcli/commands/skill.mjs';

const SKILL_SOURCE = fileURLToPath(new URL('../skill/tbcli', import.meta.url));

test('companion Skill target requires exactly one explicit root selector', () => {
  const target = resolveTargetRoot({ targetDir: './test-target' });
  assert.equal(target, path.resolve('./test-target'));
  assert.throws(() => resolveTargetRoot({}), /必须且只能提供/);
  assert.throws(() => resolveTargetRoot({ agent: 'codex', targetDir: './x' }), /必须且只能提供/);
  assert.throws(() => resolveTargetRoot({ agent: 'unknown' }), /--agent 必须是/);
});

test('companion Skill status recognizes absent and canonical linked installs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-skill-test-'));
  try {
    const absent = await getSkillStatus(root);
    assert.equal(absent.state, 'absent');
    await fs.symlink(SKILL_SOURCE, path.join(root, 'tbcli'), 'dir');
    const current = await getSkillStatus(root);
    assert.equal(current.state, 'current');
    assert.equal(current.mode, 'link');
    assert.equal(current.managed, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('bundled Skill routes the multi-report recent-30-day request through direct preflight and fetch', async () => {
  const skill = await fs.readFile(path.join(SKILL_SOURCE, 'SKILL.md'), 'utf8');
  assert.match(skill, /店铺-整体和商品-整体/);
  assert.match(skill, /最近30天的分日数据/);
  assert.match(skill, /ending yesterday/);
  assert.match(skill, /preflight both catalogs with `day`/);
  assert.match(skill, /two direct `sycm fetch` commands with `--fields all`/);
  assert.match(skill, /one Excel per table/);
});

test('bundled Skill routes product IDs, all history, and all terminals through direct fetch', async () => {
  const skill = await fs.readFile(path.join(SKILL_SOURCE, 'SKILL.md'), 'utf8');
  assert.match(skill, /--item-ids/);
  assert.match(skill, /--all-history/);
  assert.match(skill, /--device all/);
  assert.match(skill, /最多 100/);
});

test('npm package includes the canonical companion Skill source', async () => {
  const packageJson = JSON.parse(await fs.readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  assert.ok(packageJson.files.includes('skill'));
  assert.equal(await fs.readFile(path.join(SKILL_SOURCE, 'agents', 'openai.yaml'), 'utf8').then((value) => value.includes('$tbcli')), true);
});
