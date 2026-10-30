declare module '@vidterra/misb.js' {
  interface ParsedItem {
    key: number;
    name: string;
    value: unknown;
    unit?: string;
    valid?: boolean;
  }
  const misb: {
    st0601: { parse(buffer: Buffer | string, options?: Record<string, unknown>): ParsedItem[] };
  };
  export default misb;
}
