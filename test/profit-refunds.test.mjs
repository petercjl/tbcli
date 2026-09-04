import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import crypto from 'node:crypto';
import { validateProfitRefundExport } from '../src/tbcli/profit-refunds.mjs';

test('validates a privacy-trimmed refund export into stable facts', async (t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tbcli-refund-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const refunds=[{refundNo:'R1',tradeNo:'T1',tradeId:'1',tids:['P1'],shopId:'1',shopName:'示例旗舰店',platformStatus:5,applyTime:'2026-09-01 10:00:00',settlementTime:'2026-09-02 10:00:00',actualRefundAmount:'12.3',isFinanciallyRefunded:true,items:[{refundItemId:'RI1',tradeItemId:'OI1',apiSpuId:'727',apiSkuId:'S1',actualRefundAmount:'12.3'}]}];
  const file=path.join(dir,'refunds.json');await fs.writeFile(file,JSON.stringify({metadata:{schemaVersion:1,channel:'erp-web',exportedAt:new Date().toISOString(),query:{timeField:'applyTime',applyTimeBegin:'2026-09-01 00:00:00',applyTimeEnd:'2026-09-01 23:59:59'},apiTotal:1,apiTotalAfter:1,exportedItemRows:1,refundsSha256:crypto.createHash('sha256').update(JSON.stringify(refunds)).digest('hex')},refunds}));
  const v=await validateProfitRefundExport(file,{shopKey:'example-shop',shopName:'示例旗舰店'});assert.equal(v.ok,true);assert.equal(v.refundCount,1);assert.equal(v.lineCount,1);assert.equal(v.rows.lines[0].platform_product_id,'727');
});
