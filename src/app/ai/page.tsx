import { redirect } from "next/navigation";
import { hasDashboardSession } from "@/lib/app-auth";
import AiSettings from "./settings";

export default async function AiPage() {
  if (!await hasDashboardSession()) redirect("/login");
  return <AiSettings />;
}
