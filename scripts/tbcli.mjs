#!/usr/bin/env node
// Lightweight metadata, maintenance and DMP dispatch; other business routes remain unchanged.
const argv=process.argv.slice(2);
function metadataFlags(allowed){const seen=new Set();for(const flag of argv.slice(1)){if(!allowed.includes(flag))throw Object.assign(Error(flag),{code:'INVALID_ARGUMENT'});if(seen.has(flag))throw Object.assign(Error(flag),{code:'DUPLICATE_ARGUMENT'});seen.add(flag);}}
async function dispatch(){
 if(['--help','help'].includes(argv[0])&&argv.includes('--json')){metadataFlags(['--json','--help']);const {maintenanceManifest}=await import('../src/package-runtime.mjs'),{packageConfig}=await import('../src/tbcli/package-config.mjs');console.log(JSON.stringify(maintenanceManifest(packageConfig()),null,2));return;}
 if(argv[0]==='capabilities'&&argv.includes('--json')){metadataFlags(['--json','--all','--help']);const {maintenanceManifest}=await import('../src/package-runtime.mjs'),{packageConfig}=await import('../src/tbcli/package-config.mjs'),{businessCapabilities,technicalCapabilities}=await import('../src/tbcli/command-registry.mjs');const result={...maintenanceManifest(packageConfig()),audience:'ecommerce-operator',usageHint:'Use registered examplePrompt and commandTemplate.',capabilities:businessCapabilities()};if(argv.includes('--all'))result.technicalCapabilities=technicalCapabilities();console.log(JSON.stringify(result,null,2));return;}
 if(['version','--version','-v'].includes(argv[0])){const {runVersion}=await import('../src/tbcli/version.mjs');metadataFlags(['--json','--help']);if(argv.includes('--help')){const {maintenanceManifest}=await import('../src/package-runtime.mjs'),{packageConfig}=await import('../src/tbcli/package-config.mjs');console.log(JSON.stringify({ok:true,command:'version',...maintenanceManifest(packageConfig()).commandContracts.version}));return;}return runVersion({json:argv.includes('--json')});}
 if(['skill','update','operation'].includes(argv[0])){const {runMaintenance}=await import('../src/package-runtime.mjs'),{packageConfig}=await import('../src/tbcli/package-config.mjs');return runMaintenance(packageConfig(),argv[0],argv.slice(1));}
 if(argv[0]==='dmp'&&!argv.includes('--help')){
  const {parseArgs}=await import('../src/tbcli/args.mjs'),opts=parseArgs(argv);
  if(opts._[1]!=='catalog'){const {maybeAutoUpdate}=await import('../src/tbcli/update.mjs');const r=await maybeAutoUpdate(opts);if(r.updateAvailable)console.error('tbcli update available; use an explicit selected-target update.');}
  if(opts._[1]==='snapshot'){const {runDmpSnapshot}=await import('../src/tbcli/commands/dmp-snapshot.mjs');return runDmpSnapshot(opts);}
  const m=await import('../src/tbcli/commands/dmp.mjs'),fn={catalog:m.runDmpCatalog,items:m.runDmpItems,report:m.runDmpReport}[opts._[1]];if(fn)return fn(opts);
 }
 const {main}=await import('../src/tbcli/cli.mjs');return main(argv);
}
dispatch().catch(e=>{console.error(JSON.stringify({ok:false,code:e.code??'TBCLI_ERROR',message:e.message}));process.exitCode=1;});
