/**
 * A stand-in for Next's `server-only` marker, for processes that are not Next.
 *
 * `server-only` is a one-line package with a `react-server` export condition: Next
 * resolves it to an empty module inside a server component and to a module that
 * throws anywhere else. It is never installed as a dependency — Next supplies the
 * resolution — so any Bun process importing an `apps/web` server module fails with
 * `Cannot find package 'server-only'`, an error that says nothing about the real
 * problem.
 *
 * This module is that empty server branch. Importing it asserts the same thing the
 * marker does: this code is server-side. It carries no logic, and adding any would
 * change what the marker means.
 */
export {}
