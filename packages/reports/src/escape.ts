// Site-derived values end up in code users paste into their site or terminal, so they are allow-listed AND escaped.
export const SAFE_URL = /^https?:\/\/[A-Za-z0-9._~:/?&=%#@+,-]+$/;
export const safeUrl = (u?: string) => (u && SAFE_URL.test(u) ? u : undefined);
const control = /[\u0000-\u001f\u007f]/g;
export const php = (s: string) => `'${s.replace(control, "").replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
export const sh = (s: string) => `'${s.replace(control, "").replace(/'/g, `'\\''`)}'`;
export const cmt = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\*\//g, "* /").slice(0, 160);
export const attr = (s: string) => s.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]!);
export const pathOf = (u: string) => { try { return new URL(u).pathname; } catch { return u; } };
