import type { Metadata } from "next";
import { SemanticClient } from "./client";

export const metadata: Metadata = { title: "语义层管理" };

export default function SemanticPage() {
  return <SemanticClient />;
}
