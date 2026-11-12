import { describe, expect, it } from "vitest"
import { buildBreadGitHubDraft } from "./github-hosted-publish"

describe("buildBreadGitHubDraft", () => {
  it("preserves repository frontmatter while replacing the body from Bread", () => {
    expect(
      buildBreadGitHubDraft({
        repositoryContent: [
          "---",
          'title: "Old title"',
          "description: Keep this metadata",
          "---",
          "",
          'import Card from "@/components/Card"',
          "",
          "<Card>Old MDX body</Card>",
        ].join("\n"),
        breadTitle: "Bread title",
        breadMarkdown: "# Bread title\n\nAuthoritative body\n",
      }),
    ).toBe(
      [
        "---",
        'title: "Bread title"',
        "description: Keep this metadata",
        "---",
        "",
        "# Bread title",
        "",
        "Authoritative body",
        "",
      ].join("\n"),
    )
  })

  it("does not introduce frontmatter when the repository file has none", () => {
    expect(
      buildBreadGitHubDraft({
        repositoryContent: "# GitHub title\n\nOld body\n",
        breadTitle: "Bread title",
        breadMarkdown: "# Bread title\n\nNew body\n",
      }),
    ).toBe("# Bread title\n\nNew body\n")
  })

  it("adds the Bread title to existing frontmatter without a title", () => {
    expect(
      buildBreadGitHubDraft({
        repositoryContent: "---\ndescription: Existing\n---\n\nOld body\n",
        breadTitle: "A: safer title",
        breadMarkdown: "# A: safer title\n",
      }),
    ).toBe(
      '---\ndescription: Existing\ntitle: "A: safer title"\n---\n\n# A: safer title\n',
    )
  })
})
