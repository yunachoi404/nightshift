import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function safeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid identifier');
  return value;
}
export function externalUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid URL');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Only web links are supported');
  return url.href;
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
/** Validate both the lexical path and symlink destination before touching Finder. */
export async function containedPath(root: string, path: string): Promise<string> {
  if (!inside(resolve(root), resolve(root, path))) throw new Error('Path leaves project folder');
  const [realRoot, realPath] = await Promise.all([realpath(root), realpath(resolve(root, path))]);
  if (!inside(realRoot, realPath)) throw new Error('Path leaves project folder');
  await stat(realPath);
  return realPath;
}
