import type { MetadataRoute } from "next";
import { absoluteUrl } from "./site";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: absoluteUrl("/"), lastModified: new Date(), changeFrequency: "weekly", priority: 1 },
    { url: absoluteUrl("/blog"), lastModified: new Date(), changeFrequency: "weekly", priority: 0.8 },
    { url: absoluteUrl("/blog/show-hn-launch"), lastModified: "2026-02-21", changeFrequency: "monthly", priority: 0.7 },
    { url: absoluteUrl("/blog/introducing-remux"), lastModified: "2026-02-12", changeFrequency: "monthly", priority: 0.7 },
    { url: absoluteUrl("/docs/getting-started"), lastModified: new Date(), changeFrequency: "monthly", priority: 0.9 },
    { url: absoluteUrl("/docs/concepts"), lastModified: new Date(), changeFrequency: "monthly", priority: 0.8 },
    { url: absoluteUrl("/docs/configuration"), lastModified: new Date(), changeFrequency: "monthly", priority: 0.8 },
    { url: absoluteUrl("/docs/keyboard-shortcuts"), lastModified: new Date(), changeFrequency: "monthly", priority: 0.7 },
    { url: absoluteUrl("/docs/api"), lastModified: new Date(), changeFrequency: "monthly", priority: 0.8 },
    { url: absoluteUrl("/docs/notifications"), lastModified: new Date(), changeFrequency: "monthly", priority: 0.8 },
    { url: absoluteUrl("/docs/changelog"), lastModified: new Date(), changeFrequency: "weekly", priority: 0.5 },
    { url: absoluteUrl("/community"), lastModified: new Date(), changeFrequency: "monthly", priority: 0.5 },
  ];
}
