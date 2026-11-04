// hls.js ships the light build (no subtitles, alternate audio or DRM) without its own typings.
declare module "hls.js/light" {
  export { default } from "hls.js";
  export * from "hls.js";
}
