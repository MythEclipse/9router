/**
 * Name for a copy of a combo: the source name plus the first free `-N` suffix,
 * the way a file manager copies a file next to the original.
 *
 * The suffix is always derived from the ORIGINAL name (`foo` -> `foo-1`,
 * `foo-2`) and is never stripped from the source, so a name that legitimately
 * ends in digits (`claude-sonnet-4-5`) is not mistaken for an existing copy.
 */
export function nextCopyName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n += 1) {
    const candidate = `${name}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
