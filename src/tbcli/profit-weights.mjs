import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MONTH=/^\d{4}-(0[1-9]|1[0-2])$/;
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const round6=(value)=>Number(value.toFixed(6));
const median=(values)=>{
  if(!values.length) return null;
  const sorted=[...values].sort((a,b)=>a-b);
  const middle=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
};
const digest=(value)=>crypto.createHash('sha256').update(value).digest('hex');

export function validateWeightRequest({shopKey,months,out}={}) {
  const selected=String(months??'').split(',').map(x=>x.trim()).filter(Boolean);
  if(!shopKey || !out || selected.length<1 || selected.length>12 || selected.some(x=>!MONTH.test(x))
    || new Set(selected).size!==selected.length) throw new Error('需要 --shop-key、--months YYYY-MM[,YYYY-MM] 和全新 --out JSON 文件');
  return selected.sort();
}

export async function loadWeightObservations(client,shopKey,months) {
  // Four indexed, narrow reads are substantially cheaper than one warehouse-wide
  // aggregate join. Snapshot consistency still comes from one read-only transaction.
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='180000ms'");
    async function paged(label,sql,params,key) {
      const rows=[];
      let last=null;
      for(let page=0;page<1000;page++) {
        const part=await client.query(sql,[...params,last]);
        rows.push(...part.rows);
        if(part.rowCount<5000) break;
        last=String(part.rows.at(-1)[key]);
        if(page===999) throw new Error(`${label} 超过分页安全上限`);
      }
      process.stderr.write(`重量推断：${label} ${rows.length} 行\n`);
      return rows;
    }
    const bill=[];
    const batches=await client.query(`SELECT batch_id,carrier,bill_month
      FROM meta.courier_bill_batches WHERE bill_month=ANY($1::text[])
      ORDER BY bill_month,carrier,batch_id`,[months]);
    for(const batch of batches.rows) {
      let lastSheet=null,lastRow=null,batchRows=0;
      for(let page=0;page<1000;page++) {
        const part=await client.query(`SELECT charge_id,tracking_no,carrier,bill_month,billable_weight_kg,
            source_sheet,source_row
          FROM raw.courier_bill_charges
          WHERE source_batch_id=$1 AND billable_weight_kg>0
            AND ($2::text IS NULL OR (source_sheet,source_row)>($2,$3::int))
          ORDER BY source_sheet,source_row LIMIT 5000`,[batch.batch_id,lastSheet,lastRow]);
        bill.push(...part.rows);
        batchRows+=part.rowCount;
        if(part.rowCount<5000) break;
        lastSheet=part.rows.at(-1).source_sheet;
        lastRow=part.rows.at(-1).source_row;
        if(page===999) throw new Error('账单批次超过分页安全上限');
      }
      process.stderr.write(`重量推断：${batch.bill_month} ${batch.carrier} 正计费重量 ${batchRows} 行\n`);
    }
    const shipments=await paged('店铺运单',`SELECT shipment_key,tracking_no,wdt_trade_no
      FROM raw.shipments WHERE shop_key=$1 AND ($2::text IS NULL OR shipment_key>$2)
      ORDER BY shipment_key LIMIT 5000`,[shopKey],'shipment_key');
    const headers=await paged('店铺订单',`SELECT wdt_trade_no,order_status_code
      FROM raw.wdt_order_headers WHERE shop_key=$1 AND ($2::text IS NULL OR wdt_trade_no>$2)
      ORDER BY wdt_trade_no LIMIT 5000`,[shopKey],'wdt_trade_no');
    const lines=await paged('订单子件',`SELECT order_line_key,wdt_trade_no,erp_spec_no,quantity
      FROM raw.wdt_order_lines WHERE shop_key=$1 AND ($2::text IS NULL OR order_line_key>$2)
      ORDER BY order_line_key LIMIT 5000`,[shopKey],'order_line_key');
    await client.query('COMMIT');
    const charges=new Map(),trackingOrders=new Map(),orderTrackings=new Map(),validOrders=new Set(),parts=new Map();
    for(const row of bill) {
      const key=String(row.tracking_no);
      if(!charges.has(key)) charges.set(key,{carrier:row.carrier,month:row.bill_month,
        weight:Number(row.billable_weight_kg),invalid:false});
      else {
        const prior=charges.get(key);
        if(prior.carrier!==row.carrier || prior.month!==row.bill_month
          || prior.weight!==Number(row.billable_weight_kg)) prior.invalid=true;
      }
    }
    for(const row of shipments) {
      const tracking=String(row.tracking_no),order=String(row.wdt_trade_no);
      (trackingOrders.get(tracking)??(trackingOrders.set(tracking,new Set()),trackingOrders.get(tracking))).add(order);
      (orderTrackings.get(order)??(orderTrackings.set(order,new Set()),orderTrackings.get(order))).add(tracking);
    }
    for(const row of headers) if(Number(row.order_status_code)===95)
      validOrders.add(String(row.wdt_trade_no));
    for(const row of lines) {
      const key=String(row.wdt_trade_no);
      if(!parts.has(key)) parts.set(key,{components:new Map(),invalid:false});
      const entry=parts.get(key),sku=String(row.erp_spec_no??'').trim(),quantity=Number(row.quantity);
      if(!sku || sku==='dc99999' || !Number.isFinite(quantity) || quantity<=0 || !Number.isInteger(quantity)) {
        entry.invalid=true; continue;
      }
      entry.components.set(sku,(entry.components.get(sku)??0)+quantity);
    }
    const observations=[],sourceExcluded={unmatched:0,sharedTracking:0,multipleWaybills:0,
      ineligibleOrder:0,invalidComponents:0,conflictingWeights:0};
    for(const [trackingNo,charge] of charges) {
      if(charge.invalid) { sourceExcluded.conflictingWeights++; continue; }
      const orders=trackingOrders.get(trackingNo);
      if(!orders?.size) { sourceExcluded.unmatched++; continue; }
      if(orders.size!==1) { sourceExcluded.sharedTracking++; continue; }
      const [orderNo]=orders;
      if(orderTrackings.get(orderNo)?.size!==1) { sourceExcluded.multipleWaybills++; continue; }
      if(!validOrders.has(orderNo)) { sourceExcluded.ineligibleOrder++; continue; }
      const entry=parts.get(orderNo);
      if(!entry || entry.invalid || !entry.components.size) { sourceExcluded.invalidComponents++; continue; }
      observations.push({trackingNo,orderNo,carrier:charge.carrier,month:charge.month,
        weight:charge.weight,components:entry.components,invalid:false});
    }
    return {observations,sourceStats:{billRows:bill.length,distinctBillWaybills:charges.size,
      shipmentRows:shipments.length,orderRows:headers.length,lineRows:lines.length,sourceExcluded}};
  } catch(error) { await client.query('ROLLBACK'); throw error; }
}

function signature(components) {
  return [...components].sort(([a],[b])=>a.localeCompare(b)).map(([sku,qty])=>`${sku}:${qty}`).join('|');
}
function maxGroupSpread(groups,center) {
  if(groups.size<2 || !(center>0)) return null;
  const centers=[...groups.values()].map(values=>median(values));
  return (Math.max(...centers)-Math.min(...centers))/center;
}
function classify(count,patterns,months,carriers,relativeSpread,monthSpread,carrierSpread) {
  if(count>=30 && patterns>=3 && months>=2 && carriers>=2 && relativeSpread<=0.15
    && (monthSpread==null || monthSpread<=0.15)
    && (carrierSpread==null || carrierSpread<=0.15)) return 'high';
  if(count>=10 && patterns>=2 && relativeSpread<=0.25
    && (monthSpread==null || monthSpread<=0.25)
    && (carrierSpread==null || carrierSpread<=0.25)) return 'medium';
  return 'low';
}

export function inferComponentWeights(observations,{shopKey,months,auditSku}={}) {
  const groups=new Map(),seen=new Set(),excluded={invalid:0,duplicate:0,weight:0};
  let used=0;
  for(const order of observations) {
    if(seen.has(order.trackingNo)) { excluded.duplicate++; continue; }
    seen.add(order.trackingNo);
    if(order.invalid || !order.components?.size) { excluded.invalid++; continue; }
    if(!Number.isFinite(order.weight) || order.weight<=0 || order.weight>30) { excluded.weight++; continue; }
    const key=`${order.month}/${order.carrier}/${signature(order.components)}`;
    if(!groups.has(key)) groups.set(key,{month:order.month,carrier:order.carrier,
      components:new Map(order.components),weights:[],orders:[]});
    groups.get(key).weights.push(order.weight);
    if(auditSku) groups.get(key).orders.push(order);
    used++;
  }
  const edges=new Map(),solo=new Map(),allSkus=new Set();
  for(const group of groups.values()) {
    for(const sku of group.components.keys()) allSkus.add(sku);
    if(group.components.size===1) {
      const [[sku,qty]]=[...group.components];
      if(qty===1) (solo.get(sku)??(solo.set(sku,[]),solo.get(sku))).push(group);
    }
    for(const [sku,quantity] of group.components) {
      if(quantity<1) continue;
      const base=new Map(group.components);
      if(quantity===1) base.delete(sku); else base.set(sku,quantity-1);
      if(!base.size) continue;
      const baseline=groups.get(`${group.month}/${group.carrier}/${signature(base)}`);
      if(!baseline) continue;
      const difference=median(group.weights)-median(baseline.weights);
      if(!(difference>0 && difference<=30)) continue;
      (edges.get(sku)??(edges.set(sku,[]),edges.get(sku))).push({
        weight:difference,support:Math.min(group.weights.length,baseline.weights.length),
        pattern:signature(base),month:group.month,carrier:group.carrier});
    }
  }
  const results=[];
  for(const sku of [...allSkus].sort()) {
    const skuEdges=edges.get(sku)??[];
    const expanded=skuEdges.flatMap(e=>Array(Math.min(e.support,50)).fill(e.weight));
    const net=median(expanded);
    const netMad=net==null?null:median(expanded.map(x=>Math.abs(x-net)));
    const netCount=skuEdges.reduce((sum,e)=>sum+e.support,0);
    const netByMonth=new Map(),netByCarrier=new Map();
    for(const edge of skuEdges) {
      (netByMonth.get(edge.month)??(netByMonth.set(edge.month,[]),netByMonth.get(edge.month))).push(edge.weight);
      (netByCarrier.get(edge.carrier)??(netByCarrier.set(edge.carrier,[]),netByCarrier.get(edge.carrier))).push(edge.weight);
    }
    const netMonthSpread=maxGroupSpread(netByMonth,net),netCarrierSpread=maxGroupSpread(netByCarrier,net);
    const netConfidence=net==null?'unidentified':classify(netCount,
      new Set(skuEdges.map(e=>e.pattern)).size,new Set(skuEdges.map(e=>e.month)).size,
      new Set(skuEdges.map(e=>e.carrier)).size,netMad/Math.max(net,0.01),
      netMonthSpread,netCarrierSpread);
    const soloGroups=solo.get(sku)??[];
    const grossValues=soloGroups.flatMap(g=>g.weights);
    const gross=median(grossValues);
    const grossMad=gross==null?null:median(grossValues.map(x=>Math.abs(x-gross)));
    const grossByMonth=new Map(),grossByCarrier=new Map();
    for(const group of soloGroups) for(const value of group.weights) {
      (grossByMonth.get(group.month)??(grossByMonth.set(group.month,[]),grossByMonth.get(group.month))).push(value);
      (grossByCarrier.get(group.carrier)??(grossByCarrier.set(group.carrier,[]),grossByCarrier.get(group.carrier))).push(value);
    }
    const grossConfidence=gross==null?'unidentified':classify(grossValues.length,
      soloGroups.length,new Set(soloGroups.map(g=>g.month)).size,
      new Set(soloGroups.map(g=>g.carrier)).size,grossMad/Math.max(gross,0.01),
      maxGroupSpread(grossByMonth,gross),maxGroupSpread(grossByCarrier,gross));
    const coherent=net!=null && gross!=null && net<gross;
    results.push({erpSpecNo:sku,netWeightKg:net==null?null:round6(net),
      soloPackedBillableWeightKg:gross==null?null:round6(gross),
      packagingIncrementKg:coherent?round6(gross-net):null,
      netConfidence:coherent?netConfidence:(net==null?'unidentified':'low'),
      packedConfidence:grossConfidence,
      evidence:{netPairCount:netCount,netPatternCount:new Set(skuEdges.map(e=>e.pattern)).size,
        netMonths:[...new Set(skuEdges.map(e=>e.month))].sort(),
        netCarriers:[...new Set(skuEdges.map(e=>e.carrier))].sort(),
        netMadKg:netMad==null?null:round6(netMad),
        netMonthSpread:netMonthSpread==null?null:round6(netMonthSpread),
        netCarrierSpread:netCarrierSpread==null?null:round6(netCarrierSpread),
        soloShipmentCount:grossValues.length,soloMadKg:grossMad==null?null:round6(grossMad),
        consistency:net==null||gross==null?'not_comparable':coherent?'pass':'net_not_below_packed'}});
  }
  const report={schemaVersion:1,method:'paired-basket-billable-weight-v1',shopKey,months,
    semantics:{net:'相同承运商、账期及其余子件组合下，增加一件子件的计费重量差；非实测净重',
      packed:'单件独立发货的计费重量中位数，含包装及计费规则；非实测毛重'},
    observations:{input:observations.length,used,excluded,basketGroups:groups.size},
    summary:{skuCount:results.length,netIdentified:results.filter(r=>r.netWeightKg!=null).length,
      netHigh:results.filter(r=>r.netConfidence==='high').length,
      netMedium:results.filter(r=>r.netConfidence==='medium').length,
      packedIdentified:results.filter(r=>r.soloPackedBillableWeightKg!=null).length},
    results};
  if(auditSku) {
    const sku=String(auditSku).trim();
    if(!sku || !allSkus.has(sku)) throw new Error(`指定子件在合格样本中不存在：${sku}`);
    report.audit=buildWeightAudit(groups,sku);
  }
  return report;
}

function buildWeightAudit(groups,sku) {
  const comparisons=[],selected=new Map(),unpaired=[];
  const addGroup=(key,group,role)=>{
    if(!selected.has(key)) selected.set(key,{group,roles:new Set()});
    selected.get(key).roles.add(role);
  };
  for(const [key,group] of groups) {
    const quantity=group.components.get(sku);
    if(!quantity) continue;
    if(group.components.size===1 && quantity===1) addGroup(key,group,'single-item');
    const base=new Map(group.components);
    if(quantity===1) base.delete(sku); else base.set(sku,quantity-1);
    if(!base.size) continue;
    const baseKey=`${group.month}/${group.carrier}/${signature(base)}`;
    const baseline=groups.get(baseKey);
    if(!baseline) {
      unpaired.push({month:group.month,carrier:group.carrier,basket:signature(group.components),
        shipmentCount:group.weights.length,reason:'same-month-carrier-baseline-absent'});
      addGroup(key,group,'no-baseline');
      continue;
    }
    const targetMedian=median(group.weights),baselineMedian=median(baseline.weights);
    const delta=targetMedian-baselineMedian,included=delta>0 && delta<=30;
    comparisons.push({month:group.month,carrier:group.carrier,
      targetGroup:key,baselineGroup:baseKey,targetBasket:signature(group.components),
      baselineBasket:signature(baseline.components),targetShipmentCount:group.weights.length,
      baselineShipmentCount:baseline.weights.length,targetMedianKg:round6(targetMedian),
      baselineMedianKg:round6(baselineMedian),deltaKg:round6(delta),
      support:Math.min(group.weights.length,baseline.weights.length),included});
    addGroup(key,group,'target');
    addGroup(baseKey,baseline,'baseline');
  }
  const rawRows=[];
  for(const [key,{group,roles}] of selected) for(const order of group.orders)
    rawRows.push({group:key,role:[...roles].sort().join(','),month:order.month,carrier:order.carrier,
      trackingNo:order.trackingNo,orderNo:order.orderNo??null,weightKg:order.weight,
      basket:signature(order.components),targetQuantity:order.components.get(sku)??0});
  rawRows.sort((a,b)=>a.group.localeCompare(b.group)||a.trackingNo.localeCompare(b.trackingNo));
  comparisons.sort((a,b)=>a.month.localeCompare(b.month)||a.carrier.localeCompare(b.carrier)
    ||a.targetBasket.localeCompare(b.targetBasket));
  return {erpSpecNo:sku,comparisons,unpairedGroups:unpaired,rawRows};
}

export async function writeNewWeightReport(out,report) {
  const file=path.resolve(out);
  const handle=await fs.open(file,'wx',0o600);
  try { await handle.writeFile(`${JSON.stringify(report,null,2)}\n`); }
  finally { await handle.close(); }
  return file;
}

export async function readWeightReport(input,{shopKey,effectiveFrom}={}) {
  if(!input || !shopKey || !DAY.test(String(effectiveFrom??'')))
    throw new Error('需要 --input、--shop-key 与 --effective-from YYYY-MM-DD');
  const file=path.resolve(input),bytes=await fs.readFile(file),report=JSON.parse(bytes.toString('utf8'));
  if(report.schemaVersion!==1 || report.shopKey!==shopKey || !Array.isArray(report.months)
    || !Array.isArray(report.results) || !report.results.length || report.method!=='paired-basket-billable-weight-v1')
    throw new Error('重量报告版本、店铺或内容无效');
  if(report.months.some(month=>!MONTH.test(month)) || new Set(report.months).size!==report.months.length)
    throw new Error('重量报告账期无效');
  const ids=new Set();
  for(const row of report.results) {
    if(!row.erpSpecNo || ids.has(row.erpSpecNo)) throw new Error('重量报告 ERP 规格编码缺失或重复');
    ids.add(row.erpSpecNo);
    for(const value of [row.netWeightKg,row.soloPackedBillableWeightKg])
      if(value!==null && (!Number.isFinite(value) || value<=0 || value>30))
        throw new Error(`规格 ${row.erpSpecNo} 的重量无效`);
    if(!['high','medium','low','unidentified'].includes(row.netConfidence)
      || !['high','medium','low','unidentified'].includes(row.packedConfidence))
      throw new Error(`规格 ${row.erpSpecNo} 的置信度无效`);
    if(row.netWeightKg==null && row.netConfidence!=='unidentified')
      throw new Error(`规格 ${row.erpSpecNo} 净重与置信度不一致`);
  }
  if(report.summary?.skuCount!==report.results.length)
    throw new Error('重量报告汇总与明细行数不一致');
  return {file,fileSha256:digest(bytes),effectiveFrom,report};
}

export async function stageWeightReport(client,validated) {
  const {file,fileSha256,effectiveFrom,report}=validated;
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`tbcli:profit-weights:${report.shopKey}`]);
    const prior=await client.query('SELECT batch_id FROM meta.master_data_batches WHERE source_sha256=$1',[fileSha256]);
    if(prior.rowCount) { await client.query('COMMIT'); return {alreadyStaged:true,batchId:prior.rows[0].batch_id}; }
    const rows=report.results.flatMap(r=>[
      ...(r.netWeightKg>0?[{erpSpecNo:r.erpSpecNo,weightType:'profit_allocation_weight',weightKg:r.netWeightKg,
        confidence:r.netConfidence}]:[]),
      ...(r.soloPackedBillableWeightKg>0?[{erpSpecNo:r.erpSpecNo,weightType:'single_item_packed_billable_weight',
        weightKg:r.soloPackedBillableWeightKg,confidence:r.packedConfidence}]:[])]);
    if(!rows.length) throw new Error('报告没有可暂存的正重量');
    const batch=await client.query(`INSERT INTO meta.master_data_batches(data_type,source_file,source_sha256,
      source_metadata,shop_key,status,row_count,sku_count,effective_from)
      VALUES('sku-weight-inference',$1,$2,$3::jsonb,$4,'draft',$5,$6,$7::date) RETURNING batch_id`,[
      path.basename(file),fileSha256,JSON.stringify({months:report.months,method:report.method,
        semantics:report.semantics,observations:report.observations,summary:report.summary,evidence:report.results}),
      report.shopKey,rows.length,report.summary.skuCount,effectiveFrom]);
    await client.query(`INSERT INTO master.sku_weight_versions(batch_id,shop_key,erp_spec_no,weight_type,
      weight_kg,method,confidence,usable_for_profit,effective_from,status)
      SELECT $1::uuid,$2,x.erp_spec_no,x.weight_type,x.weight_kg,$3,x.confidence,false,$4::date,'draft'
      FROM jsonb_to_recordset($5::jsonb) AS x(erp_spec_no text,weight_type text,weight_kg numeric,confidence text)`,[
      batch.rows[0].batch_id,report.shopKey,report.method,effectiveFrom,
      JSON.stringify(rows.map(r=>({erp_spec_no:r.erpSpecNo,weight_type:r.weightType,
        weight_kg:r.weightKg,confidence:r.confidence}))) ]);
    const checked=await client.query('SELECT count(*)::int AS n FROM master.sku_weight_versions WHERE batch_id=$1',[
      batch.rows[0].batch_id]);
    if(checked.rows[0].n!==rows.length) throw new Error('重量暂存写后行数不一致');
    await client.query('COMMIT');
    return {alreadyStaged:false,batchId:batch.rows[0].batch_id,stagedRows:rows.length,
      skuCount:report.summary.skuCount,status:'draft',currentWeightsChanged:false};
  } catch(error) { await client.query('ROLLBACK'); throw error; }
}
