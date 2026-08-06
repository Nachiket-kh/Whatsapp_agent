import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import EvolutionConnection from "./evolution-connection";

export default async function EvolutionPage() {
  const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return <EvolutionConnection />;
}
