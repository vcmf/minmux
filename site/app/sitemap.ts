import type { MetadataRoute } from "next"
import { SITE_URL } from "@/components/minmux/data"

export const dynamic = "force-static"

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/changelog`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${SITE_URL}/llms.txt`, changeFrequency: "weekly", priority: 0.5 },
  ]
}
