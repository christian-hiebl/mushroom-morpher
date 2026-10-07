import { defineConfig, type Plugin } from 'vite';

/**
 * The app loads its own script and data, and photos from Wikimedia. Nothing
 * else. Locking that down means a hostile value in the species data — which is
 * derived from Wikipedia, so anyone can edit it — cannot reach an external
 * endpoint even if it got past the build's filtering and the runtime guard.
 *
 * 'unsafe-inline' is required for style only: the stylesheet is inline in
 * index.html. Scripts are bundled to a file, so they need no such exemption.
 *
 * Injected at build time rather than written into index.html, because
 * script-src 'self' blocks Vite's dev-server client and HMR websocket.
 * GitHub Pages cannot set response headers, so a meta tag is the only option.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://upload.wikimedia.org https://thumb.wikimedia.org",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const securityHeaders = (): Plugin => ({
  name: 'csp-meta',
  apply: 'build',
  transformIndexHtml(html) {
    return html.replace(
      '<meta name="referrer" content="no-referrer">',
      `<meta http-equiv="Content-Security-Policy" content="${CSP}">\n` +
      '<meta name="referrer" content="no-referrer">',
    );
  },
});

export default defineConfig({
  /**
   * Relative base so one build works on GitHub Pages whether it is served from
   * a project path (user.github.io/mushrooms/), a user site, or a custom
   * domain. Absolute paths 404 on a project page.
   */
  base: './',
  plugins: [securityHeaders()],
  build: {
    // species.json is ~870 KB of data; the size warning is expected
    chunkSizeWarningLimit: 1600,
    target: 'es2022',
  },
});
