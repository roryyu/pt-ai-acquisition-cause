/**
 * CSV 解析纯函数（design.md 5.1 数据接入层 · API 数据结构化）
 *
 * 供 Adjust 等外部 API 的 CSV 响应结构化使用：
 * - scripts/sync-adjust-data.ts（落库同步）
 * - 算子统一取数分流层（任务问答 API 源实时拉数）
 *
 * 处理细节：
 * - 剥离 UTF-8 BOM（Adjust CSV 响应带 BOM，charset=utf-8-sig）
 * - 引号感知解析（字段内逗号/换行/转义双引号 ""）
 * - 数值列推断：整列非空值均为有限数字时转为 number
 */

/** 结构化 CSV 表格 */
export interface CsvTable {
  /** 表头（首行，已去 BOM） */
  header: string[];
  /** 数据行（数值列已转 number，其余为 string） */
  rows: Array<Array<string | number>>;
  /** 各列是否被推断为数值列 */
  numericColumns: boolean[];
}

/** 引号感知地拆分单条 CSV 记录（支持字段内逗号与转义双引号） */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/** 将 CSV 文本按引号感知切分为记录（字段内换行不切断记录） */
function splitCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      // 处理转义双引号：连续两个 " 不切换状态
      if (inQuotes && text[i + 1] === '"') {
        current += '""';
        i++;
        continue;
      }
      current += ch;
      continue;
    }
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      // 记录边界（\r\n 视为一个边界）
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (current.length > 0) records.push(splitCsvLine(current));
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.length > 0) records.push(splitCsvLine(current));
  return records;
}

/** 数值判定：非空且为有限十进制数（允许千分位外的常规格式） */
const NUMERIC_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * 解析 CSV 文本为结构化表格
 * 空文本 / 仅空白返回空表；首行为表头，其余为数据行
 */
export function parseCsvTable(text: string): CsvTable {
  const cleaned = text.replace(/^\uFEFF/, "");
  if (cleaned.trim().length === 0) {
    return { header: [], rows: [], numericColumns: [] };
  }
  const records = splitCsvRecords(cleaned);
  const header = records[0] ?? [];
  const rawRows = records.slice(1).filter((r) => r.some((cell) => cell.trim().length > 0));

  // 数值列推断：该列所有非空单元格均为数值
  const numericColumns = header.map((_, colIdx) => {
    let seenValue = false;
    for (const row of rawRows) {
      const cell = (row[colIdx] ?? "").trim();
      if (cell.length === 0) continue;
      seenValue = true;
      if (!NUMERIC_PATTERN.test(cell)) return false;
    }
    return seenValue;
  });

  const rows = rawRows.map((row) =>
    header.map((_, colIdx) => {
      const cell = row[colIdx] ?? "";
      return numericColumns[colIdx] && cell.trim().length > 0 ? Number(cell) : cell;
    }),
  );
  return { header, rows, numericColumns };
}

/** 按表头名将行转为对象（数值列已转 number；缺失列为空串） */
export function csvTableToObjects(table: CsvTable): Array<Record<string, string | number>> {
  return table.rows.map((row) => {
    const obj: Record<string, string | number> = {};
    table.header.forEach((name, idx) => {
      obj[name] = row[idx] ?? "";
    });
    return obj;
  });
}
