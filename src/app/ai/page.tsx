import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AiSettings from "./settings";

export default async function AiPage() {
  const auth = await createClient(); const { data: { user } } = await auth.auth.getUser();
  if (!user) redirect("/login");
  return <AiSettings />;
}
