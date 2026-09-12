import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SightLoop Visual Assistance",
    short_name: "SightLoop",
    description: "Proactive, goal-aware visual assistance with live camera guidance.",
    start_url: "/",
    display: "standalone",
    background_color: "#0b0f0d",
    theme_color: "#17271f",
    orientation: "portrait",
    icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
