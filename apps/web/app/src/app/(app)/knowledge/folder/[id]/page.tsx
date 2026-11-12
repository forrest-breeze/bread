import { redirect } from "next/navigation"

// Old folder bookmarks return to the document library; folders are organization only.
export default function FolderPage(): never {
  redirect("/knowledge")
}
