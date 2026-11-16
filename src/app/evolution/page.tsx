import { redirect } from "next/navigation";
import { hasDashboardSession } from "@/lib/app-auth";
import EvolutionConnection from "./evolution-connection";

export default async function EvolutionPage() {
  if (!await hasDashboardSession()) redirect("/login");
  return <EvolutionConnection />;
}
