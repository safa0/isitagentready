import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Is It Agent-Ready?",
  description:
    "Scan any website against 19 agent-readiness checks across robots.txt, Markdown negotiation, MCP, OAuth, Agent Skills, and agentic commerce standards.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "Is It Agent-Ready?",
    description:
      "Scan any website against 19 agent-readiness checks across robots.txt, Markdown negotiation, MCP, OAuth, Agent Skills, and agentic commerce standards.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Is It Agent-Ready?",
    description:
      "Scan any website for agent readiness across emerging web standards.",
  },
};

// Build-time string literal: applies the user's saved theme before first paint
// so returning users don't see a light→dark flash.
const THEME_BOOTSTRAP = `try{var s=localStorage.getItem("theme");var p=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;if(s==="dark"||((s===null||s==="system")&&p))document.documentElement.classList.add("dark");}catch(_){}`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <Script id="theme-bootstrap" strategy="beforeInteractive">
          {THEME_BOOTSTRAP}
        </Script>
        {children}
      </body>
    </html>
  );
}
