import { ChatShell } from "@/components/chat/chat-shell";

export default async function ChatSessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return <ChatShell key={sessionId} sessionId={sessionId} />;
}
