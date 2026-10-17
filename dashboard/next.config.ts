import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The mock data is read from disk at request time; ship it with the server bundle.
  outputFileTracingIncludes: { "/**": ["./src/mock/**"] },
};

export default nextConfig;
