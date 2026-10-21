import type { MetadataRoute } from "next"
import { SITE_URL } from "@/components/minmux/data"

export const dynamic = "force-static"

/** Everyone may crawl, AI answer engines included (the page is meant to be quoted). */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  }
}
