import { JSDOM } from "jsdom";

const testCases = [
  // SVG with namespace attributes
  ['SVG xlink:href', '<svg><use xlink:href="javascript:alert(1)"></use></svg>'],
  ['SVG href (modern)', '<svg><use href="javascript:alert(2)"></use></svg>'],
  ['SVG image href', '<svg><image href="javascript:alert(3)" /></svg>'],
  ['SVG image xlink:href', '<svg><image xlink:href="javascript:alert(4)" /></svg>'],
  
  // Other namespaced attributes
  ['Namespaced onclick', '<div xml:onclick="alert(5)">test</div>'],
  ['HTML with formaction (form removed but button could remain)', '<button formaction="javascript:alert(6)">click</button>'],
  
  // Event handler with namespace
  ['Namespaced event', '<svg xhtml:onload="alert(7)"></svg>'],
];

function isSafeUrl(value) {
  const normalized = value.trim();
  if (\!normalized) return true;
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
  
  // Apply sanitizer
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
  const hasDangerous = result.match(/xlink:|formaction|xml:/i);
  
  console.log(`${name}:`);
  console.log(`  Input:  ${html}`);
  console.log(`  Output: ${result}`);
  console.log(`  Vulnerable: ${hasJavaScript || hasDangerous ? "YES" : "NO"}`);
  console.log();
}
