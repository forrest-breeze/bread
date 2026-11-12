import { describe, expect, it } from "vitest"
import { generateRequestSamples, parseCurl } from "./request-samples"

const BREEZE_GET = [
  "curl --request GET \\",
  "  --url 'https://api.breeze.cash/v1/balances/payin' \\",
  '  --user "${BREEZE_API_KEY}:"',
].join("\n")

const JSON_POST = [
  "curl -X POST https://api.example.com/v1/items \\",
  "  -H 'Content-Type: application/json' \\",
  "  -H \"Authorization: Bearer $TOKEN\" \\",
  `  -d '{"name":"Widget","active":true,"tags":null}'`,
].join("\n")

const sample = (curl: string, label: string): string =>
  generateRequestSamples(curl).find((entry) => entry.label === label)?.source ?? ""

describe("parseCurl", () => {
  it("reads method, url, auth, headers and body across line continuations", () => {
    expect(parseCurl(BREEZE_GET)).toEqual({
      method: "GET",
      url: "https://api.breeze.cash/v1/balances/payin",
      headers: [],
      basicAuth: "${BREEZE_API_KEY}:",
      body: null,
    })
    expect(parseCurl(JSON_POST)).toMatchObject({
      method: "POST",
      url: "https://api.example.com/v1/items",
      headers: [["Content-Type", "application/json"], ["Authorization", "Bearer $TOKEN"]],
      body: { text: '{"name":"Widget","active":true,"tags":null}' },
    })
    expect(parseCurl("curl --data @payload.json https://x.test")).toMatchObject({
      method: "POST",
      body: { file: "payload.json" },
    })
  })

  it("refuses commands it can't translate faithfully", () => {
    expect(parseCurl("wget https://x.test")).toBeNull()
    expect(parseCurl("curl --form a=b https://x.test")).toBeNull()
    expect(parseCurl("curl 'https://x.test")).toBeNull()
  })
})

describe("generateRequestSamples", () => {
  it("offers Breeze's languages in its picker order", () => {
    expect(generateRequestSamples(BREEZE_GET).map((entry) => entry.label)).toEqual([
      "Node",
      "Ruby",
      "PHP",
      "Python",
    ])
  })

  it("turns basic auth with env vars into each language's idiom", () => {
    expect(sample(BREEZE_GET, "Node")).toContain(
      "Authorization: 'Basic ' + Buffer.from(`${process.env.BREEZE_API_KEY}:`).toString('base64'),",
    )
    expect(sample(BREEZE_GET, "Python")).toContain(`auth=(os.environ['BREEZE_API_KEY'], "")`)
    expect(sample(BREEZE_GET, "Python")).toContain("import os")
    expect(sample(BREEZE_GET, "Ruby")).toContain("request = Net::HTTP::Get.new(url)")
    expect(sample(BREEZE_GET, "Ruby")).toContain(`request.basic_auth(ENV['BREEZE_API_KEY'], '')`)
    expect(sample(BREEZE_GET, "PHP")).toContain("CURLOPT_USERPWD => getenv('BREEZE_API_KEY') . ':',")
  })

  it("re-emits JSON bodies natively", () => {
    expect(sample(JSON_POST, "Node")).toContain('body: JSON.stringify({\n    "name": "Widget",')
    expect(sample(JSON_POST, "Node")).toContain("'Authorization': `Bearer ${process.env.TOKEN}`,")
    expect(sample(JSON_POST, "Python")).toContain('"active": True,')
    expect(sample(JSON_POST, "Python")).toContain('"tags": None,')
    expect(sample(JSON_POST, "Python")).toContain('response = requests.request("POST", url, headers=headers, data=data)')
    expect(sample(JSON_POST, "Ruby")).toContain("request.body = <<~'JSON'")
    expect(sample(JSON_POST, "PHP")).toContain("'Authorization: Bearer ' . getenv('TOKEN'),")
  })

  it("reads @file bodies from disk", () => {
    const curl = "curl --request POST --url https://x.test/a --header 'Content-Type: application/json' --data @payload.json"
    expect(sample(curl, "Node")).toContain("body: await readFile('payload.json', 'utf8'),")
    expect(sample(curl, "Python")).toContain('with open("payload.json", "rb") as payload:')
    expect(sample(curl, "Ruby")).toContain("request.body = File.read('payload.json')")
    expect(sample(curl, "PHP")).toContain("CURLOPT_POSTFIELDS => file_get_contents('payload.json'),")
  })
})
