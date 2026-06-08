/** @type {import('next').NextConfig} */
const nextConfig = {
  // ============================================================
  // Tab images are served from library/ via the /api/img route,
  // bypassing next/image optimization
  // ============================================================
  images: { unoptimized: true },
}

export default nextConfig
