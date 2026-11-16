import { redirect } from "next/navigation";
import { hasDashboardSession } from "@/lib/app-auth";
import WhatsAppConnection from "./whatsapp-connection";

export default async function WhatsAppPage() {
  if (!await hasDashboardSession()) redirect("/login");
  return <WhatsAppConnection />;
}
