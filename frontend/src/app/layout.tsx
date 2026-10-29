import type { Metadata } from "next";
// Self-hosted Inter and EB Garamond; sets --font-inter and --font-eb-garamond.
import "./fonts/fonts.css";
import "./globals.css";
import { Providers } from "@/app/components/providers";

export const metadata: Metadata = {
    metadataBase: new URL("https://app.mikeoss.com"),
    title: "MikeGC - Legal AI for In-house Teams",
    description:
        "AI-powered document review, drafting, and contract playbooks for in-house legal teams.",
    icons: {
        icon: [
            { url: "/icon.svg", type: "image/svg+xml" },
            { url: "/favicon.ico" },
        ],
        apple: "/apple-touch-icon.png",
    },
    openGraph: {
        type: "website",
        url: "https://app.mikeoss.com",
        siteName: "MikeGC",
        title: "MikeGC - Legal AI for In-house Teams",
        description:
            "AI-powered document review, drafting, and contract playbooks for in-house legal teams.",
        images: [
            {
                url: "/link-image.jpg",
                width: 1200,
                height: 651,
                alt: "MikeGC",
            },
        ],
    },
    twitter: {
        card: "summary_large_image",
        title: "MikeGC - Legal AI for In-house Teams",
        description:
            "AI-powered document review, drafting, and contract playbooks for in-house legal teams.",
        images: ["/link-image.jpg"],
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body
                className="font-sans antialiased"
            >
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
