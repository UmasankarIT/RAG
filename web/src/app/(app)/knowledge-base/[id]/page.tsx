import { KbDetail } from "@/components/knowledge-base/kb-detail";

export default async function KnowledgeBaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <KbDetail knowledgeBaseId={id} />;
}
