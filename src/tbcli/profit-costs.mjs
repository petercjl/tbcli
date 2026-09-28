import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const money = (value) => value == null ? null : Number(Number(value).toFixed(4));

export async function validateWdtCostExport(input, {shopKey,effectiveFrom}={}) {
  if (!input || !shopKey || !DATE.test(String(effectiveFrom ?? '')))
    throw new Error('需要 --input、--shop-key 和 YYYY-MM-DD 格式的 --effective-from');
  const file = path.resolve(input);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('旺店通成本输入必须是文件');
  const bytes = await fs.readFile(file);
  let source;
  try { source = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('旺店通成本输入不是有效 JSON'); }
  if (source?.source !== 'wdt-openapi:goods_query.php' || !Array.isArray(source.rows)
      || source.rows.length !== source.specCount || source.rows.length === 0
      || !Number.isInteger(source.goodsCount) || source.goodsCount < 1
      || !Number.isFinite(Date.parse(source.fetchedAt)))
    throw new Error('旺店通成本导出结构、来源或完整性校验失败');
  const rows = source.rows.map((raw,index) => {
    const goodsNo=String(raw.goodsNo ?? '').trim();
    const specNo=String(raw.specNo ?? '').trim();
    const cost=raw.refCostPrice == null ? null : Number(raw.refCostPrice);
    if (!goodsNo || !specNo || (cost !== null && (!Number.isFinite(cost) || cost < 0)))
      throw new Error(`旺店通成本第 ${index+1} 行编码或成本无效`);
    return {goodsNo,specNo,cost:money(cost),goodsDeleted:Number(raw.goodsDeleted),
      goodsStatus:Number(raw.goodsStatus),specDeleted:Number(raw.specDeleted),
      specStatus:Number(raw.specStatus),specId:String(raw.specId ?? '')};
  });
  return {file,sourceFile:path.basename(file),fileSha256:hash(bytes),shopKey,effectiveFrom,
    fetchedAt:source.fetchedAt,goodsCount:source.goodsCount,specCount:source.specCount,rows};
}

function chooseSource(specNo, goodsNos, candidates) {
  let eligible=candidates.filter((row)=>row.specNo===specNo);
  if (goodsNos.size) eligible=eligible.filter((row)=>goodsNos.has(row.goodsNo));
  else eligible=eligible.filter((row)=>row.goodsDeleted===0 && row.goodsStatus===0
    && row.specDeleted===0 && row.specStatus===0);
  if (!eligible.length) return {status:'unmatched'};
  const active=eligible.filter((row)=>row.goodsDeleted===0 && row.goodsStatus===0
    && row.specDeleted===0 && row.specStatus===0);
  if (active.length) eligible=active;
  const prices=[...new Set(eligible.map((row)=>row.cost))];
  if (prices.length !== 1) return {status:'ambiguous',candidates:eligible.length};
  return {status:'matched',cost:prices[0],candidates:eligible.length};
}

export async function reconcileWdtCosts(client, validation) {
  const orderSpecs=await client.query(`SELECT DISTINCT erp_spec_no,erp_goods_no FROM raw.wdt_order_lines
    WHERE shop_key=$1 AND nullif(erp_spec_no,'') IS NOT NULL`,[validation.shopKey]);
  const identitySpecs=await client.query(`SELECT DISTINCT erp_spec_no,erp_goods_no FROM master.current_skus
    WHERE shop_key=$1 AND nullif(erp_spec_no,'') IS NOT NULL`,[validation.shopKey]);
  const currentCosts=await client.query(`SELECT version_id,erp_spec_no,unit_cost,cost_status,effective_from::text,effective_to::text
    FROM master.current_sku_costs WHERE shop_key=$1`,[validation.shopKey]);
  const goodsBySpec=new Map();
  for(const row of [...orderSpecs.rows,...identitySpecs.rows]) {
    const specNo=String(row.erp_spec_no);
    if(!goodsBySpec.has(specNo)) goodsBySpec.set(specNo,new Set());
    if(row.erp_goods_no) goodsBySpec.get(specNo).add(String(row.erp_goods_no));
  }
  const currentBySpec=new Map(currentCosts.rows.map((row)=>[String(row.erp_spec_no),row]));
  for(const specNo of currentBySpec.keys()) if(!goodsBySpec.has(specNo)) goodsBySpec.set(specNo,new Set());
  const sourceBySpec=new Map();
  for(const row of validation.rows) {
    if(!sourceBySpec.has(row.specNo)) sourceBySpec.set(row.specNo,[]);
    sourceBySpec.get(row.specNo).push(row);
  }
  const changes=[],issues=[];
  let unchanged=0;
  for(const [specNo,goodsNos] of goodsBySpec) {
    const selection=chooseSource(specNo,goodsNos,sourceBySpec.get(specNo)??[]);
    const prior=currentBySpec.get(specNo);
    if(selection.status!=='matched') {
      issues.push({erpSpecNo:specNo,reason:selection.status,goodsNos:[...goodsNos]});
      continue;
    }
    if(selection.cost==null || selection.cost===0) {
      issues.push({erpSpecNo:specNo,reason:selection.cost==null?'source_cost_missing':'source_cost_zero',
        existingCost:money(prior?.unit_cost)});
      continue;
    }
    if(prior?.cost_status==='explicit_zero') {
      issues.push({erpSpecNo:specNo,reason:'approved_explicit_zero_preserved'});
      continue;
    }
    if(prior?.unit_cost!=null && Math.abs(Number(prior.unit_cost)-selection.cost)<0.00005) {
      unchanged+=1; continue;
    }
    if(prior?.effective_from && prior.effective_from>validation.effectiveFrom)
      throw new Error(`规格 ${specNo} 已有晚于同步日期的成本版本`);
    changes.push({erpSpecNo:specNo,unitCost:selection.cost,
      priorVersionId:prior?.version_id??null,priorEffectiveFrom:prior?.effective_from??null,
      beforeCost:money(prior?.unit_cost)});
  }
  changes.sort((a,b)=>a.erpSpecNo.localeCompare(b.erpSpecNo));
  return {shopKey:validation.shopKey,effectiveFrom:validation.effectiveFrom,
    sourceGoodsCount:validation.goodsCount,sourceSpecCount:validation.specCount,
    targetSpecCount:goodsBySpec.size,matchedCount:changes.length+unchanged,
    changedCount:changes.length,unchangedCount:unchanged,issueCount:issues.length,
    issueSummary:Object.fromEntries([...new Set(issues.map((x)=>x.reason))].map((reason)=>[
      reason,issues.filter((x)=>x.reason===reason).length])),
    changes,issues};
}

export async function syncWdtCosts(client,validation) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`tbcli:profit-costs:${validation.shopKey}`]);
    const before=await reconcileWdtCosts(client,validation);
    if(!before.changedCount) {
      await client.query('COMMIT');
      return {noChanges:true,inserted:0,verification:{ok:true},reconciliation:before};
    }
    const operationDigest=hash(JSON.stringify({fileSha256:validation.fileSha256,
      shopKey:validation.shopKey,effectiveFrom:validation.effectiveFrom,
      changes:before.changes.map((row)=>[row.erpSpecNo,row.unitCost,row.priorVersionId])}));
    const previous=await client.query('SELECT batch_id FROM meta.master_data_batches WHERE source_sha256=$1',[operationDigest]);
    if(previous.rowCount) throw new Error('该成本来源与差异已同步过，但当前结果再次出现差异');
    const batch=await client.query(`INSERT INTO meta.master_data_batches(
      data_type,source_file,source_sha256,source_metadata,shop_key,status,row_count,
      product_count,sku_count,mapped_sku_count,effective_from,activated_at)
      VALUES('sku-cost-sync',$1,$2,$3::jsonb,$4,'approved',$5,0,$5,$5,$6::date,now())
      RETURNING batch_id,source_sha256,row_count,effective_from::text,imported_at`,[
      validation.sourceFile,operationDigest,JSON.stringify({mode:'sync-current-versioned',
        source:'wdt-openapi:goods_query.php',sourceFileSha256:validation.fileSha256,
        fetchedAt:validation.fetchedAt,sourceGoodsCount:validation.goodsCount,
        sourceSpecCount:validation.specCount,targetSpecCount:before.targetSpecCount,
        issueSummary:before.issueSummary}),validation.shopKey,before.changedCount,validation.effectiveFrom]);
    for(const row of before.changes) if(row.priorVersionId) {
      const sameDay=row.priorEffectiveFrom===validation.effectiveFrom;
      const updated=sameDay
        ? await client.query(`UPDATE master.sku_cost_versions SET status='retired'
          WHERE version_id=$1 AND shop_key=$2 AND erp_spec_no=$3 AND status='approved'`,[
          row.priorVersionId,validation.shopKey,row.erpSpecNo])
        : await client.query(`UPDATE master.sku_cost_versions SET effective_to=$1::date-1
          WHERE version_id=$2 AND shop_key=$3 AND erp_spec_no=$4 AND status='approved'`,[
          validation.effectiveFrom,row.priorVersionId,validation.shopKey,row.erpSpecNo]);
      if(updated.rowCount!==1) throw new Error(`规格 ${row.erpSpecNo} 旧版本变化，事务已回滚`);
    }
    await client.query(`INSERT INTO master.sku_cost_versions(
      batch_id,shop_key,erp_spec_no,unit_cost,currency,cost_type,cost_source,cost_status,
      effective_from,effective_to,status)
      SELECT $1::uuid,$2,x.erp_spec_no,x.unit_cost,'CNY','standard','旺店通参考成本',
        'available',$3::date,NULL,'approved'
      FROM jsonb_to_recordset($4::jsonb) AS x(erp_spec_no text,unit_cost numeric)`,[
      batch.rows[0].batch_id,validation.shopKey,validation.effectiveFrom,
      JSON.stringify(before.changes.map((row)=>({erp_spec_no:row.erpSpecNo,unit_cost:row.unitCost})))]);
    const after=await client.query(`SELECT erp_spec_no,unit_cost FROM master.current_sku_costs
      WHERE shop_key=$1 AND erp_spec_no=ANY($2::text[])`,[
      validation.shopKey,before.changes.map((row)=>row.erpSpecNo)]);
    const afterBySpec=new Map(after.rows.map((row)=>[String(row.erp_spec_no),Number(row.unit_cost)]));
    const failed=before.changes.filter((row)=>Math.abs((afterBySpec.get(row.erpSpecNo)??NaN)-row.unitCost)>0.00005
      || !afterBySpec.has(row.erpSpecNo));
    if(failed.length) throw new Error(`成本同步写后核验失败：${failed.length} 条`);
    await client.query('COMMIT');
    return {noChanges:false,inserted:before.changes.length,
      superseded:before.changes.filter((row)=>row.priorVersionId).length,
      batch:batch.rows[0],verification:{ok:true,matched:before.changes.length},
      reconciliation:before};
  } catch(error) { await client.query('ROLLBACK'); throw error; }
}
