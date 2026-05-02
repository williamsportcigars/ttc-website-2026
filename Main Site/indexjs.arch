export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const hostname = url.hostname;

    // 1. Handle Subdomains
    if (hostname === "harry.thetobaccocenter.com") {
      return env.ASSETS.fetch(new Request(new URL("/harry.html", url.origin)));
    }
    if (hostname === "ops.thetobaccocenter.com") {
      return env.ASSETS.fetch(new Request(new URL("/ops.html", url.origin)));
    }
    if (hostname === "humidor.thetobaccocenter.com") {
      return env.ASSETS.fetch(new Request(new URL("/my-humidor.html", url.origin)));
    }

    // 2. Handle Root Domain (thetobaccocenter.com)
    // If the path is just "/" or empty, serve index.html
    if (url.pathname === "/" || url.pathname === "") {
      return env.ASSETS.fetch(new Request(new URL("/index.html", url.origin)));
    }

    // 3. Fallback: Try to serve the asset directly (e.g., if someone types /index.js)
    return env.ASSETS.fetch(request);
  }
};
