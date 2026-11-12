export default function PublicKbNotFound(): React.ReactElement {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-center text-foreground">
      <p className="text-base font-medium">Knowledge base not found</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        This knowledge base doesn&apos;t exist or you don&apos;t have access.
      </p>
    </div>
  )
}
