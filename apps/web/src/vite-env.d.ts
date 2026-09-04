/// <reference types="vite/client" />

declare module "virtual:eforest-roadmap" {
  const index: import("../eforest-content.plugin.js").RoadmapIndex;
  export default index;
}
