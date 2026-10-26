import fs from 'node:fs/promises';import path from 'node:path';
import {runMaintenance} from '../../package-runtime.mjs';import {packageConfig} from '../package-config.mjs';
const exists=async p=>{try{await fs.access(p);return true;}catch{return false;}};
export async function resolveNpmInvocation({
  platform = process.platform,
  nodePath = process.execPath,
  environment = process.env,
  existsImpl = exists,
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path;
  const explicit = String(environment.TBCLI_NPM_PATH || '').trim();
  if (explicit) {
    if (explicit.endsWith('.js')) return { command: nodePath, prefixArgs: [explicit], shell: false };
    return { command: explicit, prefixArgs: [], shell: platform === 'win32' && /\.cmd$/i.test(explicit) };
  }
  const nodeDir = pathApi.dirname(nodePath);
  const cliCandidates = [
    pathApi.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    pathApi.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of cliCandidates) {
    if (await existsImpl(candidate)) return { command: nodePath, prefixArgs: [candidate], shell: false };
  }
  const sibling = pathApi.join(nodeDir, platform === 'win32' ? 'npm.cmd' : 'npm');
  if (await existsImpl(sibling)) return { command: sibling, prefixArgs: [], shell: platform === 'win32' };
  return { command: platform === 'win32' ? 'npm.cmd' : 'npm', prefixArgs: [], shell: platform === 'win32' };
}

export async function performUnifiedUpdate(opts={}){
 const args=['install'];for(const [k,flag]of [['targetDir','--target-dir'],['agent','--agent'],['skill','--skill']])if(opts[k])args.push(flag,opts[k]);return runMaintenance(packageConfig(),'update',args);
}
export async function performAutomaticUpdate(deps={}){const target=deps.targetDir||process.env.TBCLI_SKILL_TARGET;if(!target)return{updated:false,reason:'selected-target-required'};return performUnifiedUpdate({targetDir:target});}
export async function runUnifiedUpdate(opts={}){const action=opts._?.[1]??'install';if(action==='install')return performUnifiedUpdate(opts);return runMaintenance(packageConfig(),'update',[action,'--json']);}
