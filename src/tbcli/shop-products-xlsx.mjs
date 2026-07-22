import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from '@excel.js/exceljs';

const BLUE = '1F4E78';
const HEADER_BLUE = '2F75B5';
const LIGHT_BLUE = 'D9EAF7';
const WHITE = 'FFFFFF';

export async function writeShopProductsXlsx(file, source) {
  const out = path.resolve(file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const workbook = buildShopProductsWorkbook(source);
  await workbook.xlsx.writeFile(out);
  return out;
}

export function buildShopProductsWorkbook(source) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'tbcli';
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  const overview = workbook.addWorksheet('概览', { views: [{ state: 'frozen', ySplit: 3, showGridLines: false }] });
  const products = workbook.addWorksheet('商品列表', { views: [{ state: 'frozen', ySplit: 4, showGridLines: false }] });
  const skus = workbook.addWorksheet('SKU明细', { views: [{ state: 'frozen', ySplit: 4, showGridLines: false }] });
  const skuRows = source.items.flatMap((item) => (item.skus || []).map((sku) => [
    item.itemId, item.title, sku.skuId, sku.propertyText, sku.image, sku.url,
  ]));

  overview.mergeCells('A1:F1');
  overview.getCell('A1').value = `${source.shop.name || '店铺'}商品列表`;
  styleTitle(overview.getCell('A1'));
  overview.getRow(1).height = 32;
  overview.addRow([]);
  overview.addRow(['数据概要', '内容']);
  styleHeaderRow(overview.getRow(3));
  const summaryRows = [
    ['店铺名称', source.shop.name],
    ['店铺ID', source.shop.shopId],
    ['卖家ID', source.shop.sellerId],
    ['分页', formatPagination(source.pagesFetched, source.pageSize)],
    ['数据源URL', source.shop.url],
    ['生成时间', formatShanghaiTime(source.fetchedAt)],
    ['商品数', { formula: `COUNTA('商品列表'!B5:B${source.items.length + 4})`, result: source.items.length }],
    ['SKU明细数', { formula: `COUNTA('SKU明细'!C5:C${skuRows.length + 4})`, result: skuRows.length }],
    ['价格数', { formula: `COUNT('商品列表'!F5:F${source.items.length + 4})`, result: source.items.filter((item) => item.price !== '').length }],
  ];
  for (const row of summaryRows) overview.addRow(row);
  for (let row = 4; row <= 12; row += 1) {
    const label = overview.getCell(row, 1);
    label.fill = solidFill(LIGHT_BLUE);
    label.font = { bold: true, color: { argb: BLUE } };
    overview.getCell(row, 2).alignment = { vertical: 'top', wrapText: true };
  }
  overview.getColumn(1).width = 23;
  overview.getColumn(2).width = 82;
  overview.getCell('B5').numFmt = '0';
  overview.getCell('B6').numFmt = '0';

  products.mergeCells('A1:K1');
  products.getCell('A1').value = '商品列表';
  styleTitle(products.getCell('A1'));
  products.mergeCells('A2:K2');
  products.getCell('A2').value = `共导出 ${source.items.length} 个商品，价格为店铺列表展示价格。`;
  products.getCell('A2').fill = solidFill('E2F0D9');
  products.getCell('A2').font = { color: { argb: '375623' } };
  const productHeaders = [
    '序号', '商品ID', '商品标题', '主图URL', '商品链接', '价格',
    '365天模糊销量', '榜单文本', '榜单明细JSON', 'SKU数量', '权益/卖点',
  ];
  const productRows = source.items.map((item, index) => [
    index + 1,
    item.itemId,
    item.title,
    item.image,
    item.itemUrl,
    item.price === '' ? null : Number(item.price),
    item.vagueSold365,
    (item.rankings || []).map((entry) => entry.rightText || entry.rankName).filter(Boolean).join('；'),
    JSON.stringify(item.rankings || []),
    item.skuCount,
    item.benefits,
  ]);
  addStyledTable(products, 'ProductsTable', 'A4', productHeaders, productRows);
  setWidths(products, [8, 19, 48, 40, 40, 14, 16, 26, 38, 11, 25]);
  products.getColumn(2).numFmt = '0';
  products.getColumn(6).numFmt = '¥#,##0.00';
  products.getColumn(10).numFmt = '#,##0';
  products.getColumn(3).alignment = { vertical: 'top', wrapText: true };

  skus.mergeCells('A1:F1');
  skus.getCell('A1').value = 'SKU明细';
  styleTitle(skus.getCell('A1'));
  const skuHeaders = ['商品ID', '商品标题', 'SKU ID', 'SKU属性', 'SKU图片URL', 'SKU链接'];
  addStyledTable(skus, 'SkusTable', 'A4', skuHeaders, skuRows);
  setWidths(skus, [19, 48, 20, 30, 42, 42]);
  skus.getColumn(1).numFmt = '0';
  skus.getColumn(3).numFmt = '0';
  skus.getColumn(2).alignment = { vertical: 'top', wrapText: true };

  return workbook;
}

function addStyledTable(sheet, name, ref, headers, rows) {
  sheet.addTable({
    name,
    ref,
    headerRow: true,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: headers.map((header) => ({ name: header })),
    rows,
  });
  styleHeaderRow(sheet.getRow(4));
  for (let row = 5; row < 5 + rows.length; row += 1) {
    sheet.getRow(row).alignment = { vertical: 'top' };
  }
}

function styleTitle(cell) {
  cell.fill = solidFill(BLUE);
  cell.font = { bold: true, color: { argb: WHITE }, size: 18 };
  cell.alignment = { vertical: 'middle' };
}

function styleHeaderRow(row) {
  row.eachCell((cell) => {
    cell.fill = solidFill(HEADER_BLUE);
    cell.font = { bold: true, color: { argb: WHITE } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
}

function solidFill(argb) {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function setWidths(sheet, widths) {
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
}

function formatShanghaiTime(value) {
  return new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
}

function formatPagination(pagesFetched, pageSize) {
  const pages = Number(pagesFetched || 0);
  return pages <= 1 ? `第1页，每页 ${pageSize} 条` : `第1–${pages}页，每页 ${pageSize} 条`;
}
