import { JSDOM } from "jsdom";

const testCases = [
  ['xlink:href', '<svg><use xlink:href="javascript:alert(1)"></use></svg>'],
  ['svg href', '<svg><use href="javascript:alert(2)"></use></svg>'],
  ['formaction', '<button formaction="javascript:alert(3)">click</button>'],
];

function isSafeUrl(value) {
  const normalized = value.trim();
  if (normalized.length === 0) return true;
  return (
    normalized.startsWith("#") ||
    normalized.startsWith("/") ||
    /^(https?:|mailto:|tel:)/i.test(normalized)
  );
}

const BLOCKED = ["script", "style", "iframe", "object", "embed", "link", "meta", "base", "form"].join(",");

for (const [name, html] of testCases) {
  const dom = new JSDOM(`<\!DOCTYPE html><body>${html}</body>`);
  const body = dom.window.document.body;
  
  for (const el of body.querySelectorAll(BLOCKED)) {
    el.remove();
  }
  
  for (const el of body.querySelectorAll("*")) {
    for (const attr of Array.from(el.attributes)) {
      const attrName = attr.name.toLowerCase();
      if (attrName.startsWith("on") || attrName === "srcdoc") {
        el.removeAttribute(attr.name);
        continue;
      }
      if ((attrName === "href" || attrName === "src") && \!isSafeUrl(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
  
  const result = body.innerHTML;
  const hasJavaScript = result.includes("javascript:");
  
  console.log(`${name}: ${hasJavaScript ? "VULNERABLE" : "safe"}`);
  if (hasJavaScript) {
    console.log(`  Output: ${result}`);
  }
}
