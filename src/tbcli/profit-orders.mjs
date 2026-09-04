import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DECIMAL = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function text(value) {
  if (value === undefined || value === null) return null;
  const result = String(value).trim();
  return result === '' ? null : result;
}

function decimal(value, field, location, errors, { required = false } = {}) {
  const result = text(value);
  if (result === null) {
    if (required) errors.push({ code: 'ORDER_DECIMAL_REQUIRED', location, field });
    return null;
  }
  if (!DECIMAL.test(result)) {
    errors.push({ code: 'ORDER_DECIMAL_INVALID', location, field, value: result });
    return null;
  }
  return result;
}

function shanghaiTimestamp(value, field, location, errors, { required = false } = {}) {
  const result = text(value);
  if (result === null) {
    if (required) errors.push({ code: 'ORDER_TIME_REQUIRED', location, field });
    return null;
  }
  const match = result.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if (!match) {
    errors.push({ code: 'ORDER_TIME_INVALID', location, field, value: result });
    return null;
  }
  return `${match[1]}T${match[2]}+08:00`;
}

function datePart(value) {
  return text(value)?.slice(0, 10) || null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertDate(value, name) {
  if (!DATE.test(String(value || ''))) throw new Error(`${name} 必须是 YYYY-MM-DD`);
}

export async function ensureProfitOrderSchema(client) {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS raw;
    CREATE SCHEMA IF NOT EXISTS meta;
    CREATE TABLE IF NOT EXISTS meta.profit_source_batches (
      batch_id uuid PRIMARY KEY,
      source_type text NOT NULL,
      shop_key text NOT NULL,
      source_file text NOT NULL,
      source_sha256 text NOT NULL UNIQUE,
      source_schema_version integer NOT NULL,
      source_channel text NOT NULL,
      query_time_field text NOT NULL,
      coverage_start date NOT NULL,
      coverage_end date NOT NULL,
      observed_at timestamptz NOT NULL,
      order_count bigint NOT NULL,
      line_count bigint NOT NULL,
      shipment_count bigint NOT NULL,
      status text NOT NULL CHECK (status IN ('importing','imported','failed')),
      source_metadata jsonb NOT NULL,
      imported_at timestamptz,
      CHECK (coverage_start <= coverage_end)
    );
    CREATE INDEX IF NOT EXISTS profit_source_batches_shop_range_idx
      ON meta.profit_source_batches(shop_key,source_type,coverage_start,coverage_end)
      WHERE status='imported';

    CREATE TABLE IF NOT EXISTS raw.wdt_order_headers (
      shop_key text NOT NULL,
      wdt_trade_no text NOT NULL,
      wdt_trade_id text,
      platform_trade_id text,
      source_trade_ids jsonb,
      wdt_shop_id text NOT NULL,
      platform_name text,
      shop_name text NOT NULL,
      warehouse_name text,
      order_status_code integer,
      order_status_text text,
      refund_status_code integer,
      refund_status_text text,
      paid_at timestamptz NOT NULL,
      ordered_at timestamptz,
      audited_at timestamptz,
      shipped_at timestamptz,
      printed_at timestamptz,
      estimate_ship_at timestamptz,
      plan_deliver_at timestamptz,
      plan_collect_at timestamptz,
      collected_at timestamptz,
      plan_transfer_at timestamptz,
      logistics_status text,
      goods_count numeric,
      goods_type_count numeric,
      real_amount numeric,
      paid_amount numeric NOT NULL,
      refund_amount numeric,
      logistics jsonb NOT NULL,
      source_order jsonb NOT NULL,
      source_batch_id uuid NOT NULL REFERENCES meta.profit_source_batches(batch_id),
      observed_at timestamptz NOT NULL,
      PRIMARY KEY (shop_key,wdt_trade_no)
    );
    CREATE INDEX IF NOT EXISTS wdt_order_headers_shop_paid_idx
      ON raw.wdt_order_headers(shop_key,paid_at);
    CREATE INDEX IF NOT EXISTS wdt_order_headers_platform_trade_idx
      ON raw.wdt_order_headers(shop_key,platform_trade_id);

    CREATE TABLE IF NOT EXISTS raw.wdt_order_lines (
      shop_key text NOT NULL,
      order_line_key text NOT NULL,
      line_key_method text NOT NULL,
      wdt_order_line_id text,
      wdt_trade_no text NOT NULL,
      source_order_line_id text,
      platform_product_id text,
      platform_sku_id text,
      erp_goods_no text,
      erp_spec_no text,
      product_name text,
      sku_name text,
      quantity numeric,
      refund_quantity numeric,
      source_share_amount numeric,
      source_line_paid numeric,
      refund_status_text text,
      order_status_text text,
      source_goods_cost numeric,
      source_ref_unit_cost numeric,
      source_weight numeric,
      gift_type integer,
      source_line jsonb NOT NULL,
      source_batch_id uuid NOT NULL REFERENCES meta.profit_source_batches(batch_id),
      observed_at timestamptz NOT NULL,
      PRIMARY KEY (shop_key,order_line_key),
      FOREIGN KEY (shop_key,wdt_trade_no) REFERENCES raw.wdt_order_headers(shop_key,wdt_trade_no)
    );
    CREATE INDEX IF NOT EXISTS wdt_order_lines_trade_idx
      ON raw.wdt_order_lines(shop_key,wdt_trade_no);
    CREATE INDEX IF NOT EXISTS wdt_order_lines_product_idx
      ON raw.wdt_order_lines(shop_key,platform_product_id,platform_sku_id);
    CREATE INDEX IF NOT EXISTS wdt_order_lines_spec_idx
      ON raw.wdt_order_lines(shop_key,erp_spec_no);

    CREATE TABLE IF NOT EXISTS raw.shipments (
      shop_key text NOT NULL,
      shipment_key text NOT NULL,
      wdt_trade_no text NOT NULL,
      tracking_no text NOT NULL,
      carrier_raw_name text,
      source_batch_id uuid NOT NULL REFERENCES meta.profit_source_batches(batch_id),
      observed_at timestamptz NOT NULL,
      PRIMARY KEY (shop_key,shipment_key),
      FOREIGN KEY (shop_key,wdt_trade_no) REFERENCES raw.wdt_order_headers(shop_key,wdt_trade_no)
    );
    CREATE INDEX IF NOT EXISTS shipments_tracking_idx ON raw.shipments(shop_key,tracking_no);
  `);
}

export async function validateProfitOrderExport(input, { shopKey, shopName } = {}) {
  if (!input) throw new Error('缺少订单导出文件');
  if (!shopKey) throw new Error('缺少 --shop-key');
  if (!shopName) throw new Error('缺少 --shop-name');
  const file = path.resolve(input);
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw new Error(`订单导出路径不是文件：${file}`);
  const bytes = await fsp.readFile(file);
  const fileSha256 = sha256(bytes);
  let document;
  try { document = JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`订单导出不是有效 JSON：${error.message}`); }

  const errors = [];
  const metadata = document?.metadata;
  const orders = document?.orders;
  if (!metadata || typeof metadata !== 'object') errors.push({ code: 'ORDER_METADATA_MISSING' });
  if (!Array.isArray(orders)) errors.push({ code: 'ORDERS_NOT_ARRAY' });
  if (errors.length) return { ok: false, file, fileSha256, errors };

  if (Number(metadata.schemaVersion) !== 1) errors.push({ code: 'ORDER_SCHEMA_UNSUPPORTED', value: metadata.schemaVersion });
  if (metadata.channel !== 'erp-web') errors.push({ code: 'ORDER_CHANNEL_UNSUPPORTED', value: metadata.channel });
  if (metadata.query?.timeField !== 'payTime') errors.push({ code: 'ORDER_TIME_FIELD_UNSUPPORTED', value: metadata.query?.timeField });
  const coverageStart = datePart(metadata.query?.payTimeBegin);
  const coverageEnd = datePart(metadata.query?.payTimeEnd);
  if (!coverageStart || !coverageEnd || coverageStart > coverageEnd) errors.push({ code: 'ORDER_COVERAGE_INVALID' });
  if (Number(metadata.apiTotal) !== orders.length || Number(metadata.apiTotalAfter) !== orders.length) {
    errors.push({ code: 'ORDER_COUNT_MISMATCH', apiTotal: metadata.apiTotal, apiTotalAfter: metadata.apiTotalAfter, actual: orders.length });
  }
  const ordersSha256 = sha256(JSON.stringify(orders));
  if (metadata.ordersSha256 !== ordersSha256) errors.push({ code: 'ORDER_ARRAY_SHA256_MISMATCH' });
  const metadataShops = Array.isArray(metadata.shopNames) ? metadata.shopNames.map(text).filter(Boolean) : [];
  if (orders.length && (metadataShops.length !== 1 || metadataShops[0] !== shopName)) {
    errors.push({ code: 'ORDER_METADATA_SHOP_MISMATCH', expected: shopName, actual: metadataShops });
  }

  const orderRows = [];
  const lineRows = [];
  const shipmentRows = [];
  const seenOrders = new Set();
  const seenLines = new Set();
  const seenShipments = new Set();
  let warnings = 0;

  orders.forEach((order, orderIndex) => {
    const location = `orders[${orderIndex}]`;
    const tradeNo = text(order?.tradeNo);
    const tradeId = text(order?.tradeId);
    const paidAt = shanghaiTimestamp(order?.payTime, 'payTime', location, errors, { required: true });
    const actualShopName = text(order?.shopName);
    const shopId = text(order?.shopId);
    if (!tradeNo) errors.push({ code: 'ORDER_TRADE_NO_REQUIRED', location });
    if (!shopId) errors.push({ code: 'ORDER_SHOP_ID_REQUIRED', location });
    if (actualShopName !== shopName) errors.push({ code: 'ORDER_SHOP_MISMATCH', location, expected: shopName, actual: actualShopName });
    const paidDate = datePart(order?.payTime);
    if (coverageStart && coverageEnd && paidDate && (paidDate < coverageStart || paidDate > coverageEnd)) {
      errors.push({ code: 'ORDER_OUTSIDE_COVERAGE', location, paidDate, coverageStart, coverageEnd });
    }
    const orderKey = `${shopKey}\u0000${tradeNo}`;
    if (tradeNo && seenOrders.has(orderKey)) errors.push({ code: 'ORDER_DUPLICATE', location, tradeNo });
    seenOrders.add(orderKey);
    const rowErrorsBefore = errors.length;
    const header = {
      shop_key: shopKey,
      wdt_trade_no: tradeNo,
      wdt_trade_id: tradeId,
      platform_trade_id: text(order?.tid),
      source_trade_ids: order?.srcTids ?? null,
      wdt_shop_id: shopId,
      platform_name: text(order?.platformName),
      shop_name: actualShopName,
      warehouse_name: text(order?.warehouseName),
      order_status_code: Number.isInteger(order?.tradeStatus) ? order.tradeStatus : null,
      order_status_text: text(order?.tradeStatusFrontText),
      refund_status_code: Number.isInteger(order?.refundStatus) ? order.refundStatus : null,
      refund_status_text: text(order?.refundStatusText),
      paid_at: paidAt,
      ordered_at: shanghaiTimestamp(order?.tradeTime, 'tradeTime', location, errors),
      audited_at: shanghaiTimestamp(order?.auditTime, 'auditTime', location, errors),
      shipped_at: shanghaiTimestamp(order?.consignTime, 'consignTime', location, errors),
      printed_at: shanghaiTimestamp(order?.printTime, 'printTime', location, errors),
      estimate_ship_at: shanghaiTimestamp(order?.estimateConsignTime, 'estimateConsignTime', location, errors),
      plan_deliver_at: shanghaiTimestamp(order?.planDeliverTime, 'planDeliverTime', location, errors),
      plan_collect_at: shanghaiTimestamp(order?.planCollectTime, 'planCollectTime', location, errors),
      collected_at: shanghaiTimestamp(order?.collectTime, 'collectTime', location, errors),
      plan_transfer_at: shanghaiTimestamp(order?.planTransferTime, 'planTransferTime', location, errors),
      logistics_status: text(order?.logisticsStatus),
      goods_count: decimal(order?.goodsCount, 'goodsCount', location, errors),
      goods_type_count: decimal(order?.goodsTypeCount, 'goodsTypeCount', location, errors),
      real_amount: decimal(order?.realAmount, 'realAmount', location, errors),
      paid_amount: decimal(order?.paid, 'paid', location, errors, { required: true }),
      refund_amount: decimal(order?.refundAmount, 'refundAmount', location, errors),
      logistics: Array.isArray(order?.logistics) ? order.logistics : [],
      source_order: order,
    };
    if (errors.length === rowErrorsBefore) orderRows.push(header);

    const signatureCounts = new Map();
    const items = Array.isArray(order?.items) ? order.items : [];
    items.forEach((item, itemIndex) => {
      const itemLocation = `${location}.items[${itemIndex}]`;
      const stableId = text(item?.orderItemId);
      const signature = [tradeNo, text(item?.srcOid), text(item?.apiSpuId), text(item?.apiSkuId), text(item?.skuNo)].join('\u0000');
      const occurrence = (signatureCounts.get(signature) || 0) + 1;
      signatureCounts.set(signature, occurrence);
      const orderLineKey = stableId ? `id:${stableId}` : `fallback:${sha256(signature).slice(0, 32)}:${occurrence}`;
      const lineKey = `${shopKey}\u0000${orderLineKey}`;
      if (seenLines.has(lineKey)) errors.push({ code: 'ORDER_LINE_DUPLICATE', location: itemLocation, orderLineKey });
      seenLines.add(lineKey);
      if (!stableId) warnings += 1;
      lineRows.push({
        shop_key: shopKey,
        order_line_key: orderLineKey,
        line_key_method: stableId ? 'wdt-order-item-id' : 'composite-occurrence-sha256',
        wdt_order_line_id: stableId,
        wdt_trade_no: tradeNo,
        source_order_line_id: text(item?.srcOid),
        platform_product_id: text(item?.apiSpuId),
        platform_sku_id: text(item?.apiSkuId),
        erp_goods_no: text(item?.spuNo),
        erp_spec_no: text(item?.skuNo),
        product_name: text(item?.spuName),
        sku_name: text(item?.skuName),
        quantity: decimal(item?.skuNum, 'skuNum', itemLocation, errors),
        refund_quantity: decimal(item?.refundNum, 'refundNum', itemLocation, errors),
        source_share_amount: decimal(item?.shareAmount, 'shareAmount', itemLocation, errors),
        source_line_paid: decimal(item?.paid, 'paid', itemLocation, errors),
        refund_status_text: text(item?.refundStatusName),
        order_status_text: text(item?.tradeStatusName),
        source_goods_cost: decimal(item?.goodsCost, 'goodsCost', itemLocation, errors),
        source_ref_unit_cost: decimal(item?.refCostPrice, 'refCostPrice', itemLocation, errors),
        source_weight: decimal(item?.weight, 'weight', itemLocation, errors),
        gift_type: Number.isInteger(item?.giftType) ? item.giftType : null,
        source_line: item,
      });
    });

    const logistics = Array.isArray(order?.logistics) ? order.logistics : [];
    logistics.forEach((shipment, shipmentIndex) => {
      const trackingNo = text(shipment?.trackingNo);
      if (!trackingNo || !tradeNo) return;
      const shipmentKey = `${tradeNo}:${sha256(`${trackingNo}\u0000${text(shipment?.carrier) || ''}`).slice(0, 32)}`;
      const globalKey = `${shopKey}\u0000${shipmentKey}`;
      if (seenShipments.has(globalKey)) return;
      seenShipments.add(globalKey);
      shipmentRows.push({
        shop_key: shopKey,
        shipment_key: shipmentKey,
        wdt_trade_no: tradeNo,
        tracking_no: trackingNo,
        carrier_raw_name: text(shipment?.carrier),
        source_index: shipmentIndex,
      });
    });
  });

  if (Number(metadata.exportedItemRows) !== lineRows.length) {
    errors.push({ code: 'ORDER_LINE_COUNT_MISMATCH', metadata: metadata.exportedItemRows, actual: lineRows.length });
  }

  return {
    ok: errors.length === 0,
    file,
    fileSha256,
    ordersSha256,
    shopKey,
    shopName,
    coverageStart,
    coverageEnd,
    observedAt: text(metadata.exportedAt),
    sourceSchemaVersion: Number(metadata.schemaVersion),
    sourceChannel: metadata.channel,
    orderCount: orderRows.length,
    lineCount: lineRows.length,
    shipmentCount: shipmentRows.length,
    fallbackLineKeys: warnings,
    errors,
    metadata,
    rows: { orders: orderRows, lines: lineRows, shipments: shipmentRows },
  };
}

async function upsertJsonRows(client, sql, rows, batchId, observedAt, chunkSize = 500) {
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize).map((row) => ({ ...row, source_batch_id: batchId, observed_at: observedAt }));
    await client.query(sql, [JSON.stringify(chunk)]);
  }
}

const HEADER_UPSERT = `
  INSERT INTO raw.wdt_order_headers(
    shop_key,wdt_trade_no,wdt_trade_id,platform_trade_id,source_trade_ids,wdt_shop_id,platform_name,shop_name,
    warehouse_name,order_status_code,order_status_text,refund_status_code,refund_status_text,paid_at,ordered_at,audited_at,
    shipped_at,printed_at,estimate_ship_at,plan_deliver_at,plan_collect_at,collected_at,plan_transfer_at,logistics_status,
    goods_count,goods_type_count,real_amount,paid_amount,refund_amount,logistics,source_order,source_batch_id,observed_at)
  SELECT r.shop_key,r.wdt_trade_no,r.wdt_trade_id,r.platform_trade_id,r.source_trade_ids,r.wdt_shop_id,r.platform_name,r.shop_name,
    r.warehouse_name,r.order_status_code,r.order_status_text,r.refund_status_code,r.refund_status_text,r.paid_at::timestamptz,
    r.ordered_at::timestamptz,r.audited_at::timestamptz,r.shipped_at::timestamptz,r.printed_at::timestamptz,
    r.estimate_ship_at::timestamptz,r.plan_deliver_at::timestamptz,r.plan_collect_at::timestamptz,r.collected_at::timestamptz,
    r.plan_transfer_at::timestamptz,r.logistics_status,r.goods_count::numeric,r.goods_type_count::numeric,r.real_amount::numeric,
    r.paid_amount::numeric,r.refund_amount::numeric,r.logistics,r.source_order,r.source_batch_id::uuid,r.observed_at::timestamptz
  FROM jsonb_to_recordset($1::jsonb) AS r(
    shop_key text,wdt_trade_no text,wdt_trade_id text,platform_trade_id text,source_trade_ids jsonb,wdt_shop_id text,
    platform_name text,shop_name text,warehouse_name text,order_status_code integer,order_status_text text,refund_status_code integer,
    refund_status_text text,paid_at text,ordered_at text,audited_at text,shipped_at text,printed_at text,estimate_ship_at text,
    plan_deliver_at text,plan_collect_at text,collected_at text,plan_transfer_at text,logistics_status text,goods_count text,
    goods_type_count text,real_amount text,paid_amount text,refund_amount text,logistics jsonb,source_order jsonb,source_batch_id text,observed_at text)
  ON CONFLICT(shop_key,wdt_trade_no) DO UPDATE SET
    wdt_trade_id=excluded.wdt_trade_id,platform_trade_id=excluded.platform_trade_id,source_trade_ids=excluded.source_trade_ids,
    wdt_shop_id=excluded.wdt_shop_id,platform_name=excluded.platform_name,shop_name=excluded.shop_name,warehouse_name=excluded.warehouse_name,
    order_status_code=excluded.order_status_code,order_status_text=excluded.order_status_text,refund_status_code=excluded.refund_status_code,
    refund_status_text=excluded.refund_status_text,paid_at=excluded.paid_at,ordered_at=excluded.ordered_at,audited_at=excluded.audited_at,
    shipped_at=excluded.shipped_at,printed_at=excluded.printed_at,estimate_ship_at=excluded.estimate_ship_at,
    plan_deliver_at=excluded.plan_deliver_at,plan_collect_at=excluded.plan_collect_at,collected_at=excluded.collected_at,
    plan_transfer_at=excluded.plan_transfer_at,logistics_status=excluded.logistics_status,goods_count=excluded.goods_count,
    goods_type_count=excluded.goods_type_count,real_amount=excluded.real_amount,paid_amount=excluded.paid_amount,
    refund_amount=excluded.refund_amount,logistics=excluded.logistics,source_order=excluded.source_order,
    source_batch_id=excluded.source_batch_id,observed_at=excluded.observed_at`;

const LINE_UPSERT = `
  INSERT INTO raw.wdt_order_lines(
    shop_key,order_line_key,line_key_method,wdt_order_line_id,wdt_trade_no,source_order_line_id,platform_product_id,
    platform_sku_id,erp_goods_no,erp_spec_no,product_name,sku_name,quantity,refund_quantity,source_share_amount,
    source_line_paid,refund_status_text,order_status_text,source_goods_cost,source_ref_unit_cost,source_weight,gift_type,
    source_line,source_batch_id,observed_at)
  SELECT r.shop_key,r.order_line_key,r.line_key_method,r.wdt_order_line_id,r.wdt_trade_no,r.source_order_line_id,
    r.platform_product_id,r.platform_sku_id,r.erp_goods_no,r.erp_spec_no,r.product_name,r.sku_name,r.quantity::numeric,
    r.refund_quantity::numeric,r.source_share_amount::numeric,r.source_line_paid::numeric,r.refund_status_text,
    r.order_status_text,r.source_goods_cost::numeric,r.source_ref_unit_cost::numeric,r.source_weight::numeric,r.gift_type,
    r.source_line,r.source_batch_id::uuid,r.observed_at::timestamptz
  FROM jsonb_to_recordset($1::jsonb) AS r(
    shop_key text,order_line_key text,line_key_method text,wdt_order_line_id text,wdt_trade_no text,source_order_line_id text,
    platform_product_id text,platform_sku_id text,erp_goods_no text,erp_spec_no text,product_name text,sku_name text,
    quantity text,refund_quantity text,source_share_amount text,source_line_paid text,refund_status_text text,
    order_status_text text,source_goods_cost text,source_ref_unit_cost text,source_weight text,gift_type integer,
    source_line jsonb,source_batch_id text,observed_at text)
  ON CONFLICT(shop_key,order_line_key) DO UPDATE SET
    line_key_method=excluded.line_key_method,wdt_order_line_id=excluded.wdt_order_line_id,wdt_trade_no=excluded.wdt_trade_no,
    source_order_line_id=excluded.source_order_line_id,platform_product_id=excluded.platform_product_id,
    platform_sku_id=excluded.platform_sku_id,erp_goods_no=excluded.erp_goods_no,erp_spec_no=excluded.erp_spec_no,
    product_name=excluded.product_name,sku_name=excluded.sku_name,quantity=excluded.quantity,refund_quantity=excluded.refund_quantity,
    source_share_amount=excluded.source_share_amount,source_line_paid=excluded.source_line_paid,
    refund_status_text=excluded.refund_status_text,order_status_text=excluded.order_status_text,
    source_goods_cost=excluded.source_goods_cost,source_ref_unit_cost=excluded.source_ref_unit_cost,
    source_weight=excluded.source_weight,gift_type=excluded.gift_type,source_line=excluded.source_line,
    source_batch_id=excluded.source_batch_id,observed_at=excluded.observed_at`;

const SHIPMENT_UPSERT = `
  INSERT INTO raw.shipments(shop_key,shipment_key,wdt_trade_no,tracking_no,carrier_raw_name,source_batch_id,observed_at)
  SELECT r.shop_key,r.shipment_key,r.wdt_trade_no,r.tracking_no,r.carrier_raw_name,r.source_batch_id::uuid,r.observed_at::timestamptz
  FROM jsonb_to_recordset($1::jsonb) AS r(shop_key text,shipment_key text,wdt_trade_no text,tracking_no text,
    carrier_raw_name text,source_batch_id text,observed_at text)
  ON CONFLICT(shop_key,shipment_key) DO UPDATE SET
    wdt_trade_no=excluded.wdt_trade_no,tracking_no=excluded.tracking_no,carrier_raw_name=excluded.carrier_raw_name,
    source_batch_id=excluded.source_batch_id,observed_at=excluded.observed_at`;

export async function importProfitOrderExport(client, validation) {
  if (!validation?.ok) throw new Error('订单导出未通过校验，拒绝入库');
  await ensureProfitOrderSchema(client);
  const existing = await client.query(
    `SELECT batch_id,status,order_count,line_count,shipment_count,coverage_start,coverage_end,imported_at
       FROM meta.profit_source_batches WHERE source_sha256=$1`,
    [validation.fileSha256],
  );
  if (existing.rowCount) return { alreadyImported: true, ...existing.rows[0] };

  const batchId = crypto.randomUUID();
  const observedAt = validation.observedAt || new Date().toISOString();
  await client.query('BEGIN');
  try {
    await client.query(`
      INSERT INTO meta.profit_source_batches(
        batch_id,source_type,shop_key,source_file,source_sha256,source_schema_version,source_channel,query_time_field,
        coverage_start,coverage_end,observed_at,order_count,line_count,shipment_count,status,source_metadata)
      VALUES($1,'wdt-orders',$2,$3,$4,$5,$6,'payTime',$7,$8,$9,$10,$11,$12,'importing',$13::jsonb)
    `, [batchId, validation.shopKey, path.basename(validation.file), validation.fileSha256,
      validation.sourceSchemaVersion, validation.sourceChannel, validation.coverageStart, validation.coverageEnd,
      observedAt, validation.orderCount, validation.lineCount, validation.shipmentCount,
      JSON.stringify(validation.metadata)]);
    await upsertJsonRows(client, HEADER_UPSERT, validation.rows.orders, batchId, observedAt);
    await upsertJsonRows(client, LINE_UPSERT, validation.rows.lines, batchId, observedAt);
    await upsertJsonRows(client, SHIPMENT_UPSERT, validation.rows.shipments, batchId, observedAt);
    await client.query(`UPDATE meta.profit_source_batches SET status='imported',imported_at=now() WHERE batch_id=$1`, [batchId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return {
    alreadyImported: false,
    batchId,
    sourceSha256: validation.fileSha256,
    shopKey: validation.shopKey,
    coverageStart: validation.coverageStart,
    coverageEnd: validation.coverageEnd,
    orderCount: validation.orderCount,
    lineCount: validation.lineCount,
    shipmentCount: validation.shipmentCount,
  };
}

function enumerateDates(startDate, endDate) {
  const result = [];
  for (let cursor = new Date(`${startDate}T00:00:00Z`), end = new Date(`${endDate}T00:00:00Z`);
    cursor <= end; cursor = new Date(cursor.getTime() + 86400000)) {
    result.push(cursor.toISOString().slice(0, 10));
  }
  return result;
}

function periodsFromDates(dates) {
  if (!dates.length) return [];
  const periods = [];
  let start = dates[0];
  let previous = dates[0];
  for (const date of dates.slice(1)) {
    const expected = new Date(`${previous}T00:00:00Z`).getTime() + 86400000;
    if (new Date(`${date}T00:00:00Z`).getTime() !== expected) {
      periods.push({ startDate: start, endDate: previous });
      start = date;
    }
    previous = date;
  }
  periods.push({ startDate: start, endDate: previous });
  return periods;
}

export async function getProfitOrderCoverage(client, { shopKey, startDate, endDate }) {
  if (!shopKey) throw new Error('缺少 --shop-key');
  assertDate(startDate, '--start-date');
  assertDate(endDate, '--end-date');
  if (startDate > endDate) throw new Error('--start-date 不能晚于 --end-date');
  await ensureProfitOrderSchema(client);
  const result = await client.query(`
    SELECT batch_id,coverage_start::text,coverage_end::text,order_count,line_count,shipment_count,imported_at
      FROM meta.profit_source_batches
     WHERE source_type='wdt-orders' AND shop_key=$1 AND status='imported'
       AND coverage_end >= $2::date AND coverage_start <= $3::date
     ORDER BY coverage_start,coverage_end,imported_at
  `, [shopKey, startDate, endDate]);
  const covered = new Set();
  for (const row of result.rows) {
    const lower = row.coverage_start > startDate ? row.coverage_start : startDate;
    const upper = row.coverage_end < endDate ? row.coverage_end : endDate;
    for (const date of enumerateDates(lower, upper)) covered.add(date);
  }
  const allDates = enumerateDates(startDate, endDate);
  const missingDates = allDates.filter((date) => !covered.has(date));
  const counts = await client.query(`
    SELECT count(*)::bigint AS orders,
      (SELECT count(*)::bigint FROM raw.wdt_order_lines l JOIN raw.wdt_order_headers h
        ON h.shop_key=l.shop_key AND h.wdt_trade_no=l.wdt_trade_no
       WHERE h.shop_key=$1 AND (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date) AS lines,
      (SELECT count(*)::bigint FROM raw.shipments s JOIN raw.wdt_order_headers h
        ON h.shop_key=s.shop_key AND h.wdt_trade_no=s.wdt_trade_no
       WHERE h.shop_key=$1 AND (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date) AS shipments
      FROM raw.wdt_order_headers h
     WHERE h.shop_key=$1 AND (h.paid_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date
  `, [shopKey, startDate, endDate]);
  return {
    dataset: '旺店通-订单及明细',
    shopKey,
    startDate,
    endDate,
    complete: missingDates.length === 0,
    coveredDays: covered.size,
    expectedDays: allDates.length,
    missingPeriods: periodsFromDates(missingDates),
    batches: result.rows,
    rows: counts.rows[0],
  };
}

export async function listProfitOrderIdentities(client) {
  await ensureProfitOrderSchema(client);
  const result = await client.query(`
    SELECT shop_key,wdt_shop_id,shop_name,platform_name,
      count(*)::bigint AS order_count,
      min((paid_at AT TIME ZONE 'Asia/Shanghai')::date)::text AS min_date,
      max((paid_at AT TIME ZONE 'Asia/Shanghai')::date)::text AS max_date,
      max(observed_at) AS last_observed_at
    FROM raw.wdt_order_headers
    GROUP BY shop_key,wdt_shop_id,shop_name,platform_name
    ORDER BY shop_key,wdt_shop_id,shop_name
  `);
  return { identities: result.rows };
}

export function scanForbiddenOrderKeys(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const forbidden = ['receiver','mobile','phone','address','buyerNick','remark','customerMessage'];
  return forbidden.filter((key) => new RegExp(`"${key}"\\s*:`, 'i').test(raw));
}
