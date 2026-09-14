import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /gate is the whole point of the demo; there is no other page to land on.
  async redirects() {
    return [{ source: "/", destination: "/gate", permanent: false }];
  },
};

export default nextConfig;
