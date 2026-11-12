// Generate equivalent request samples (Node, Ruby, PHP, Python) from an
// authored cURL command, so an API reference only has to document the request
// once. The language set mirrors what Breeze's own reference offers; widen it by
// adding a generator to REQUEST_SAMPLE_LANGUAGES.
//
// Shell-style `${VAR}` / `$VAR` references inside double-quoted cURL arguments
// become environment-variable reads in every target language, so a sample like
// `--user "${API_KEY}:"` stays copy-pasteable without leaking a literal key.

export interface ParsedCurl {
  method: string
  url: string
  headers: Array<[string, string]>
  /** `user:password` from `--user`/`-u`. */
  basicAuth: string | null
  /** Inline body, or `{ file }` for `--data @file`. */
  body: { text: string } | { file: string } | null
}

/** One piece of a string value: literal text or an environment variable. */
type Part = { text: string } | { env: string }

function pushText(parts: Part[], text: string): void {
  if (!text) return
  const last = parts.at(-1)
  if (last && "text" in last) last.text += text
  else parts.push({ text })
}

/**
 * Split a shell command into words, honouring quotes, backslash escapes and
 * `\`-newline continuations. `$VAR` text is kept verbatim (see `partsOf`).
 */
function tokenize(command: string): string[] | null {
  const words: string[] = []
  let current: string | null = null
  let quote: "'" | '"' | null = null

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (quote === "'") {
      if (char === "'") quote = null
      else current += char
      continue
    }
    if (char === "\\") {
      const next = command[index + 1]
      if (next === "\n") index++
      else if (next === "\r" && command[index + 2] === "\n") index += 2
      else if (next !== undefined) {
        current = (current ?? "") + next
        index++
      }
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = null
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      current ??= ""
      quote = char
    } else if (/\s/.test(char)) {
      if (current !== null) words.push(current)
      current = null
    } else current = (current ?? "") + char
  }
  if (quote) return null
  if (current !== null) words.push(current)
  return words
}

const DATA_FLAGS = new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-ascii"])

/** Parse the subset of cURL used in API docs. Returns null for anything else. */
export function parseCurl(command: string): ParsedCurl | null {
  const words = tokenize(command.trim())
  if (!words || words[0] !== "curl") return null

  let method: string | null = null
  let url: string | null = null
  const headers: Array<[string, string]> = []
  let basicAuth: string | null = null
  let body: ParsedCurl["body"] = null

  for (let index = 1; index < words.length; index++) {
    const word = words[index]!
    const takeValue = (): string | null => words[++index] ?? null
    if (word === "-X" || word === "--request") method = takeValue()
    else if (word === "--url") url = takeValue()
    else if (word === "-H" || word === "--header") {
      const header = takeValue()
      const colon = header?.indexOf(":") ?? -1
      if (!header || colon <= 0) return null
      headers.push([header.slice(0, colon).trim(), header.slice(colon + 1).trim()])
    } else if (word === "-u" || word === "--user") basicAuth = takeValue()
    else if (DATA_FLAGS.has(word)) {
      const data = takeValue()
      if (data === null) return null
      body =
        data.startsWith("@") && word !== "--data-raw"
          ? { file: data.slice(1) }
          : { text: data }
    } else if (["-s", "--silent", "-S", "--show-error", "-L", "--location", "-i", "--include", "-v", "--verbose", "--compressed", "-g", "--globoff"].includes(word)) {
      continue
    } else if (word.startsWith("-")) return null // Unsupported flag: don't guess.
    else if (!url) url = word
    else return null
  }
  if (!url) return null
  return {
    method: (method ?? (body ? "POST" : "GET")).toUpperCase(),
    url,
    headers,
    basicAuth,
    body,
  }
}

// ---------------------------------------------------------------------------
// String rendering per language. Values carry `${VAR}` references, so each
// generator needs a way to splice env reads into a string literal.
// ---------------------------------------------------------------------------

/** Re-split a raw cURL value into literal/env parts. */
function partsOf(value: string): Part[] {
  const parts: Part[] = []
  let rest = value
  const re = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/
  for (let match = re.exec(rest); match; match = re.exec(rest)) {
    pushText(parts, rest.slice(0, match.index))
    parts.push({ env: match[1] ?? match[2]! })
    rest = rest.slice(match.index + match[0].length)
  }
  pushText(parts, rest)
  return parts
}

function envNames(parsed: ParsedCurl): boolean {
  const values = [
    parsed.url,
    parsed.basicAuth ?? "",
    ...parsed.headers.map(([, value]) => value),
    parsed.body && "text" in parsed.body ? parsed.body.text : "",
  ]
  return values.some((value) => partsOf(value).some((part) => "env" in part))
}

const singleQuoted = (text: string): string =>
  `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

/** The variable name when a value is exactly one env reference. */
function soleEnv(parts: Part[]): string | null {
  const [only] = parts
  return parts.length === 1 && only && "env" in only ? only.env : null
}

function jsString(value: string): string {
  const parts = partsOf(value)
  const env = soleEnv(parts)
  if (env) return `process.env.${env}`
  if (parts.every((part) => "text" in part)) return singleQuoted(value)
  return (
    "`" +
    parts
      .map((part) =>
        "env" in part
          ? `\${process.env.${part.env}}`
          : part.text.replace(/[\\`]/g, "\\$&").replace(/\$\{/g, "\\${"),
      )
      .join("") +
    "`"
  )
}

function pyString(value: string): string {
  const parts = partsOf(value)
  const env = soleEnv(parts)
  if (env) return `os.environ['${env}']`
  if (parts.every((part) => "text" in part)) return JSON.stringify(value)
  return (
    'f"' +
    parts
      .map((part) =>
        "env" in part
          ? `{os.environ['${part.env}']}`
          : JSON.stringify(part.text).slice(1, -1).replace(/[{}]/g, "$&$&"),
      )
      .join("") +
    '"'
  )
}

function rbString(value: string): string {
  const parts = partsOf(value)
  const env = soleEnv(parts)
  if (env) return `ENV['${env}']`
  if (parts.every((part) => "text" in part)) return singleQuoted(value)
  return (
    '"' +
    parts
      .map((part) =>
        "env" in part
          ? `#{ENV['${part.env}']}`
          : part.text.replace(/[\\"]/g, "\\$&").replace(/#\{/g, "\\#{"),
      )
      .join("") +
    '"'
  )
}

function phpString(value: string): string {
  return partsOf(value)
    .map((part) => ("env" in part ? `getenv('${part.env}')` : singleQuoted(part.text)))
    .join(" . ") || "''"
}

/** Split `user:password` basic auth into its two halves (password may be empty). */
function splitAuth(auth: string): [string, string] {
  const colon = auth.indexOf(":")
  return colon < 0 ? [auth, ""] : [auth.slice(0, colon), auth.slice(colon + 1)]
}

/** Inline bodies that are valid JSON are re-emitted as native structures. */
function jsonBody(parsed: ParsedCurl): unknown {
  if (!parsed.body || !("text" in parsed.body)) return undefined
  if (partsOf(parsed.body.text).some((part) => "env" in part)) return undefined
  try {
    return JSON.parse(parsed.body.text)
  } catch {
    return undefined
  }
}

function indent(text: string, prefix: string): string {
  return text.split("\n").map((line, index) => (index === 0 ? line : prefix + line)).join("\n")
}

function toNode(parsed: ParsedCurl): string {
  const lines: string[] = []
  const usesFile = parsed.body && "file" in parsed.body
  if (usesFile) lines.push("import { readFile } from 'node:fs/promises';", "")
  lines.push(`const url = ${jsString(parsed.url)};`)
  const headerLines = parsed.headers.map(([name, value]) => `    ${singleQuoted(name)}: ${jsString(value)},`)
  if (parsed.basicAuth !== null) {
    headerLines.unshift(
      `    Authorization: 'Basic ' + Buffer.from(${jsString(parsed.basicAuth)}).toString('base64'),`,
    )
  }
  const json = jsonBody(parsed)
  const options = [`  method: '${parsed.method}',`]
  if (headerLines.length) options.push("  headers: {", ...headerLines, "  },")
  if (parsed.body) {
    options.push(
      "file" in parsed.body
        ? `  body: await readFile(${singleQuoted(parsed.body.file)}, 'utf8'),`
        : json !== undefined
          ? `  body: JSON.stringify(${indent(JSON.stringify(json, null, 2), "  ")}),`
          : `  body: ${jsString(parsed.body.text)},`,
    )
  }
  lines.push(
    "const options = {",
    ...options,
    "};",
    "",
    "const response = await fetch(url, options);",
    "const data = await response.json();",
    "console.log(data);",
  )
  return lines.join("\n")
}

function toPython(parsed: ParsedCurl): string {
  const lines: string[] = []
  if (jsonBody(parsed) !== undefined) lines.push("import json")
  if (envNames(parsed)) lines.push("import os")
  lines.push("import requests", "", `url = ${pyString(parsed.url)}`)
  const args = ["url"]
  if (parsed.headers.length) {
    lines.push(
      "headers = {",
      ...parsed.headers.map(([name, value]) => `    ${JSON.stringify(name)}: ${pyString(value)},`),
      "}",
    )
    args.push("headers=headers")
  }
  if (parsed.basicAuth !== null) {
    const [user, password] = splitAuth(parsed.basicAuth)
    args.push(`auth=(${pyString(user)}, ${pyString(password)})`)
  }
  if (parsed.body) {
    if ("file" in parsed.body) {
      lines.push(`with open(${JSON.stringify(parsed.body.file)}, "rb") as payload:`, "    data = payload.read()")
    } else {
      const json = jsonBody(parsed)
      lines.push(
        json !== undefined
          ? `data = json.dumps(${pythonLiteral(json)})`
          : `data = ${pyString(parsed.body.text)}`,
      )
    }
    args.push("data=data")
  }
  lines.push(
    "",
    `response = requests.request(${JSON.stringify(parsed.method)}, ${args.join(", ")})`,
    "",
    "print(response.json())",
  )
  return lines.join("\n")
}

/** JSON → Python literal (True/False/None) with 4-space indentation. */
function pythonLiteral(value: unknown, depth = 0): string {
  const pad = "    ".repeat(depth + 1)
  const close = "    ".repeat(depth)
  if (value === null) return "None"
  if (value === true) return "True"
  if (value === false) return "False"
  if (Array.isArray(value)) {
    if (!value.length) return "[]"
    return `[\n${value.map((item) => pad + pythonLiteral(item, depth + 1)).join(",\n")},\n${close}]`
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    if (!entries.length) return "{}"
    return `{\n${entries.map(([key, item]) => `${pad}${JSON.stringify(key)}: ${pythonLiteral(item, depth + 1)}`).join(",\n")},\n${close}}`
  }
  return JSON.stringify(value)
}

const RUBY_CLASSES: Record<string, string> = {
  GET: "Get",
  POST: "Post",
  PUT: "Put",
  PATCH: "Patch",
  DELETE: "Delete",
  HEAD: "Head",
  OPTIONS: "Options",
}

function toRuby(parsed: ParsedCurl): string {
  const requestClass = RUBY_CLASSES[parsed.method] ?? "Get"
  const lines = ["require 'uri'", "require 'net/http'"]
  lines.push(
    "",
    `url = URI(${rbString(parsed.url)})`,
    "",
    "http = Net::HTTP.new(url.host, url.port)",
    "http.use_ssl = url.scheme == 'https'",
    "",
    `request = Net::HTTP::${requestClass}.new(url)`,
  )
  if (parsed.basicAuth !== null) {
    const [user, password] = splitAuth(parsed.basicAuth)
    lines.push(`request.basic_auth(${rbString(user)}, ${rbString(password)})`)
  }
  for (const [name, value] of parsed.headers) lines.push(`request[${singleQuoted(name)}] = ${rbString(value)}`)
  if (parsed.body) {
    const json = jsonBody(parsed)
    if ("file" in parsed.body) lines.push(`request.body = File.read(${singleQuoted(parsed.body.file)})`)
    else if (json !== undefined) {
      lines.push("request.body = <<~'JSON'", ...JSON.stringify(json, null, 2).split("\n").map((line) => `  ${line}`), "JSON")
    } else lines.push(`request.body = ${rbString(parsed.body.text)}`)
  }
  lines.push("", "response = http.request(request)", "puts response.read_body")
  return lines.join("\n")
}

function toPhp(parsed: ParsedCurl): string {
  const options = [
    `  CURLOPT_URL => ${phpString(parsed.url)},`,
    "  CURLOPT_RETURNTRANSFER => true,",
    `  CURLOPT_CUSTOMREQUEST => '${parsed.method}',`,
  ]
  if (parsed.basicAuth !== null) {
    options.push(`  CURLOPT_USERPWD => ${phpString(parsed.basicAuth)},`)
  }
  if (parsed.body) {
    options.push(
      "file" in parsed.body
        ? `  CURLOPT_POSTFIELDS => file_get_contents(${singleQuoted(parsed.body.file)}),`
        : `  CURLOPT_POSTFIELDS => ${phpString(parsed.body.text)},`,
    )
  }
  if (parsed.headers.length) {
    options.push(
      "  CURLOPT_HTTPHEADER => [",
      ...parsed.headers.map(([name, value]) => `    ${phpString(`${name}: ${value}`)},`),
      "  ],",
    )
  }
  return [
    "<?php",
    "",
    "$curl = curl_init();",
    "",
    "curl_setopt_array($curl, [",
    ...options,
    "]);",
    "",
    "$response = curl_exec($curl);",
    "$error = curl_error($curl);",
    "curl_close($curl);",
    "",
    "echo $error ? 'cURL error: ' . $error : $response;",
  ].join("\n")
}

export interface RequestSample {
  /** Label in the language picker. */
  label: string
  /** Shiki grammar used to highlight the sample. */
  lang: string
  source: string
}

/** Order matches Breeze's reference picker: Shell, Node, Ruby, PHP, Python. */
const REQUEST_SAMPLE_LANGUAGES: Array<{
  label: string
  lang: string
  generate: (parsed: ParsedCurl) => string
}> = [
  { label: "Node", lang: "javascript", generate: toNode },
  { label: "Ruby", lang: "ruby", generate: toRuby },
  { label: "PHP", lang: "php", generate: toPhp },
  { label: "Python", lang: "python", generate: toPython },
]

/**
 * The equivalent samples for a cURL command (excluding the cURL itself), or an
 * empty list when the command uses features this generator can't translate
 * faithfully — better no sample than a wrong one.
 */
export function generateRequestSamples(curl: string): RequestSample[] {
  const parsed = parseCurl(curl)
  if (!parsed) return []
  return REQUEST_SAMPLE_LANGUAGES.map(({ label, lang, generate }) => ({
    label,
    lang,
    source: generate(parsed),
  }))
}
