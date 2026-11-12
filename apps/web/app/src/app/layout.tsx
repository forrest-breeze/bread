import type { Metadata } from "next";
import {
  Crimson_Text,
  Rethink_Sans,
  Roboto_Mono,
} from "next/font/google";
import "../index.css";
import "katex/dist/katex.min.css";
import { cn } from "@/lib/utils";

const crimsonText = Crimson_Text({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-serif",
  display: "swap",
});

const rethinkSans = Rethink_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const robotoMono = Roboto_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Bread - The AI Knowledge Base",
  description:
    "Bread turns messy Slack threads and terminal dumps into clean, permanent runbooks. It's an automated SRE on your shoulder.",
  robots: {
    index: false,
    follow: false,
    googleBot: {
      index: false,
      follow: false,
    },
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        crimsonText.variable,
        robotoMono.variable,
        rethinkSans.variable,
        "font-sans"
      )}
    >
      <body>
        {children}
      </body>
    </html>
  );
}
