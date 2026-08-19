export const COMMAND_DEFINITIONS = Object.freeze([
  {
    key: 'version',
    maturity: 'stable',
    audience: 'internal',
    description: '查看当前 tbcli 版本',
  },
  {
    key: 'auth login',
    maturity: 'stable',
    audience: 'internal',
    description: '打开固定浏览器 Profile，等待用户完成淘宝登录并确认登录成功',
  },
  {
    key: 'auth status',
    maturity: 'stable',
    audience: 'internal',
    description: '检查固定浏览器 Profile 中的淘宝登录状态',
  },
  {
    key: 'skill source',
    maturity: 'stable',
    audience: 'internal',
    description: '查看 tbcli 配套 Agent Skill 的唯一源目录',
  },
  {
    key: 'skill status',
    maturity: 'stable',
    audience: 'internal',
    description: '检查 tbcli 配套 Agent Skill 的安装状态',
  },
  {
    key: 'skill install',
    maturity: 'stable',
    audience: 'internal',
    description: '安装 tbcli 配套 Agent Skill',
  },
  {
    key: 'skill update',
    maturity: 'stable',
    audience: 'internal',
    description: '更新 tbcli 管理的 Agent Skill 副本',
  },
  {
    key: 'sycm catalog',
    maturity: 'stable',
    audience: 'business',
    capability: {
      id: 'sycm-report-catalog',
      name: '查看生意参谋与无界取数目录和字段',
      description: '逐级查看数据平台、数据粒度、数据维度、时间粒度、筛选项及全部可选字段代码。',
      examplePrompt: '查看生意参谋店铺关键词报表有哪些字段',
      requiredInputs: ['已登录的生意参谋账号'],
      optionalInputs: ['数据平台', '数据粒度', '数据维度'],
      delivery: '当前账号实时可用的报表目录和字段清单',
      commandTemplate: 'tbcli sycm catalog --data-platform <平台> --data-type <粒度> --data-dimension <维度> [--json]',
    },
  },
  {
    key: 'browser open',
    maturity: 'stable',
    audience: 'internal',
    description: '打开统一电商浏览器',
  },
  {
    key: 'shop products',
    maturity: 'stable',
    audience: 'business',
    capability: {
      id: 'taobao-shop-products',
      name: '获取淘宝/天猫店铺商品列表',
      description: '按店铺真实分页逐页获取商品、价格、销量、链接、图片和 SKU 缩略信息，中断时保留已获取内容，并整理成 Excel。',
      examplePrompt: '帮我获取【店铺首页链接】的商品列表',
      requiredInputs: ['店铺首页链接'],
      optionalInputs: ['只获取指定页', '最多获取多少页（默认获取全部）', '断点文件保存位置（默认自动生成）'],
      delivery: 'Excel 文件，包含概览、商品列表和 SKU 明细',
      commandTemplate: 'tbcli shop products --url <店铺首页链接> --out <商品列表.xlsx>',
    },
  },
  {
    key: 'ai-dianjing export',
    maturity: 'stable',
    audience: 'business',
    capability: {
      id: 'alimama-ai-dianjing-export',
      name: '导出AI点睛需求与投放报告',
      description: '根据AI点睛计划链接获取过去7天的计划汇总、需求表现、热门搜索词和搜索人群画像。',
      examplePrompt: '帮我获取这个AI点睛计划链接过去7天的需求和每个需求的投放报告',
      requiredInputs: ['AI点睛计划链接（或计划ID且对应页面已打开）'],
      optionalInputs: ['输出文件路径', '请求间隔（默认1000-2000毫秒）'],
      delivery: 'JSON原始数据，可继续整理成Excel分析报告',
      commandTemplate: 'tbcli ai-dianjing export --url <AI点睛计划链接> --days 7 --out <数据.json>',
    },
  },
  {
    key: 'sycm reports',
    maturity: 'stable',
    audience: 'business',
    capability: {
      id: 'sycm-saved-report-list',
      name: '查找生意参谋取数报表',
      description: '按名称查找分析空间中已有的取数报表，查看报表编号、数据维度、日期范围和字段数量。',
      examplePrompt: '帮我查找生意参谋分析空间里的【报表名称】',
      requiredInputs: ['已登录的生意参谋账号'],
      optionalInputs: ['报表名称关键词', '分页页码和每页数量'],
      delivery: '已有取数报表清单和可用于后续导出的报表编号',
      commandTemplate: 'tbcli sycm reports [--keyword <报表名称>] [--json]',
    },
  },
  {
    key: 'sycm export',
    maturity: 'stable',
    audience: 'business',
    capability: {
      id: 'sycm-saved-report-export',
      name: '导出生意参谋已有报表的完整数据',
      description: '复用分析空间中已有的取数报表，按报表名称或编号直接导出完整 Excel，无需重复创建相同报表。',
      examplePrompt: '帮我导出生意参谋报表【店铺-整体-全周期】的完整数据',
      requiredInputs: ['报表名称或报表编号', '新的 Excel 输出路径'],
      optionalInputs: ['生成超时时间', '请求间隔（默认1000-2000毫秒）'],
      delivery: '生意参谋生成的完整 Excel 原始数据文件',
      commandTemplate: 'tbcli sycm export --report-name <报表名称> --out <数据.xlsx>',
    },
  },
  {
    key: 'sycm fetch',
    maturity: 'stable',
    audience: 'business',
    capability: {
      id: 'sycm-date-range-fetch',
      name: '按指定日期获取生意参谋报表',
      description: '可复用已有母版，也可直接指定生意参谋/无界的数据粒度、维度和字段，按指定日期或当前全部可取历史生成完整 Excel；商品维度支持批量商品 ID 和终端类型；完成后自动清理临时报表。',
      examplePrompt: '获取【商品-整体】指定商品的全部历史分日数据，终端类型选择所有终端',
      requiredInputs: ['母版报表，或平台+粒度+维度', '指定日期或全部可取历史', '新的 Excel 输出路径'],
      optionalInputs: ['字段名称/代码（默认全部）', '商品 ID（最多100个）', '终端类型', '筛选项', '生成超时时间', '请求间隔（默认1000-2000毫秒）'],
      delivery: '指定日期范围的生意参谋完整 Excel 数据文件',
      commandTemplate: 'tbcli sycm fetch --data-platform <平台> --data-type <粒度> --data-dimension <维度> [--date-type <day|week|month|customDaySum>] [--fields <字段,...>] [--device <all|overall|wireless|pc>] [--item-ids <ID,...>] (--all-history | --start-date <YYYY-MM-DD> --end-date <YYYY-MM-DD>) --out <数据.xlsx>',
    },
  },
  {
    key: 'logistics get',
    maturity: 'stable',
    audience: 'business',
    capability: {
      id: 'taobao-order-logistics',
      name: '查询淘宝订单物流详情',
      description: '根据淘宝订单编号查询包裹、快递公司、运单号和物流轨迹。',
      examplePrompt: '帮我查询淘宝订单【订单编号】的物流详情',
      requiredInputs: ['淘宝订单编号'],
      optionalInputs: ['卖家ID（无法从当前页面自动识别时）'],
      delivery: '物流详情，可直接展示或保存为文件',
      commandTemplate: 'tbcli logistics get --trade-id <订单编号> [--seller-id <卖家ID>]',
    },
  },
  {
    key: 'document get',
    maturity: 'stable',
    audience: 'business',
    capability: {
      id: 'dingtalk-document-export',
      name: '读取钉钉在线文档',
      description: '根据钉钉文档链接读取完整正文、表格和原图，并整理成可继续分析或归档的文件包。',
      examplePrompt: '帮我读取【钉钉文档链接】的完整图文内容',
      requiredInputs: ['钉钉文档链接'],
      optionalInputs: ['导出目录', '是否下载原图（默认下载）', '提取成功后是否关闭来源标签页'],
      delivery: '图文文件包，包含 Markdown、纯文本、表格、原始文档结构、图片和清单',
      commandTemplate: 'tbcli document get --url <钉钉文档链接> --out <导出目录> [--close-tab]',
    },
  },
  {
    key: 'document tree',
    maturity: 'stable',
    audience: 'business',
    capability: {
      id: 'dingtalk-document-tree',
      name: '盘点钉钉知识库文档目录',
      description: '根据钉钉知识库或目录链接，逐层列出其中的文档和子目录，形成可继续批量读取的完整清单。',
      examplePrompt: '帮我盘点【钉钉知识库目录链接】下面的所有文档',
      requiredInputs: ['钉钉知识库目录链接'],
      optionalInputs: ['目录清单保存位置', '最大目录层级'],
      delivery: 'JSON 目录树，包含名称、文档链接、层级关系、子文档数量和更新时间',
      commandTemplate: 'tbcli document tree --url <钉钉知识库目录链接> --out <目录树.json>',
    },
  },
  {
    key: 'capabilities',
    maturity: 'stable',
    audience: 'internal',
    description: '查看 tbcli 的电商业务能力',
  },
  {
    key: 'doctor',
    maturity: 'stable',
    audience: 'internal',
    description: '检查 Chrome、浏览器会话和淘宝登录状态',
  },
  {
    key: 'dev pages',
    maturity: 'development',
    audience: 'development',
    description: '列出当前可用页面',
  },
  {
    key: 'dev inspect',
    maturity: 'development',
    audience: 'development',
    description: '检查店铺页面能力与安全识别字段',
  },
  {
    key: 'dev capture',
    maturity: 'development',
    audience: 'development',
    description: '限时捕获淘宝/天猫 API 请求元数据',
  },
]);

export function findCommandDefinition(group, command = '') {
  const key = [group, command].filter(Boolean).join(' ');
  return COMMAND_DEFINITIONS.find((entry) => entry.key === key) || null;
}

export function businessCapabilities() {
  return COMMAND_DEFINITIONS
    .filter((entry) => entry.audience === 'business' && entry.maturity === 'stable')
    .map((entry) => ({
      ...entry.capability,
      command: entry.key,
      maturity: entry.maturity,
    }));
}

export function technicalCapabilities() {
  return COMMAND_DEFINITIONS
    .filter((entry) => entry.audience !== 'business' && entry.key !== 'capabilities')
    .map(({ key, maturity, audience, description }) => ({ command: key, maturity, audience, description }));
}
