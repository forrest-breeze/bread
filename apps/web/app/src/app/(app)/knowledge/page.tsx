import type { Metadata } from "next"
import { FileDropZone } from "@/components/app/file-drop-zone"
import { KnowledgeHome } from "@/components/app/knowledge-home"

export const metadata: Metadata = { title: "Knowledge" }

export default function KnowledgePage() {
  return (
    <FileDropZone>
      <KnowledgeHome />
    </FileDropZone>
  )
}
