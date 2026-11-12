import { DocumentEditor } from "@/components/app/document-editor"

export default async function DocumentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  // Keyed so switching documents always unmounts the previous editor, which
  // saves its pending edits on the way out.
  return <DocumentEditor key={id} documentId={id} />
}
