import type { Metadata } from "next"
import { WorkspacePublishChanges } from "@/components/app/workspace-publish-changes"

export const metadata: Metadata = { title: "Files changed" }

// A full page rather than a dialog: the review is a two-pane file list + diff,
// and a modal gave the diff column too little room for real document paths and
// frontmatter lines.
export default function WorkspaceChangesPage(): React.ReactElement {
  return <WorkspacePublishChanges />
}
