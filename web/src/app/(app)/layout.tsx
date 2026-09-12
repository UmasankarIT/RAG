import { AppDataProvider } from "@/components/app-data-context";
import { Sidebar } from "@/components/sidebar/sidebar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppDataProvider>
      <div className="flex h-dvh overflow-hidden bg-background">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>
    </AppDataProvider>
  );
}
