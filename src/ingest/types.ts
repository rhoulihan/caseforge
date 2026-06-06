export type DetectedType =
  | 'pdf'
  | 'ooxml' // zip-based Office (xlsx/docx/pptx)
  | 'ole' // OLE2 compound (msg/xls/doc)
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'json'
  | 'csv'
  | 'tsv'
  | 'text'
  | 'unknown';

export interface TextPrimitive {
  kind: 'text';
  source: string;
  text: string;
}
export interface TablePrimitive {
  kind: 'table';
  source: string;
  headers: string[];
  rows: string[][];
}
export interface ImagePrimitive {
  kind: 'image';
  source: string;
  mime: string;
  bytes: Uint8Array;
}
export interface KeyValuePrimitive {
  kind: 'keyvalue';
  source: string;
  pairs: Record<string, string>;
}
export type Primitive = TextPrimitive | TablePrimitive | ImagePrimitive | KeyValuePrimitive;

export interface FileReport {
  name: string;
  type: DetectedType;
  ok: boolean; // true if we produced primitive(s) from it
  note?: string;
}

export interface EvidenceBundle {
  primitives: Primitive[];
  files: FileReport[];
}

/** A content extractor: given a file name + bytes, return zero or more primitives. */
export type Extractor = (name: string, bytes: Uint8Array) => Primitive[];

/** An async content extractor (binary formats whose parsers are async, e.g. PDF). */
export type AsyncExtractor = (name: string, bytes: Uint8Array) => Promise<Primitive[]>;
