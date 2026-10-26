import path from 'node:path';
import {maintenanceSource,maintenanceStatus,syncSkill} from '../../package-runtime.mjs';
import {packageConfig} from '../package-config.mjs';
export function resolveSkillName(opts={}){const c=packageConfig(),name=opts.skill??'tbcli';if(!c.skills.includes(name))throw Error('UNKNOWN_SKILL');return name;}
export function resolveTargetRoot(opts={}){const root=opts.targetDir??process.env.TBCLI_SKILL_TARGET;if(!root)throw Object.assign(Error('Provide explicit --target-dir for the current Agent; named-host paths are not inferred.'),{code:'TARGET_REQUIRED'});if(opts.agent&&!/^[a-z][a-z0-9-]{0,63}$/.test(opts.agent))throw Error('INVALID_AGENT');return path.resolve(root);}
export async function getSkillStatus(root,skill='tbcli'){return maintenanceStatus(packageConfig(),{targetDir:root,skill});}
export async function installSkill(opts={}){return syncSkill(packageConfig(),opts);}
export async function updateSkill(opts={}){return syncSkill(packageConfig(),opts);}
export async function ensureSkill(opts={}){return syncSkill(packageConfig(),opts);}
export async function runSkillSource(opts={}){const r=maintenanceSource(packageConfig(),resolveSkillName(opts));console.log(opts.json?JSON.stringify(r,null,2):r.source);return r;}
export async function runSkillStatus(opts={}){const r=maintenanceStatus(packageConfig(),opts);console.log(JSON.stringify(r,null,2));return r;}
export async function runSkillInstall(opts={}){const r=await installSkill(opts);console.log(JSON.stringify(r,null,2));return r;}
export async function runSkillUpdate(opts={}){const r=await updateSkill(opts);console.log(JSON.stringify(r,null,2));return r;}
