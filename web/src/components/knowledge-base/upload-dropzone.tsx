"use client";

import { useRef, useState } from "react";
import { UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";

const ACCEPTED = ".pdf,.docx,.txt,.md,.markdown";

export function UploadDropzone({ onFiles, uploading }: { onFiles: (files: File[]) => void; uploading: boolean }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        onFiles(Array.from(e.dataTransfer.files));
      }}
      onClick={() => inputRef.current?.click()}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition-colors",
        dragging ? "border-primary bg-accent" : "border-border hover:bg-muted",
      )}
    >
      <UploadCloud className="size-8 text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">
        {uploading ? "Uploading…" : "Click to upload or drag and drop"}
      </p>
      <p className="text-xs text-muted-foreground">PDF, DOCX, TXT, or Markdown — up to 25 MB</p>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPTED}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) onFiles(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
    </div>
  );
}
