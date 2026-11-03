import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // UI review builds must not overwrite a running preview's .next directory.
  distDir: process.env.LIGHTCHOICE_UI_DIST_DIR || ".next",
  async redirects() {
    return [
      {
        source: "/cross-border",
        destination: "/market-analysis",
        permanent: false,
      },
      {
        source: "/viral",
        destination: "/source",
        permanent: false,
      },
      {
        source: "/sourcing",
        destination: "/source",
        permanent: false,
      },
      {
        source: "/opportunities",
        destination: "/source",
        permanent: false,
      },
      {
        source: "/market-scan",
        destination: "/market-analysis",
        permanent: false,
      },
      {
        source: "/market-opportunities",
        destination: "/market-analysis",
        permanent: false,
      },
      {
        source: "/tasks",
        destination: "/research",
        permanent: false,
      },
      {
        source: "/opportunity-candidates",
        destination: "/research",
        permanent: false,
      },
      {
        source: "/lark-management",
        destination: "/diagnostics",
        permanent: false,
      },
      {
        source: "/system-diagnostics",
        destination: "/diagnostics",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
