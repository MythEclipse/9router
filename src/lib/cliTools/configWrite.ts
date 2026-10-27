/**
 * Read-modify-write support for the CLI tool config files.
 *
 * The six settings routes each loaded the existing config with a bare `catch {}`
 * before merging and writing it back. That conflates two very different situations:
 *
 *   - the file does not exist yet — an empty config is correct, and
 *   - the file exists but cannot be read or parsed — writing back `{}` plus one
 *     setting silently discards every other setting the user had.
 *
 * `readConfigForWrite` separates them so a corrupt file becomes a clear error the
 * route can report instead of a quiet data loss.
 */

export class ConfigUnreadableError extends Error {
  constructor(
    readonly configPath: string,
    readonly cause: unknown
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Existing config at ${configPath} could not be read (${detail}). ` +
        `Refusing to overwrite it; fix or remove the file and retry.`
    );
    this.name = "ConfigUnreadableError";
  }
}

/** The subset of `node:fs/promises` this helper needs, so it can be tested. */
export interface ConfigFileIo {
  readFile(path: string, encoding: "utf-8"): Promise<string>;
}

/**
 * Load an existing config for a read-modify-write cycle.
 *
 * Returns `{}` only when the file genuinely does not exist. Any other failure — a
 * permissions problem, an unreadable encoding, a syntax error in the parser — is
 * raised as a `ConfigUnreadableError` so the caller aborts the write.
 */
export async function readConfigForWrite<T extends object>(
  fs: ConfigFileIo,
  configPath: string,
  parse: (raw: string) => T
): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch (error) {
    if (isMissingFile(error)) return {} as T;
    throw new ConfigUnreadableError(configPath, error);
  }

  try {
    return parse(raw) ?? ({} as T);
  } catch (error) {
    throw new ConfigUnreadableError(configPath, error);
  }
}

function isMissingFile(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
