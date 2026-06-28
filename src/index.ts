import { Env, err } from "./responses";
import { handleUpload } from "./handlers/upload";
import { handleList } from "./handlers/list";
import { handleImage } from "./handlers/image";
import { handleDelete } from "./handlers/del";
import { handleShareCreate, handleSharedItem } from "./handlers/share";
import { galleryHTML } from "./gallery/page";
import { manifestJSON } from "./gallery/manifest";
import { swJS } from "./gallery/sw";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const m = request.method;

    if (pathname === "/" && m === "GET") {
      return new Response(galleryHTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (pathname === "/manifest.webmanifest" && m === "GET") {
      return new Response(manifestJSON, { headers: { "content-type": "application/manifest+json" } });
    }
    if (pathname === "/sw.js" && m === "GET") {
      return new Response(swJS, { headers: { "content-type": "text/javascript" } });
    }
    if (pathname === "/api/upload") {
      return m === "POST" ? handleUpload(request, env) : err(405, "method not allowed");
    }
    if (pathname === "/api/list") {
      return m === "GET" ? handleList(request, env) : err(405, "method not allowed");
    }
    if (pathname.startsWith("/i/")) {
      const id = decodeURIComponent(pathname.slice("/i/".length));
      return m === "GET" ? handleImage(request, env, id) : err(405, "method not allowed");
    }
    if (pathname.startsWith("/api/img/")) {
      const id = decodeURIComponent(pathname.slice("/api/img/".length));
      return m === "DELETE" ? handleDelete(request, env, id) : err(405, "method not allowed");
    }
    if (pathname.startsWith("/api/share/")) {
      const id = decodeURIComponent(pathname.slice("/api/share/".length));
      return m === "POST" ? handleShareCreate(request, env, id) : err(405, "method not allowed");
    }
    if (pathname.startsWith("/s/")) {
      const id = decodeURIComponent(pathname.slice("/s/".length));
      return m === "GET" ? handleSharedItem(request, env, id) : err(405, "method not allowed");
    }
    return err(404, "not found");
  },
} satisfies ExportedHandler<Env>;
