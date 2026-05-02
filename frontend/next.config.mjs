import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // We're inside an npm-workspaces monorepo; pin the file-tracing root so Next
  // doesn't warn about multiple lockfiles when judges install at the root.
  outputFileTracingRoot: path.resolve(here, ".."),
  // Backend address used by server-side fetches in route handlers.
  // Browser-side fetches use NEXT_PUBLIC_BACKEND_URL.
  env: {
    BACKEND_URL: process.env.BACKEND_URL ?? "http://localhost:8787",
  },
};

export default nextConfig;
