import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: false },
  // quickjs-emscripten ships WebAssembly and must not be bundled into the
  // serverless output; Next traces it as an external dependency instead.
  serverExternalPackages: ['quickjs-emscripten', 'mongodb'],
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
      },
    ];
  },
};

export default nextConfig;
