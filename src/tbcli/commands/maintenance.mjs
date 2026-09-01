import { startMaintenanceRun, recordMaintenanceEvent, finishMaintenanceRun, maintenanceRunStatus } from '../maintenance-run.mjs';

const print = async (action, args) => console.log(JSON.stringify(await action(args), null, 2));
export const runMaintenanceStart = (args) => print(startMaintenanceRun, args);
export const runMaintenanceRecord = (args) => print(recordMaintenanceEvent, args);
export const runMaintenanceFinish = (args) => print(finishMaintenanceRun, args);
export const runMaintenanceStatus = (args) => print(maintenanceRunStatus, args);
