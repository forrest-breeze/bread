import { renderPublicHtml } from "@/lib/public-kb-render"
const code = (lang: string, n: number) => `<pre><code class="language-${lang}">${Array.from({length:n},(_,i)=>`const value${i} = await fetch("/v1/items/${i}").then((r) =&gt; r.json())`).join("\n")}</code></pre>`
const para = "<p>Bread turns messy threads into clean runbooks. <strong>Bold</strong> and <a href=\"/p/x/doc/y\">links</a> and <code>inline</code> text that goes on for a while to look like prose.</p>"
const small = `<h1>Title</h1>${para.repeat(8)}`
const medium = `<h1>Title</h1>${(para.repeat(4)+"<h2>Section</h2>"+code("ts",12)).repeat(5)}<table><tr><td>a</td><td>b</td></tr></table>`
const large = `<h1>Title</h1>${(para.repeat(6)+"<h2>Section</h2>"+code("ts",30)+code("bash",10)+code("json",25)).repeat(12)}`
for (const [name, doc] of [["small (prose only)", small],["medium (5 code blocks)", medium],["large (36 code blocks)", large]] as const) {
  renderPublicHtml(doc) // warm
  const runs = 15; const t = performance.now()
  for (let i=0;i<runs;i++) renderPublicHtml(doc)
  console.log(name.padEnd(26), `${(doc.length/1024).toFixed(0)} KB in`, `${((performance.now()-t)/runs).toFixed(1)} ms/render`)
}
