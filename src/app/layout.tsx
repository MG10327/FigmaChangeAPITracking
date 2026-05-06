import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Figma Change Tracker",
  description: "Monitors Figma files for changes and sends Slack alerts",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
