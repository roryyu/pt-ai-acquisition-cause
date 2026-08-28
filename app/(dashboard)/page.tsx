import type { Metadata } from "next";
import { WorkspaceClient } from "./client";

export const metadata: Metadata = { title: "工作台" };

export default function WorkspacePage() {
  return <WorkspaceClient />;
}
