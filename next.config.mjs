/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  experimental: {
    // Next.js 16's proxy (used here for the optional dashboard password)
    // buffers the request body before forwarding it, capped at 10MB by
    // default -- silently truncating anything bigger with NO error back to
    // the client. Media uploads no longer pass through the proxy at all
    // (/api/upload is excluded from proxy.ts's matcher and streams straight
    // to disk), but the raised cap is kept as a belt-and-braces safety net
    // for any other route that might receive a sizeable body.
    proxyClientMaxBodySize: "2gb",
  },
}

export default nextConfig
