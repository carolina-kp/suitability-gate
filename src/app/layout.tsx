import type { Metadata } from "next";
import { Libre_Franklin, Source_Serif_4 } from "next/font/google";
import "./globals.css";

// Civic grotesque — the Franklin Gothic lineage of official forms. Carries the
// display verdict and every figure.
const franklin = Libre_Franklin({
  variable: "--font-franklin",
  subsets: ["latin"],
  weight: ["300", "400", "600", "800"],
});

// The reasoning voice: the verdict's justification, judge findings, caveats.
const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
  weight: ["400", "600"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "Suitability gate",
  description:
    "Ship verdict for a suitability intake agent, scored against twenty client personas.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${franklin.variable} ${sourceSerif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
