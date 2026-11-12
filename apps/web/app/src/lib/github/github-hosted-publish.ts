interface BreadGitHubDraftInput {
  repositoryContent: string
  breadTitle: string
  breadMarkdown: string
}

interface RepositoryContentParts {
  frontmatter: string
  body: string
}

function splitFrontmatter(content: string): RepositoryContentParts {
  const normalized = content.replace(/\r\n?/g, "\n")
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: "", body: normalized }
  }

  const closing = normalized.indexOf("\n---", 4)
  if (closing === -1) return { frontmatter: "", body: normalized }

  const boundaryEnd = normalized.indexOf("\n", closing + 4)
  if (boundaryEnd === -1) {
    return { frontmatter: normalized.trimEnd(), body: "" }
  }

  return {
    frontmatter: normalized.slice(0, boundaryEnd).trimEnd(),
    body: normalized.slice(boundaryEnd + 1).replace(/^\n+/, ""),
  }
}

function updateFrontmatterTitle(frontmatter: string, title: string): string {
  if (!frontmatter) return ""

  const titleLine = `title: ${JSON.stringify(title.trim() || "Untitled")}`
  if (/^title\s*:/m.test(frontmatter)) {
    return frontmatter.replace(/^title\s*:.*$/m, titleLine)
  }

  const closing = frontmatter.lastIndexOf("\n---")
  if (closing === -1) return frontmatter
  return `${frontmatter.slice(0, closing)}\n${titleLine}${frontmatter.slice(closing)}`
}

/**
 * Builds the complete repository draft used by an explicit Bread -> GitHub
 * update. Repository frontmatter stays intact (with Bread's title applied),
 * while the proposed file body comes from Bread's Markdown export.
 */
export function buildBreadGitHubDraft({
  repositoryContent,
  breadTitle,
  breadMarkdown,
}: BreadGitHubDraftInput): string {
  const { frontmatter } = splitFrontmatter(repositoryContent)
  const nextFrontmatter = updateFrontmatterTitle(frontmatter, breadTitle)
  const nextBody = breadMarkdown.trim()

  if (!nextFrontmatter) return nextBody ? `${nextBody}\n` : ""
  return nextBody
    ? `${nextFrontmatter}\n\n${nextBody}\n`
    : `${nextFrontmatter}\n`
}
