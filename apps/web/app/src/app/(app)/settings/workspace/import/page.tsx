"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ImportDialog } from "@/components/settings/import-dialog";
import { useImportJobs, useWorkspace } from "@/hooks/swr";

// ---------------------------------------------------------------------------
// /settings/workspace/import — thin landing page that opens the unified
// <ImportDialog /> on mount and lists recent jobs. The actual import UI lives
// in the dialog (also reachable from Settings → Workspace → Data Management).
// ---------------------------------------------------------------------------

export default function WorkspaceImportPage(): React.JSX.Element {
  const router = useRouter();
  const { data: workspace } = useWorkspace();
  const role = workspace?.user_role ?? null;
  const isAdmin = role === "admin" || role === "owner";

  const [open, setOpen] = useState(true);
  const { data: jobsData } = useImportJobs();
  const jobs = jobsData?.jobs ?? [];

  // When the dialog closes without a redirect (Cancel), drop the user back
  // onto the workspace settings page rather than leaving them on an empty
  // landing route.
  useEffect(() => {
    if (!open) router.push("/settings/workspace");
  }, [open, router]);

  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div>
        <Link
          href="/settings/workspace"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Workspace
        </Link>
        <h1 className="mt-2 text-xl font-semibold">Import</h1>
      </div>

      {jobs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent jobs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {jobs.map((j) => (
                <button
                  key={j.id}
                  onClick={() =>
                    router.push(`/settings/workspace/import/${j.id}`)
                  }
                  className="block w-full rounded-md border border-border p-3 text-left transition hover:border-foreground"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium capitalize">{j.source}</span>
                      <Badge variant="outline">{j.status}</Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {new Date(j.created_at).toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {j.processed_items}/{j.total_items} processed — ✓
                    {j.succeeded_items} ✗{j.failed_items} ⊝{j.skipped_items}
                  </p>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <ImportDialog open={open} onOpenChange={setOpen} isAdmin={isAdmin} />
    </div>
  );
}
