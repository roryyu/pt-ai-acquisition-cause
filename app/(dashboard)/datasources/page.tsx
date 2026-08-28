import type { Metadata } from "next";
import { DataSourcesClient } from "./client";

export const metadata: Metadata = { title: "数据源管理" };

export default function DataSourcesPage() {
  return <DataSourcesClient />;
}
