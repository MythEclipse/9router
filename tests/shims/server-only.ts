/**
 * `server-only` marks a module as unable to run in the browser.
 *
 * In the Next bundle the package throws if it is imported from a client component, which
 * is the check we want; Vite has no such package and fails at collection instead. This
 * stand-in keeps the marker in the source and lets the test runner load the module.
 */
export {}
