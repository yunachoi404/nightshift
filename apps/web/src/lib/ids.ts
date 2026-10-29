export function id(prefix = ""): string {
  const rnd = Math.random().toString(36).slice(2, 8);
  const t = Date.now().toString(36).slice(-4);
  return prefix ? `${prefix}_${t}${rnd}` : `${t}${rnd}`;
}
