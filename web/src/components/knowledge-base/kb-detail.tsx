"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Trash2 } from "lucide-react";
import { useAppData } from "@/components/app-data-context";
import { Button } from "@/components/ui/button";
import type { DocumentSummary } from "@/components/knowledge-base/document-row";
import { DocumentRow } from "@/components/knowledge-base/document-row";
import { UploadDropzone } from "@/components/knowledge-base/upload-dropzone";

const POLL_MS = 3000;

export function KbDetail({ knowledgeBaseId }: { knowledgeBaseId: string }) {
  const router = useRouter();
  const { knowledgeBases, refreshKnowledgeBases } = useAppData();
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [uploading, setUploading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const kb = knowledgeBases.find((k) => k.id === knowledgeBaseId);

  const loadDocuments = useCallback(async () => {
    const res = await fetch(`/api/knowledge-bases/${knowledgeBaseId}/documents`);
    const data: { ok: boolean; data?: DocumentSummary[] } = await res.json();
    if (data.ok && data.data) setDocuments(data.data);
  }, [knowledgeBaseId]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  useEffect(() => {
    const hasProcessing = documents.some((d) => d.status === "processing");
    if (hasProcessing && !pollRef.current) {
      pollRef.current = setInterval(loadDocuments, POLL_MS);
    }
    if (!hasProcessing && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [documents, loadDocuments]);

  async function handleFiles(files: File[]) {
    setUploading(true);
    try {
      for (const file of files) {
        const form = new FormData();
        form.set("file", file);
        await fetch(`/api/knowledge-bases/${knowledgeBaseId}/documents`, { method: "POST", body: form });
      }
      await loadDocuments();
    } finally {
      setUploading(false);
    }
  }

  async function handleDeleteDocument(docId: string) {
    setDocuments((prev) => prev.filter((d) => d.id !== docId));
    await fetch(`/api/knowledge-bases/${knowledgeBaseId}/documents/${docId}`, { method: "DELETE" });
  }

  async function handleDeleteKb() {
    if (!confirm(`Delete "${kb?.name ?? "this knowledge base"}" and all its documents? This can't be undone.`)) return;
    await fetch(`/api/knowledge-bases/${knowledgeBaseId}`, { method: "DELETE" });
    await refreshKnowledgeBases();
    router.push("/knowledge-base");
  }

  return (
    <div className="thin-scroll mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-6">
      <button
        onClick={() => router.push("/knowledge-base")}
        className="mb-4 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> All knowledge bases
      </button>

      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{kb?.name ?? "Knowledge base"}</h1>
          {kb?.description && <p className="text-sm text-muted-foreground">{kb.description}</p>}
        </div>
        <Button variant="outline" size="sm" onClick={handleDeleteKb}>
          <Trash2 className="size-4" /> Delete
        </Button>
      </div>

      <UploadDropzone onFiles={handleFiles} uploading={uploading} />

      <div className="mt-6 space-y-2">
        {documents.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">No documents yet.</p>
        ) : (
          documents.map((doc) => <DocumentRow key={doc.id} doc={doc} onDelete={handleDeleteDocument} />)
        )}
      </div>
    </div>
  );
}
