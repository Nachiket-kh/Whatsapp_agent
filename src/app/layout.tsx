import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CreatorOS CareFlow | WhatsApp AI Agent",
  description: "WhatsApp and voice AI appointment automation for hospitals",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
