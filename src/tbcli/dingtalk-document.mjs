const PACKAGE_TYPE = 'application/x-alidocs-package';
const DINGTALK_HOST = 'alidocs.dingtalk.com';

export function assertDingtalkDocumentUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('--url 必须是有效的钉钉文档链接');
  }
  if (url.protocol !== 'https:' || url.hostname !== DINGTALK_HOST || !/^\/i\/nodes\/[A-Za-z0-9]+/.test(url.pathname)) {
    throw new Error('目前只支持 https://alidocs.dingtalk.com/i/nodes/... 文档链接');
  }
  return url;
}

export function extractDingtalkDocument(payload, sourceUrl, capturedAt = new Date().toISOString()) {
  if (!payload || payload.isSuccess !== true || Number(payload.status) !== 200) {
    throw new Error('钉钉文档数据返回失败');
  }
  const documentContent = payload.data?.documentContent;
  const checkpoint = documentContent?.checkpoint;
  if (typeof checkpoint?.content !== 'string' || !checkpoint.content.trim()) {
    throw new Error('钉钉文档没有返回可解析的结构化正文');
  }
  const deltas = documentContent?.deltas?.list;
  if (Array.isArray(deltas) && deltas.length > 0) {
    throw new Error(`文档包含 ${deltas.length} 个未合并增量，已停止导出以避免内容缺失`);
  }

  let packageData;
  try {
    packageData = JSON.parse(checkpoint.content);
  } catch {
    throw new Error('钉钉文档结构化正文不是有效 JSON');
  }
  if (packageData?.type !== PACKAGE_TYPE || !packageData.main || !packageData.parts?.[packageData.main]) {
    throw new Error('钉钉文档结构不受支持');
  }

  const fileMeta = payload.data?.fileMetaInfo || {};
  const source = assertDingtalkDocumentUrl(sourceUrl);
  const title = cleanDocumentTitle(fileMeta.name || '钉钉文档');
  return {
    packageData,
    metadata: {
      title,
      sourceUrl: source.toString(),
      sourceType: 'DingTalk dynamic document',
      capturedAt,
      captureMethod: 'authorized browser session, structured document response',
      nodeId: fileMeta.dentryUuid || source.pathname.split('/').filter(Boolean).at(-1) || '',
      modifiedAtEpochMs: Number(fileMeta.gmtModified || checkpoint.gmtCreate || 0) || null,
      publicOpenPermission: String(fileMeta.extMeta?.docMeta?.publicOpenPermission || ''),
      canRead: Number(fileMeta.abilities?.file || 0) > 0,
      checkpointVersion: Number(checkpoint.baseVersion || 0),
    },
  };
}

export function renderAlidocsPackage(packageData, { title = '钉钉文档', sourceUrl = '' } = {}) {
  const part = packageData.parts?.[packageData.main];
  const root = part?.data?.body;
  if (!isNode(root)) throw new Error('钉钉文档正文节点缺失');

  const images = [];
  const tables = [];
  const imageByKey = new Map();

  function registerImage(node) {
    const props = nodeProps(node);
    const key = String(props.extraData?.resourceId || props.uuid || props.src || images.length + 1);
    if (imageByKey.has(key)) return imageByKey.get(key);
    const meta = props.extraData?.metaData || {};
    const format = safeImageFormat(meta.format || extensionFromName(props.name) || 'png');
    const index = images.length + 1;
    const entry = {
      id: `IMG-${String(index).padStart(2, '0')}`,
      resourceId: String(props.extraData?.resourceId || ''),
      originalWidth: numberOrNull(meta.originWidth || props.width),
      originalHeight: numberOrNull(meta.originHeight || props.height),
      expectedSize: numberOrNull(meta.size || props.size),
      format,
      sourcePath: String(props.src || ''),
      localPath: `images/${String(index).padStart(2, '0')}.${format}`,
    };
    images.push(entry);
    imageByKey.set(key, entry);
    return entry;
  }

  function renderInline(value) {
    if (typeof value === 'string') return value;
    if (!isNode(value)) return Array.isArray(value) ? value.map(renderInline).join('') : '';
    const type = value[0];
    const props = nodeProps(value);
    if (type === 'br') return '  \n';
    if (type === 'img') return '';
    const content = nodeChildren(value).map(renderInline).join('');
    if (type === 'inlineCode') return content ? `\`${content.replaceAll('`', '\\`')}\`` : '';
    if (type === 'link' && /^https?:\/\//.test(String(props.href || ''))) {
      return `[${content || props.href}](${props.href})`;
    }
    if (props.bold && content) return `**${content}**`;
    if (props.italic && content) return `*${content}*`;
    return content;
  }

  function renderTable(node) {
    const rows = nodeChildren(node)
      .filter((child) => isNode(child) && child[0] === 'tr')
      .map((row) => nodeChildren(row)
        .filter((cell) => isNode(cell) && cell[0] === 'tc')
        .map((cell) => compactText(nodeChildren(cell).map(renderInline).join(' '))));
    const width = Math.max(0, ...rows.map((row) => row.length));
    if (!width) return '';
    const normalizedRows = rows.map((row) => Array.from({ length: width }, (_, index) => row[index] || ''));
    tables.push({ id: `TABLE-${String(tables.length + 1).padStart(2, '0')}`, rows: normalizedRows });
    const [header = Array(width).fill(''), ...body] = normalizedRows;
    const line = (row) => `| ${row.map(escapeTableCell).join(' | ')} |`;
    return [line(header), line(Array(width).fill('---')), ...body.map(line)].join('\n');
  }

  function renderBlock(value) {
    if (typeof value === 'string') return compactText(value);
    if (!isNode(value)) return Array.isArray(value) ? value.map(renderBlock).filter(Boolean).join('\n\n') : '';
    const type = value[0];
    if (/^h[1-6]$/.test(type)) {
      const level = Number(type.slice(1));
      return `${'#'.repeat(level)} ${compactText(nodeChildren(value).map(renderInline).join(''))}`.trim();
    }
    if (type === 'p') {
      const segments = [];
      let inline = '';
      for (const child of nodeChildren(value)) {
        if (isNode(child) && child[0] === 'img') {
          const text = compactText(inline);
          if (text) segments.push(text);
          inline = '';
          segments.push(renderBlock(child));
        } else {
          inline += renderInline(child);
        }
      }
      const text = compactText(inline);
      if (text) segments.push(text);
      return segments.join('\n\n');
    }
    if (type === 'img') {
      const image = registerImage(value);
      return `![文档图片 ${image.id}](${image.localPath})`;
    }
    if (type === 'table') return renderTable(value);
    if (type === 'hr') return '---';
    if (['ul', 'bulletList'].includes(type)) {
      return nodeChildren(value).map((child) => `- ${compactText(renderInline(child))}`).join('\n');
    }
    if (['ol', 'orderedList'].includes(type)) {
      return nodeChildren(value).map((child, index) => `${index + 1}. ${compactText(renderInline(child))}`).join('\n');
    }
    if (['li', 'listItem'].includes(type)) return compactText(nodeChildren(value).map(renderInline).join(''));
    if (['span', 'inlineCode', 'link', 'br'].includes(type)) return compactText(renderInline(value));
    return nodeChildren(value).map(renderBlock).filter(Boolean).join('\n\n');
  }

  const bodyMarkdown = normalizeMarkdown(renderBlock(root));
  const markdown = `# ${cleanDocumentTitle(title)}\n\n> 来源：${sourceUrl}\n\n${bodyMarkdown}`.trim() + '\n';
  const text = extractPlainText(root);
  return { markdown, text, tables, images };
}

export function cleanDocumentTitle(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\s*[··]\s*钉钉文档\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim() || '钉钉文档';
}

function extractPlainText(root) {
  const blocks = [];
  const visit = (value) => {
    if (!isNode(value)) return;
    const type = value[0];
    if (/^h[1-6]$/.test(type) || type === 'p') {
      const text = compactText(nodeChildren(value).map(plainInline).join(''));
      if (text) blocks.push(text);
      return;
    }
    if (type === 'table') {
      for (const row of nodeChildren(value).filter((child) => isNode(child) && child[0] === 'tr')) {
        const cells = nodeChildren(row)
          .filter((cell) => isNode(cell) && cell[0] === 'tc')
          .map((cell) => compactText(nodeChildren(cell).map(plainInline).join(' ')));
        if (cells.some(Boolean)) blocks.push(cells.join('\t'));
      }
      return;
    }
    for (const child of nodeChildren(value)) visit(child);
  };
  visit(root);
  return blocks.join('\n').trim() + '\n';
}

function plainInline(value) {
  if (typeof value === 'string') return value;
  if (!isNode(value)) return Array.isArray(value) ? value.map(plainInline).join('') : '';
  if (value[0] === 'br') return '\n';
  if (value[0] === 'img') return '';
  return nodeChildren(value).map(plainInline).join('');
}

function isNode(value) {
  return Array.isArray(value) && typeof value[0] === 'string';
}

function nodeProps(node) {
  return node?.[1] && !Array.isArray(node[1]) && typeof node[1] === 'object' ? node[1] : {};
}

function nodeChildren(node) {
  return node.slice(nodeProps(node) === node[1] ? 2 : 1);
}

function compactText(value) {
  return String(value || '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

function normalizeMarkdown(value) {
  return String(value || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function escapeTableCell(value) {
  return String(value || '').replaceAll('|', '\\|').replace(/\n+/g, '<br>');
}

function safeImageFormat(value) {
  const format = String(value || '').toLowerCase().replace(/^image\//, '');
  return ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(format) ? format : 'png';
}

function extensionFromName(value) {
  return String(value || '').split('.').at(-1)?.toLowerCase() || '';
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
