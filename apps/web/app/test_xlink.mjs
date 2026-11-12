import { JSDOM } from "jsdom";

const html = '<svg><use xlink:href="javascript:alert(1)"></use></svg>';
const dom = new JSDOM(`<\!DOCTYPE html><body>${html}</body>`);
const body = dom.window.document.body;

const useEl = body.querySelector("use");
if (useEl && useEl.getAttribute("xlink:href")) {
  console.log("XLINK:HREF FOUND");
  console.log("Value:", useEl.getAttribute("xlink:href"));
  
  // Check if sanitizer would catch it
  const attrName = useEl.attributes[0].name.toLowerCase();
  console.log("Lowercased name:", attrName);
  console.log("Would match 'href'?", attrName === "href");
  console.log("Would match 'src'?", attrName === "src");
}
