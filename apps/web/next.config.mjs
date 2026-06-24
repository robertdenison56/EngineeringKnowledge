/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@ekg/core', '@ekg/store-sqlite', '@ekg/ingestion'],
  // pdfjs-dist (the ingestion vector parser) ships prebuilt and pulls in heavy
  // worker code — keep it external so Next requires it at runtime instead of
  // bundling it into the upload Server Action. Mirrors the MCP gateway's
  // esbuild `--external:pdfjs-dist`.
  serverExternalPackages: ['pdfjs-dist'],
  experimental: {
    // In-app uploads (G1/G2) stream the file through a Server Action into the
    // existing buildCandidate pipeline; raise the 1 MB default so real drawing
    // PDFs go through. Server-side validation enforces the same 25 MB ceiling.
    serverActions: { bodySizeLimit: '25mb' },
  },
};

export default nextConfig;
