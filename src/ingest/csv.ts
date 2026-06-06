/** RFC4180-ish delimited parser. First record is the header row. Handles quoted fields
 *  containing the delimiter, embedded newlines, and escaped double-quotes (""). */
export function parseDelimited(
  text: string,
  delimiter: string
): { headers: string[]; rows: string[][] } {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    record.push(field);
    field = '';
  };
  const pushRecord = () => {
    records.push(record);
    record = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i++;
      continue;
    }
    if (ch === '\n') {
      pushField();
      pushRecord();
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || record.length > 0) {
    pushField();
    pushRecord();
  }
  const headers = records.length ? records[0]! : [];
  return { headers, rows: records.slice(1) };
}
