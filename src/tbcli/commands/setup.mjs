import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

import { ensureSkill } from './skill.mjs';
import {
  configureSealseekWindows,
  disablePowerShellTbcliShims,
  discoverSealseekWindows,
  inspectSealseekWindows,
} from '../sealseek-windows.mjs';

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = '@petercjl/tbcli@latest';

async function runCaptured(command, args) {
  try {
    const result = await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, TBCLI_UPDATE_CHECK: '0' },
      windowsHide: true,
    });
    return { stdout: result.stdout || '', stderr: result.stderr || '' };
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || '').trim().slice(-3000);
    throw new Error(`SealSeek 初始化命令执行失败：${detail}`);
  }
}

function parseJsonOutput(output, label) {
  try { return JSON.parse(String(output).trim()); } catch { throw new Error(`${label} 未返回有效 JSON`); }
}

export async function finalizeSealseekSetup(opts = {}, dependencies = {}) {
  const environment = dependencies.environment || await (dependencies.discover || discoverSealseekWindows)();
  const configure = dependencies.configure || configureSealseekWindows;
  const disableShims = dependencies.disableShims || disablePowerShellTbcliShims;
  const ensure = dependencies.ensureSkill || ensureSkill;
  const inspect = dependencies.inspect || inspectSealseekWindows;

  const config = await configure({ environment });
  const skill = await ensure({ agent: 'sealseek', mode: 'copy' });
  const disabledShims = await disableShims(environment);
  const diagnosis = await inspect({ environment });
  const restartRequired = config.changed || disabledShims.length > 0;
  return {
    setup: 'windows-sealseek',
    ok: diagnosis.ok && skill.current,
    restartRequired,
    nextStep: restartRequired ? '请完全退出并重新启动 SealSeek，然后运行 tbcli.cmd doctor --agent sealseek --json' : '运行 tbcli.cmd doctor --agent sealseek --json',
    config,
    skill: { action: skill.action, state: skill.state, current: skill.current, destination: skill.destination },
    disabledPowerShellShims: disabledShims,
    diagnosis: { ...diagnosis, restartRequired },
  };
}

export async function performSealseekSetup(opts = {}, dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  if (platform !== 'win32') throw new Error('tbcli setup sealseek 仅用于 Windows 版 SealSeek');
  if (opts.finalize) return finalizeSealseekSetup(opts, dependencies);

  const environment = dependencies.environment || await (dependencies.discover || discoverSealseekWindows)();
  const run = dependencies.run || runCaptured;
  const exists = dependencies.exists || (async (target) => {
    try { await fs.access(target); return true; } catch { return false; }
  });
  if (!await exists(environment.canonicalEntry)) {
    await run(environment.nodePath, [environment.npmCli, 'install', '--global', '--prefix', environment.npmGlobalDir, PACKAGE_NAME]);
  }
  const finalized = parseJsonOutput((await run(environment.nodePath, [environment.canonicalEntry, 'setup', 'sealseek', '--finalize', '--json'])).stdout, 'SealSeek 初始化');
  const version = (await run(environment.nodePath, [environment.canonicalEntry, '--version'])).stdout.trim().split(/\r?\n/).at(-1);
  if (!version) throw new Error('初始化后无法读取 canonical tbcli 版本');
  return { ...finalized, cli: { version, entry: environment.canonicalEntry, command: environment.canonicalCmd } };
}

export async function runSealseekSetup(opts = {}) {
  console.log(JSON.stringify(await performSealseekSetup(opts), null, 2));
}
