const ALLOWED_TAGS = new Set([
  "a", "p", "br", "strong", "em", "b", "i", "code", "pre", "ul", "ol", "li",
  "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead",
  "tbody", "tr", "th", "td", "img"
]);

const ALLOWED_ATTRS = new Set(["href", "src", "alt", "title", "class"]);
const URI_ATTRS = new Set(["href", "src"]);

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isSafeUri(value) {
  const trimmed = String(value || "").trim().toLowerCase();
  return !trimmed || trimmed.startsWith("http:") || trimmed.startsWith("https:") || trimmed.startsWith("/") || trimmed.startsWith("#") || trimmed.startsWith("mailto:") || trimmed.startsWith("data:image/");
}

export function sanitizeHtml(html) {
  return String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?([a-z0-9-]+)([^>]*)>/gi, (match, tagName, attrs = "") => {
      const tag = tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return "";
      if (match.startsWith("</")) return `</${tag}>`;

      const cleanAttrs =[];
      attrs.replace(/([a-z0-9:-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/gi, (_m, rawName, rawValue = "") => {
        const name = rawName.toLowerCase();
        if (name.startsWith("on") || !ALLOWED_ATTRS.has(name)) return "";
        const value = rawValue.replace(/^['"]|['"]$/g, "");
        if (URI_ATTRS.has(name) && !isSafeUri(value)) return "";
        cleanAttrs.push(`${name}="${escapeAttr(value)}"`);
        return "";
      });

      const suffix = /\/\s*>$/.test(match) ? " /" : "";
      return `<${tag}${cleanAttrs.length ? ` ${cleanAttrs.join(" ")}` : ""}${suffix}>`;
    });
}
