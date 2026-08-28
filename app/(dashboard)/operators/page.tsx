import type { Metadata } from "next";
import { OperatorsClient } from "./client";

export const metadata: Metadata = { title: "算子中心" };

export default function OperatorsPage() {
  return <OperatorsClient />;
}
