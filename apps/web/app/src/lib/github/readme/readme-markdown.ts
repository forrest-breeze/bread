/**
 * ReadMe-flavored Markdown/MDX -> the plain Markdown Bread stores.
 *
 * ReadMe pages may use MDX components (`<Callout>`, `<Image>`, `<Cards>`) and,
 * in older projects, "magic blocks" (`[block:image]{...}[/block]`). Bread's
 * editor works on CommonMark + GFM, so the common components are rewritten to
 * their Markdown equivalents and any other component tag is dropped while its
 * inner text is kept.
 *
 * This is one-way. A page that is never edited in Bread is never rewritten in
 * the repository, so its components survive untouched; a page edited in Bread
 * is written back as the plain Markdown shown in the editor.
 */

const CALLOUT_ICONS: Record<string, string> = {
  info: '📘',
  okay: '👍',
  success: '👍',
  warn: '🚧',
  warning: '🚧',
  error: '❗️',
  danger: '❗️',
}

function attribute(attributes: string, name: string): string | null {
  const pattern = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*"([^"]*)"\\s*\\}|\\{\\s*'([^']*)'\\s*\\})`,
  )
  const match = pattern.exec(attributes)
  if (!match) return null
  return (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim()
}

function dedent(value: string): string {
  const lines = value.replace(/^\n+|\s+$/g, '').split('\n')
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => /^[ \t]*/.exec(line)![0].length)
  const indent = indents.length > 0 ? Math.min(...indents) : 0
  return lines.map((line) => line.slice(indent)).join('\n')
}

function blockquote(icon: string, title: string, body: string): string {
  const head = [icon, title].filter(Boolean).join(' ')
  const bodyLines = body.trim() ? body.trim().split('\n') : []
  const lines = [
    ...(head ? [head] : []),
    ...(head && bodyLines.length > 0 ? [''] : []),
    ...bodyLines,
  ]
  return lines.map((line) => (line ? `> ${line}` : '>')).join('\n')
}

function calloutToMarkdown(attributes: string, inner: string): string {
  const theme = (attribute(attributes, 'theme') ?? '').toLowerCase()
  const icon = attribute(attributes, 'icon') ?? CALLOUT_ICONS[theme] ?? CALLOUT_ICONS.info!
  const content = dedent(inner)
  // The first line is the callout's title when it is a heading or all bold.
  const heading = /^#{1,6}\s+(.+)\n?/.exec(content)
  const bold = heading ? null : /^(\*\*[^\n]+\*\*)[ \t]*(?:\n|$)/.exec(content)
  const title = heading ? heading[1]!.trim() : bold ? bold[1]! : ''
  const body = content.slice((heading ?? bold)?.[0].length ?? 0)
  return `\n\n${blockquote(icon, title, body)}\n\n`
}

function markdownImage(source: string | null, alt: string | null): string {
  if (!source) return ''
  return `![${(alt ?? '').replace(/[[\]]/g, '')}](${source})`
}

function markdownLink(label: string | null, href: string | null): string {
  if (!href) return label ?? ''
  return `[${(label || href).replace(/[[\]]/g, '')}](${href})`
}

function magicTable(data: Record<string, unknown>): string {
  const cells = (typeof data.data === 'object' && data.data !== null ? data.data : {}) as Record<
    string,
    unknown
  >
  const columns = Number(data.cols) || 0
  const rows = Number(data.rows) || 0
  if (columns <= 0) return ''
  const cell = (key: string): string =>
    String(cells[key] ?? '')
      .replace(/\r?\n+/g, ' ')
      .replace(/\|/g, '\\|')
      .trim()
  const header = Array.from({ length: columns }, (_, column) => cell(`h-${column}`))
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ]
  for (let row = 0; row < rows; row++) {
    lines.push(
      `| ${Array.from({ length: columns }, (_, column) => cell(`${row}-${column}`)).join(' | ')} |`,
    )
  }
  return lines.join('\n')
}

function magicBlockToMarkdown(type: string, json: string): string {
  let data: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return ''
    data = parsed as Record<string, unknown>
  } catch {
    return ''
  }
  const string = (value: unknown): string => (typeof value === 'string' ? value : '')
  switch (type) {
    case 'image': {
      const images = Array.isArray(data.images) ? data.images : []
      return images
        .map((entry) => {
          const image = (entry as { image?: unknown; caption?: unknown }) ?? {}
          const source = Array.isArray(image.image) ? string(image.image[0]) : ''
          return markdownImage(source, string(image.caption))
        })
        .filter(Boolean)
        .join('\n\n')
    }
    case 'callout': {
      const icon = CALLOUT_ICONS[string(data.type).toLowerCase()] ?? CALLOUT_ICONS.info!
      return blockquote(icon, string(data.title), string(data.body))
    }
    case 'code': {
      const codes = Array.isArray(data.codes) ? data.codes : []
      return codes
        .map((entry) => {
          const code = entry as { code?: unknown; language?: unknown }
          return `\`\`\`${string(code.language)}\n${string(code.code).replace(/\s+$/, '')}\n\`\`\``
        })
        .join('\n\n')
    }
    case 'api-header':
      return string(data.title) ? `## ${string(data.title)}` : ''
    case 'html':
      return string(data.html)
    case 'embed':
      return markdownLink(string(data.title), string(data.url))
    case 'parameters':
      return magicTable(data)
    default:
      return ''
  }
}

function transformProse(value: string): string {
  let output = value

  output = output.replace(
    /\[block:([a-z-]+)\]\s*([\s\S]*?)\s*\[\/block\]/g,
    (_match, type: string, json: string) => `\n\n${magicBlockToMarkdown(type, json)}\n\n`,
  )
  output = output.replace(
    /<Callout\b([^>]*)>([\s\S]*?)<\/Callout>/g,
    (_match, attributes: string, inner: string) => calloutToMarkdown(attributes, inner),
  )
  output = output.replace(
    /<Image\b([^>]*?)\/?>(?:[\s\S]*?<\/Image>)?/g,
    (_match, attributes: string) =>
      markdownImage(attribute(attributes, 'src'), attribute(attributes, 'alt')),
  )
  output = output.replace(
    /<Embed\b([^>]*?)\/?>(?:\s*<\/Embed>)?/g,
    (_match, attributes: string) =>
      markdownLink(attribute(attributes, 'title'), attribute(attributes, 'url')),
  )
  output = output.replace(
    /<Card\b([^>]*)>([\s\S]*?)<\/Card>/g,
    (_match, attributes: string, inner: string) => {
      const title = attribute(attributes, 'title')
      const link = markdownLink(title, attribute(attributes, 'href'))
      const body = dedent(inner).replace(/\n+/g, ' ').trim()
      const head = link ? `**${link}**` : ''
      return `\n- ${[head, body].filter(Boolean).join(' — ')}\n`
    },
  )
  output = output.replace(
    /<Anchor\b([^>]*)>([\s\S]*?)<\/Anchor>/g,
    (_match, attributes: string, inner: string) =>
      markdownLink(inner.trim() || attribute(attributes, 'label'), attribute(attributes, 'href')),
  )
  // <Table> wraps a plain HTML table; <HTMLBlock> wraps raw HTML in a template
  // literal. Both become the HTML they contain.
  output = output.replace(/<Table\b[^>]*>/g, '<table>').replace(/<\/Table>/g, '</table>')
  output = output.replace(
    /<HTMLBlock>\s*\{\s*`([\s\S]*?)`\s*\}\s*<\/HTMLBlock>/g,
    (_match, html: string) => `\n\n${dedent(html)}\n\n`,
  )
  // The content of a tab or accordion is indented in the source; left as-is,
  // Markdown would read that indentation as a code block.
  for (let pass = 0; pass < 3; pass++) {
    output = output.replace(
      /<(Tab|Accordion)\b([^>]*)>((?:(?!<\1\b)[\s\S])*?)<\/\1>/g,
      (_match, _name: string, attributes: string, inner: string) => {
        const title = attribute(attributes, 'title')
        return `\n\n${title ? `**${title}**\n\n` : ''}${dedent(inner)}\n\n`
      },
    )
  }
  output = output.replace(
    /<Tabs\b[^>]*>([\s\S]*?)<\/Tabs>/g,
    (_match, inner: string) => `\n\n${dedent(inner)}\n\n`,
  )

  return output
}

/**
 * ReadMe's MDX components. Only these are removed: other capitalized
 * "tags" in prose are usually placeholders such as `<YOUR_API_KEY>` and must
 * be kept.
 */
const README_COMPONENTS = [
  'Accordion',
  'Anchor',
  'Callout',
  'Card',
  'Cards',
  'Column',
  'Columns',
  'Embed',
  'Glossary',
  'HTMLBlock',
  'Image',
  'Recipe',
  'Tab',
  'Tabs',
  'TutorialTile',
  'Variable',
]
const COMPONENT_TAG_PATTERN = new RegExp(
  `</?(?:${README_COMPONENTS.join('|')})(?:\\s[^<>]*)?/?>`,
  'g',
)

/** Drop remaining component tags, keeping inline code spans untouched. */
function stripComponentTags(line: string): string {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part) => (part.startsWith('`') ? part : part.replace(COMPONENT_TAG_PATTERN, '')))
    .join('')
}

export function readmeBodyToMarkdown(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const segments: Array<{ code: boolean; lines: string[] }> = []
  let fence: string | null = null
  for (const line of lines) {
    const marker = /^\s*(```+|~~~+)/.exec(line)?.[1] ?? null
    const current = segments.at(-1)
    if (fence) {
      current!.lines.push(line)
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (marker) {
      fence = marker
      segments.push({ code: true, lines: [line] })
      continue
    }
    if (current && !current.code) current.lines.push(line)
    else segments.push({ code: false, lines: [line] })
  }

  return segments
    .map((segment) => {
      if (segment.code) return segment.lines.join('\n')
      return transformProse(segment.lines.join('\n'))
        .split('\n')
        .filter((line) => !/^(?:import|export)\s/.test(line))
        .map(stripComponentTags)
        .join('\n')
    })
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
