import type { Metadata } from "next"
import { GithubHostedDocsSyncGate } from "@/components/app/github-hosted-docs-sync-gate"
import { KnowledgeShell } from "@/components/app/knowledge-shell"
import { KnowledgeDocumentOutlet } from "@/components/app/knowledge-document-outlet"

export const metadata: Metadata = {
  title: { default: "Knowledge", template: "%s · Knowledge" },
}

export default function KnowledgeLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <GithubHostedDocsSyncGate>
      <KnowledgeShell>
        <KnowledgeDocumentOutlet>{children}</KnowledgeDocumentOutlet>
      </KnowledgeShell>
    </GithubHostedDocsSyncGate>
  )
}
