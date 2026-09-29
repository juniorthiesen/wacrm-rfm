import type { NextConfig } from "next";

/**
 * Baseline security headers applied to every response.
 */
const COMMON_SECURITY_HEADERS = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
] as const;

const nextConfig: NextConfig = {
  output: "standalone",

  async headers() {
    return [
      {
        source: "/_next/static/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
      {
        source: "/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
          },
          ...COMMON_SECURITY_HEADERS,
        ],
      },
      // Rotas administrativas e gerais do CRM bloqueiam iframe por completo (anti-clickjacking)
      {
        source: "/((?!troca).*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Content-Security-Policy-Report-Only",
            value: "frame-ancestors 'none'",
          },
        ],
      },
      // Rota pública de trocas (/troca) permite ser embedada no site da DLY Lingerie
      {
        source: "/troca",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'self' https://dly.com.br https://*.dly.com.br http://localhost:* https://*.vercel.app",
          },
        ],
      },
      {
        source: "/troca/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'self' https://dly.com.br https://*.dly.com.br http://localhost:* https://*.vercel.app",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
