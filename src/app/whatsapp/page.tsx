import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import WhatsAppConnection from "./whatsapp-connection";

export default async function WhatsAppPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return <WhatsAppConnection />;
}
