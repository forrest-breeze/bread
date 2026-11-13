import { describe, expect, it } from "vitest"
import { buildBreezifyGitHubDraft } from "./github-hosted-publish"

describe("buildBreezifyGitHubDraft", () => {
  it("preserves repository frontmatter while replacing the body from Breezify", () => {
    expect(
      buildBreezifyGitHubDraft({
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
        breezifyTitle: "Breezify title",
        breezifyMarkdown: "# Breezify title\n\nAuthoritative body\n",
      }),
    ).toBe(
      [
        "---",
        'title: "Breezify title"',
        "description: Keep this metadata",
        "---",
        "",
        "# Breezify title",
        "",
        "Authoritative body",
        "",
      ].join("\n"),
    )
  })

  it("does not introduce frontmatter when the repository file has none", () => {
    expect(
      buildBreezifyGitHubDraft({
        repositoryContent: "# GitHub title\n\nOld body\n",
        breezifyTitle: "Breezify title",
        breezifyMarkdown: "# Breezify title\n\nNew body\n",
      }),
    ).toBe("# Breezify title\n\nNew body\n")
  })

  it("adds the Breezify title to existing frontmatter without a title", () => {
    expect(
      buildBreezifyGitHubDraft({
        repositoryContent: "---\ndescription: Existing\n---\n\nOld body\n",
        breezifyTitle: "A: safer title",
        breezifyMarkdown: "# A: safer title\n",
      }),
    ).toBe(
      '---\ndescription: Existing\ntitle: "A: safer title"\n---\n\n# A: safer title\n',
    )
  })
})
