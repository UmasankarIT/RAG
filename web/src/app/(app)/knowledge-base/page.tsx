"use client";

import Link from "next/link";
import { Database } from "lucide-react";
import { useAppData } from "@/components/app-data-context";
import { CreateKbDialog } from "@/components/knowledge-base/create-kb-dialog";

export default function KnowledgeBaseListPage() {
  const { knowledgeBases } = useAppData();

  return (
    <div className="thin-scroll mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Knowledge bases</h1>
          <p className="text-sm text-muted-foreground">Upload documents here, then chat grounded in them.</p>
        </div>
        <CreateKbDialog />
      </div>

      {knowledgeBases.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No knowledge bases yet — create one to start uploading documents.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {knowledgeBases.map((kb) => (
            <Link
              key={kb.id}
              href={`/knowledge-base/${kb.id}`}
              className="rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted"
            >
              <div className="mb-2 flex items-center gap-2 text-foreground">
                <Database className="size-4 text-primary" />
                <span className="font-medium">{kb.name}</span>
              </div>
              {kb.description && <p className="line-clamp-2 text-sm text-muted-foreground">{kb.description}</p>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
