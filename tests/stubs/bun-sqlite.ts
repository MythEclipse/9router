/**
 * Test stand-in for `bun:sqlite`.
 *
 * Vitest runs on Node and cannot resolve Bun's builtin, but `apps/api`'s db
 * client imports it at module scope, so any test that reaches a delegating
 * route handler dies at collection before a single assertion runs.
 *
 * The stubs below exist only to keep those imports constructible. Tests that
 * need real database behaviour use `bun:test`, or inject a repository port and
 * never touch this module. Anything reaching a query here is a test that
 * forgot to stub its repository — so the failure is loud on purpose.
 */

function unimplemented(operation: string): never {
	throw new Error(
		`bun:sqlite stub: ${operation} was called. Stub the repository port instead of ` +
			"letting the test reach the database, or run the test under `bun test`.",
	)
}

export class Database {
	/** The file this handle claims to point at; no file is actually opened. */
	readonly file: string

	constructor(file = ":memory:", _options?: unknown) {
		this.file = file
	}

	query(..._args: unknown[]): never {
		return unimplemented("query()")
	}

	run(..._args: unknown[]): never {
		return unimplemented("run()")
	}

	exec(..._args: unknown[]): never {
		return unimplemented("exec()")
	}

	prepare(..._args: unknown[]): never {
		return unimplemented("prepare()")
	}

	close(): void {}
}

export default { Database }
