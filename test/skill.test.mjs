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

test('bundled Skill routes warehouse questions through discovery and semantic query without SQL', async () => {
  const skill = await fs.readFile(path.join(SKILL_SOURCE, 'SKILL.md'), 'utf8');
  assert.match(skill, /tbcli db datasets --json/);
  assert.match(skill, /tbcli db fields --dataset '<业务表>' --json/);
  assert.match(skill, /tbcli db query/);
  assert.match(skill, /latest available date/);
  assert.match(skill, /最近 N 个有数据日期/);
  assert.match(skill, /at least one imported source row/);
  assert.match(skill, /prefer the narrowest dataset/);
  assert.match(skill, /not a distinct visitor\/UV count/);
  assert.match(skill, /Never ask the employee to write SQL/);
  assert.match(skill, /descriptive average/);
});

test('bundled Skill routes maintainer read-write verification through stable checks', async () => {
  const skill = await fs.readFile(path.join(SKILL_SOURCE, 'SKILL.md'), 'utf8');
  assert.match(skill, /检查数据库读写权限/);
  assert.match(skill, /db access-check --json` first and `db write-check --json` second/);
  assert.match(skill, /probe\.rolledBack: true/);
  assert.match(skill, /probe\.residueCount: 0/);
  assert.match(skill, /Do not replace either check with raw SQL or an ad-hoc script/);
});

test('bundled Skill keeps database credentials outside managed install directories', async () => {
  const skill = await fs.readFile(path.join(SKILL_SOURCE, 'SKILL.md'), 'utf8');
  assert.match(skill, /tbcli db credential-path --json/);
  assert.match(skill, /tbcli db credential-set --pgpass-file/);
  assert.match(skill, /\.config\/tbcli\/pgpass/);
  assert.match(skill, /node_modules/);
  assert.match(skill, /npm.*Skill.*升级.*覆盖/s);
  assert.match(skill, /勿将密码发送到聊天/);
});

test('bundled Skill uses one verified command for CLI and Skill updates', async () => {
  const skill = await fs.readFile(path.join(SKILL_SOURCE, 'SKILL.md'), 'utf8');
  assert.match(skill, /tbcli update --agent/);
  assert.match(skill, /cli\.afterVersion/);
  assert.match(skill, /skill\.state: current/);
  assert.match(skill, /skill\.current: true/);
  assert.match(skill, /throttled update notice/);
  assert.match(skill, /do not mutate a global installation without an explicit update request/);
});

test('bundled Skill has a portable Windows SealSeek adapter', async () => {
  const skill = await fs.readFile(path.join(SKILL_SOURCE, 'SKILL.md'), 'utf8');
  const adapter = await fs.readFile(path.join(SKILL_SOURCE, 'references', 'windows-sealseek.md'), 'utf8');
  assert.match(skill, /references\/windows-sealseek\.md/);
  assert.match(adapter, /runtime-info\.json/);
  assert.match(adapter, /tbcli\.cmd doctor --agent sealseek/);
  assert.match(adapter, /setup sealseek --json/);
  assert.match(adapter, /Do not require.*ExecutionPolicy/s);
  assert.doesNotMatch(adapter, /pechen/i);
  assert.doesNotMatch(adapter, /node-v\d/i);
});

test('bundled Skill keeps recent report maintenance orchestration outside the CLI', async () => {
  const skill = await fs.readFile(path.join(SKILL_SOURCE, 'SKILL.md'), 'utf8');
  const maintenance = await fs.readFile(path.join(SKILL_SOURCE, 'references', 'report-maintenance.md'), 'utf8');
  assert.match(skill, /references\/report-maintenance\.md/);
  assert.match(maintenance, /当前自然年/);
  assert.match(maintenance, /tbcli db coverage/);
  assert.match(maintenance, /--mode replace-range/);
  assert.match(maintenance, /--mode replace-all/);
  assert.match(maintenance, /商品-整体.*--fields all --device overall/);
  assert.match(maintenance, /商品-SKU.*--fields all --device overall/);
  assert.match(maintenance, /商品-整体必须使用 `--device overall --filter '商品状态=Y,N'`/);
  assert.match(maintenance, /经营投产比.*不传 `--device`/);
  assert.match(maintenance, /商品-流量来源.*item-traffic-source.*精确使用旧版维度 `流量来源`/);
  assert.match(maintenance, /禁止选 `流量来源\(新版\)`/);
  assert.match(maintenance, /支付金额筛选.*访客数筛选.*不设置上下限/);
  assert.match(maintenance, /最后一次访问来源.*nearest/);
  assert.match(maintenance, /所有商品.*不传 `--item-ids`/);
  assert.match(maintenance, /100,000 行/);
  assert.match(maintenance, /14 天/);
  assert.match(maintenance, /一级流量来源.*二级流量来源.*三级流量来源/);
  assert.match(maintenance, /不得导入单次全历史或任何触及 100,000 行上限的文件/);
  assert.match(skill, /商品-流量来源详情.*精确指旧版/);
  assert.match(maintenance, /商品-流量来源详情.*item-traffic-source-detail.*流量来源详情/);
  assert.match(maintenance, /禁止选 `流量来源详情\(新版\)`/);
  assert.match(maintenance, /搜索来源.*关键词推广\(原直通车\),手淘搜索,关键词推广/);
  assert.match(maintenance, /搜索词类型.*搜索词.*归属原则/);
  assert.match(maintenance, /23 列/);
  assert.match(maintenance, /任何分片若返回恰好 100,000 行.*二分/);
  assert.match(skill, /商品-整体退款分布.*整体退款分布/);
  assert.match(maintenance, /商品-整体退款分布.*item-refund-overall.*整体退款分布/);
  assert.match(maintenance, /商品-整体退款分布没有筛选项和终端拆分/);
  assert.match(maintenance, /成功退款金额.*成功退款子订单数.*成功退款人数/);
  assert.match(maintenance, /90 天区间/);
  assert.match(maintenance, /商品-整体退款分布-分日-全部商品/);
  assert.match(skill, /商品-退款原因分布.*退款原因分布/);
  assert.match(skill, /商品-流失竞店分布.*流失竞店分布/);
  assert.match(skill, /商品-退款SKU分布.*退款SKU分布/);
  assert.match(maintenance, /商品-退款原因分布.*item-refund-reason/);
  assert.match(maintenance, /时间类型=pay,rfd.*退款场景=ALL.*退款时间=全部,支付30分钟内,30分钟-24小时,24小时-7天,7天-15天,15天以上/);
  assert.match(maintenance, /商品-流失竞店分布.*item-loss-competitor/);
  assert.match(maintenance, /退款后状态.*samepay,otherpay,loss,notbuy-strong,notbuy-weak,notbuy/);
  assert.match(maintenance, /商品-退款SKU分布.*item-refund-sku/);
  assert.match(maintenance, /16 列.*11 列.*12 列/s);
  assert.match(maintenance, /不得跨 `时间类型`.*直接相加/);
  assert.match(maintenance, /平台对某个已请求枚举没有返回明细行.*不能擅自删除该枚举/);
  assert.match(skill, /exactly 100,000 data rows/);
  assert.match(skill, /TRUNCATED_EXPORT/);
  assert.match(skill, /下载历史数据并上传数据库/);
  assert.match(maintenance, /恰好 100,000 行.*实际日期未覆盖目录完整区间.*禁止入库/);
  assert.match(maintenance, /维护默认设置优先于/);
  assert.match(maintenance, /维护流程禁止使用/);
  assert.match(maintenance, /不会.*自行决定维护范围|不自行决定维护范围/);
  assert.doesNotMatch(maintenance, /tbcli sycm sync/);
});

test('npm package includes the canonical companion Skill source', async () => {
  const packageJson = JSON.parse(await fs.readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  assert.ok(packageJson.files.includes('skill'));
  assert.equal(await fs.readFile(path.join(SKILL_SOURCE, 'agents', 'openai.yaml'), 'utf8').then((value) => value.includes('$tbcli')), true);
});
