/**
 * Product Source Layer 测试夹具：在内存中构造一份最小但结构合法的
 * SellerSprite Amazon US「搜索报表」XLSX（stored ZIP + inlineStr）。
 *
 * 只用于单元测试；不读取真实文件、不下载任何 URL。
 */

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const value of input) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries: ReadonlyArray<readonly [string, string]>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const content = Buffer.from(text, "utf8");
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function columnName(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function sheetXml(
  headers: readonly string[],
  rows: ReadonlyArray<Readonly<Record<string, string>>>,
): string {
  const allRows = [
    Object.fromEntries(headers.map((header) => [header, header])),
    ...rows,
  ];
  const rendered = allRows.map((row, rowIndex) => {
    const cells = headers.flatMap((header, columnIndex) => {
      const value = row[header];
      if (value === undefined || value === "") return [];
      return `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
    });
    return `<row r="${rowIndex + 1}">${cells.join("")}</row>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<dimension ref="A1:${columnName(headers.length - 1)}${allRows.length}"/>`,
    `<sheetData>${rendered.join("")}</sheetData>`,
    "</worksheet>",
  ].join("");
}

/** 触发 search_results 判定所必需的最小表头集合。 */
export const SOURCE_LAYER_TEST_HEADERS = [
  "ASIN",
  "商品标题",
  "商品详情页链接",
  "商品主图",
  "搜索排名",
  "大类目",
  "大类BSR",
  "小类BSR",
  "月销量",
  "月销售额($)",
  "价格($)",
  "评分",
  "评分数",
  "品牌",
  "包装重量（单位换算）",
  "包装尺寸（单位换算）",
  "商品重量（单位换算）",
  "商品尺寸（单位换算）",
  "上架时间",
  "Buybox卖家",
  "配送方式",
  "预估FBA费",
  "毛利率",
  "LQS评分",
  "未映射原始列",
] as const;

export type SourceLayerTestRow = Partial<Record<(typeof SOURCE_LAYER_TEST_HEADERS)[number], string>>;

export const SOURCE_LAYER_TEST_ROWS: SourceLayerTestRow[] = [
  {
    ASIN: "B0FH1ZXTN1",
    "商品标题": "Owala FreeSip Insulated Stainless Steel Water Bottle with Straw, 24 oz",
    "商品详情页链接": "https://www.amazon.com/dp/B0FH1ZXTN1",
    "商品主图": "https://m.media-amazon.com/images/I/main-1.jpg",
    "搜索排名": "自然位：第1页第3位",
    "大类目": "Sports & Outdoors",
    "大类BSR": "120",
    "小类BSR": "15",
    "月销量": "3500",
    "月销售额($)": "104965",
    "价格($)": "29.99",
    "评分": "4.6",
    "评分数": "2948",
    "品牌": "Owala",
    "包装重量（单位换算）": "1.25 lb",
    "包装尺寸（单位换算）": "10 x 5 x 3 in",
    "商品重量（单位换算）": "0.9 lb",
    "商品尺寸（单位换算）": "9 x 4 x 2 in",
    "上架时间": "2024-06-01",
    "Buybox卖家": "Owala Official",
    "配送方式": "FBA",
    "预估FBA费": "$4.25",
    "毛利率": "35.5%",
    "LQS评分": "8.7",
    "未映射原始列": "preserved-value",
  },
  {
    ASIN: "B0TEST0002",
    "商品标题": "Stainless Steel Insulated Travel Tumbler With Handle And Lid, 40 oz",
    "商品详情页链接": "https://www.amazon.com/dp/B0TEST0002",
    "商品主图": "https://m.media-amazon.com/images/I/main-2.jpg",
    "搜索排名": "自然位：第1页第9位",
    "大类目": "Home & Kitchen",
    "大类BSR": "860",
    "价格($)": "34.50",
    "评分": "4.3",
    "评分数": "510",
    "品牌": "ExampleBrand",
    "包装重量（单位换算）": "0.8 lb",
    "包装尺寸（单位换算）": "8 x 4 x 3 in",
    "商品重量（单位换算）": "0.6 lb",
    "商品尺寸（单位换算）": "7 x 3 x 2 in",
    "上架时间": "2025-01-10",
    "Buybox卖家": "Example Seller",
    "配送方式": "FBM",
    "预估FBA费": "$5.10",
    "毛利率": "28%",
    "LQS评分": "7.2",
    "未映射原始列": "second-preserved-value",
  },
];

export interface ExtraTestSheet {
  name: string;
  headers: readonly string[];
  rows: ReadonlyArray<Readonly<Record<string, string>>>;
}

export function createSourceLayerTestWorkbook(options: {
  headers?: readonly string[];
  rows?: ReadonlyArray<Readonly<Record<string, string>>>;
  sheetName?: string;
  extraSheets?: ReadonlyArray<ExtraTestSheet>;
} = {}): Uint8Array {
  const headers = options.headers ?? [...SOURCE_LAYER_TEST_HEADERS];
  const rows = options.rows ?? SOURCE_LAYER_TEST_ROWS as ReadonlyArray<Readonly<Record<string, string>>>;
  const sheetName = options.sheetName ?? "US";
  const extraSheets = options.extraSheets ?? [];

  const allSheets = [
    { name: sheetName, headers, rows },
    ...extraSheets,
  ];

  const sheetsXml = allSheets.map((s, idx) =>
    `<sheet name="${xmlEscape(s.name)}" sheetId="${idx + 1}" r:id="rId${idx + 1}"/>`
  ).join("");

  const workbook = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    `<sheets>${sheetsXml}</sheets>`,
    "</workbook>",
  ].join("");

  const relsXml = allSheets.map((_, idx) =>
    `<Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${idx + 1}.xml"/>`
  ).join("");

  const relationships = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    relsXml,
    "</Relationships>",
  ].join("");

  const zipEntries: Array<readonly [string, string]> = [
    ["xl/workbook.xml", workbook],
    ["xl/_rels/workbook.xml.rels", relationships],
  ];

  allSheets.forEach((s, idx) => {
    zipEntries.push([`xl/worksheets/sheet${idx + 1}.xml`, sheetXml(s.headers, s.rows)]);
  });

  return createStoredZip(zipEntries);
}
