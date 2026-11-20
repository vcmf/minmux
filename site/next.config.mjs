/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export so the site can be hosted anywhere (GitHub Pages, Vercel, S3, ...).
  output: "export",
  images: { unoptimized: true },
  // site/ has its own lockfile inside the app repo; without this Next picks the repo root
  outputFileTracingRoot: import.meta.dirname,
}

export default nextConfig
