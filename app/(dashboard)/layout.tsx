import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

export default function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="min-h-screen" style={{ background: "var(--paper)" }}>
      <Sidebar />
      <div className="ml-[238px] flex min-h-screen flex-col transition-all duration-300">
        <Topbar />
        <main className="flex-1 px-6 py-6" style={{ padding: "clamp(24px, 3vw, 48px)" }}>
          {children}
        </main>
      </div>
    </div>
  );
}
