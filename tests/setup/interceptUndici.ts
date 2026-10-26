/**
 * Mock undici.fetch so route handlers that import
 * `fetch as undiciFetch` from "undici" see our fake response.
 *
 * @param {(url: string) => object|null} matcher - return null to remove interception
 */
let activeMatcher = null;

export function interceptUndici(matcher) {
  activeMatcher = matcher;
  vi.mock("undici", async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      fetch: async (url, _init) => {
        const like = activeMatcher ? activeMatcher(String(url)) : null;
        if (!like) return actual.fetch(url, _init);
        return new Response(JSON.stringify(like), {
          status: like.ok ? 200 : 500,
          headers: { "content-type": "application/json" },
        });
      },
    };
  });
}
