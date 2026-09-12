import type { Metadata } from "next";
import { AuthContextProvider } from "@/src/auth/AuthContext";
import { GuidedNavProvider } from "@/src/a11y/GuidedNavContext";
import { GuidedNavControls, GuidedNavTopBar } from "@/components/a11y/GuidedNavBars";
import "./globals.css";

export const metadata: Metadata = {
  title: "SightLoop · Visual assistance that stays with the task",
  description:
    "A proactive visual agent for blind and low-vision people, built around live goals, short-term memory, and concise guidance.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "SightLoop",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <AuthContextProvider>
          <GuidedNavProvider>
            <GuidedNavTopBar />
            {children}
            <GuidedNavControls />
          </GuidedNavProvider>
        </AuthContextProvider>
      </body>
    </html>
  );
}
