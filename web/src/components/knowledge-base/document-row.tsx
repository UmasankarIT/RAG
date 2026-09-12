"use client";

import { FileText, Loader2, Trash2, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DocumentSummary {
  id: string;
  fileName: string;
  fileType: string;
  status: "processing" | "ready" | "failed";
  errorMessage: string | null;
  createdAt: string;
}

export function DocumentRow({ doc, onDelete }: { doc: DocumentSummary; onDelete: (id: string) => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">{doc.fileName}</p>
        {doc.status === "failed" && doc.errorMessage && (
          <p className="truncate text-xs text-destructive">{doc.errorMessage}</p>
        )}
      </div>
      <StatusBadge status={doc.status} />
      <button
        onClick={() => onDelete(doc.id)}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive"
        aria-label={`Delete ${doc.fileName}`}
      >
        <Trash2 className="size-4" />
      </button>
    </div>
  );
}

function StatusBadge({ status }: { status: DocumentSummary["status"] }) {
  if (status === "processing") {
    return (
      <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> Processing
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
        <TriangleAlert className="size-3" /> Failed
      </span>
    );
  }
  return (
    <span className={cn("rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary")}>Ready</span>
  );
}
