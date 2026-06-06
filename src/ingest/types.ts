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

/** Why a file failed to ingest — the file-relevant subset of the app-wide error categories. */
export type FileErrorCategory =
  | 'unsupported_format' // type unrecognized, or recognized but no extractor wired
  | 'malformed_file' // an extractor ran but produced nothing (empty/corrupt)
  | 'file_too_large' // skipped by the size guard before parsing
  | 'extractor_error'; // an extractor threw

export interface FileReport {
  name: string;
  type: DetectedType;
  ok: boolean; // true if we produced primitive(s) from it
  note?: string;
  errorCategory?: FileErrorCategory; // set when ok === false, for error-reporting/triage
}

export interface EvidenceBundle {
  primitives: Primitive[];
  files: FileReport[];
}

/** A content extractor: given a file name + bytes, return zero or more primitives. */
export type Extractor = (name: string, bytes: Uint8Array) => Primitive[];

/** An async content extractor (binary formats whose parsers are async, e.g. PDF). */
export type AsyncExtractor = (name: string, bytes: Uint8Array) => Promise<Primitive[]>;
