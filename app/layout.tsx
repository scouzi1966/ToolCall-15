import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "ToolCall-15",
  description: "Visual tool-calling benchmark dashboard for comparing LLMs across 15 reproducible scenarios."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
